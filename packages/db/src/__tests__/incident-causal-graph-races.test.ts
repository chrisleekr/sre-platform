import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createIncident,
  listCausalCandidatesTx,
  listIncidentRelations,
  listResponseGroupIncidentIds,
  makeDb,
  promoteCausalFindingsTx,
  recordIncidentRelation,
  withTenant,
  type DbHandle,
} from '../index';
import {
  agentToolCalls,
  incidentRelations,
  incidents,
  investigationRuns,
  tenants,
} from '../schema';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Causal graph race tenant' });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentRelations).where(eq(incidentRelations.tenantId, tenantId));
    await admin.db.delete(investigationRuns).where(eq(investigationRuns.tenantId, tenantId));
    await admin.db.delete(agentToolCalls).where(eq(agentToolCalls.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

async function incident(title: string): Promise<string> {
  return (
    await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: title.toLowerCase(),
      severity: 'sev2',
      title,
      investigationStatus: 'assessed',
    })
  ).id;
}

async function evidenceRun(incidentId: string) {
  return withTenant(app.db, tenantId, async (tx) => {
    const [evidence] = await tx
      .insert(agentToolCalls)
      .values({
        tenantId,
        incidentId,
        tool: 'prometheus_query',
        input: {},
        latencyMs: 1,
        outcome: 'ok',
        output: { value: 1 },
      })
      .returning({ id: agentToolCalls.id });
    const [run] = await tx
      .insert(investigationRuns)
      .values({
        tenantId,
        incidentId,
        operation: 'reassess',
        outcome: 'conclusive',
        result: { summary: 'Causal graph evidence' },
        evidenceIds: [evidence!.id],
        completedAt: new Date(),
      })
      .returning({ id: investigationRuns.id });
    return { evidenceId: evidence!.id, runId: run!.id };
  });
}

async function candidates(incidentId: string) {
  return withTenant(app.db, tenantId, (tx) => listCausalCandidatesTx(tx, incidentId));
}

test('keeps candidate ordinals bound to the exact prompt-time relation', async () => {
  const current = await incident('Current symptom');
  const first = await incident('First candidate');
  const second = await incident('Second candidate');
  const third = await incident('Third candidate');
  for (const targetIncidentId of [first, second, third])
    await recordIncidentRelation(app.db, tenantId, {
      sourceIncidentId: current,
      targetIncidentId,
      type: 'possible_related',
      rationale: 'Bounded cohort candidate.',
      evidence: ['cohort:ordinal'],
      decidedBy: 'agent',
    });
  const snapshot = await candidates(current);
  expect(snapshot.map((candidate) => candidate.incidentId)).toEqual([first, second, third]);

  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: current,
    targetIncidentId: first,
    type: 'unrelated',
    rationale: 'The first candidate was ruled out while the model was running.',
    evidence: ['responder:ruled-out'],
    decidedBy: 'human',
    decidedByUserId: randomUUID(),
  });
  const run = await evidenceRun(current);
  const promoted = await withTenant(app.db, tenantId, (tx) =>
    promoteCausalFindingsTx(
      tx,
      tenantId,
      current,
      run.runId,
      [
        {
          candidateRef: 2,
          direction: 'candidate_caused_this',
          rationale: 'The second candidate caused the current symptom.',
          confidence: 95,
          evidenceIds: [run.evidenceId],
        },
      ],
      [run.evidenceId],
      snapshot,
    ),
  );

  expect(promoted).toEqual([
    expect.objectContaining({ sourceIncidentId: current, targetIncidentId: second }),
  ]);
});

test('requires a conclusive same-incident run and its current evidence for promotion', async () => {
  const rootId = await incident('Evidence policy root');
  const symptomId = await incident('Evidence policy symptom');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: symptomId,
    targetIncidentId: rootId,
    type: 'possible_related',
    rationale: 'Candidate relation for evidence policy.',
    evidence: ['cohort:evidence-policy'],
    decidedBy: 'agent',
  });
  const symptomRun = await evidenceRun(symptomId);
  const foreignRun = await evidenceRun(rootId);
  const [pendingRun, failedRun] = await withTenant(app.db, tenantId, (tx) =>
    tx
      .insert(investigationRuns)
      .values([
        {
          tenantId,
          incidentId: symptomId,
          operation: 'reassess' as const,
          evidenceIds: [symptomRun.evidenceId],
        },
        {
          tenantId,
          incidentId: symptomId,
          operation: 'reassess' as const,
          outcome: 'failed' as const,
          result: { summary: 'No causal conclusion.' },
          evidenceIds: [symptomRun.evidenceId],
          completedAt: new Date(),
        },
      ])
      .returning({ id: investigationRuns.id }),
  );
  const snapshot = await candidates(symptomId);
  const attempts = await withTenant(app.db, tenantId, async (tx) => {
    const attempt = (runId: string, evidenceId: string, confidence = 95) =>
      promoteCausalFindingsTx(
        tx,
        tenantId,
        symptomId,
        runId,
        [
          {
            candidateRef: 1,
            direction: 'candidate_caused_this',
            rationale: 'Only a conclusive, owned run may establish this cause.',
            confidence,
            evidenceIds: [evidenceId],
          },
        ],
        [evidenceId],
        snapshot,
      );
    return {
      lowConfidence: await attempt(symptomRun.runId, symptomRun.evidenceId, 79),
      foreignEvidence: await attempt(symptomRun.runId, foreignRun.evidenceId),
      pendingRun: await attempt(pendingRun!.id, symptomRun.evidenceId),
      failedRun: await attempt(failedRun!.id, symptomRun.evidenceId),
      foreignRunOwner: await attempt(foreignRun.runId, symptomRun.evidenceId),
    };
  });

  expect(attempts).toEqual({
    lowConfidence: [],
    foreignEvidence: [],
    pendingRun: [],
    failedRun: [],
    foreignRunOwner: [],
  });
  expect(await listIncidentRelations(app.db, tenantId, symptomId)).toEqual([
    expect.objectContaining({ type: 'possible_related' }),
  ]);
});

test('serializes disjoint promotions that would jointly create a causal cycle', async () => {
  const first = await incident('Cycle first');
  const second = await incident('Cycle second');
  const third = await incident('Cycle third');
  const fourth = await incident('Cycle fourth');
  for (const [sourceIncidentId, targetIncidentId] of [
    [first, second],
    [third, fourth],
  ] as const)
    await recordIncidentRelation(app.db, tenantId, {
      sourceIncidentId,
      targetIncidentId,
      type: 'caused_by',
      rationale: 'Existing causal chain.',
      evidence: ['responder:existing-chain'],
      decidedBy: 'human',
      decidedByUserId: randomUUID(),
    });
  for (const [sourceIncidentId, targetIncidentId] of [
    [second, third],
    [fourth, first],
  ] as const)
    await recordIncidentRelation(app.db, tenantId, {
      sourceIncidentId,
      targetIncidentId,
      type: 'possible_related',
      rationale: 'Concurrent cross-chain candidate.',
      evidence: ['cohort:cross-chain'],
      decidedBy: 'agent',
    });
  const [secondRun, fourthRun, secondCandidates, fourthCandidates] = await Promise.all([
    evidenceRun(second),
    evidenceRun(fourth),
    candidates(second),
    candidates(fourth),
  ]);

  const [secondResult, fourthResult] = await Promise.all([
    withTenant(app.db, tenantId, (tx) =>
      promoteCausalFindingsTx(
        tx,
        tenantId,
        second,
        secondRun.runId,
        [
          {
            candidateRef: 1,
            direction: 'candidate_caused_this',
            rationale: 'Second is a symptom of third.',
            confidence: 95,
            evidenceIds: [secondRun.evidenceId],
          },
        ],
        [secondRun.evidenceId],
        secondCandidates,
      ),
    ),
    withTenant(app.db, tenantId, (tx) =>
      promoteCausalFindingsTx(
        tx,
        tenantId,
        fourth,
        fourthRun.runId,
        [
          {
            candidateRef: 1,
            direction: 'candidate_caused_this',
            rationale: 'Fourth is a symptom of first.',
            confidence: 95,
            evidenceIds: [fourthRun.evidenceId],
          },
        ],
        [fourthRun.evidenceId],
        fourthCandidates,
      ),
    ),
  ]);

  expect(secondResult.length + fourthResult.length).toBe(1);
  expect(await listResponseGroupIncidentIds(app.db, tenantId, first)).toHaveLength(4);
});
