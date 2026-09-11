import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  listCausalCandidatesTx,
  listIncidentRelations,
  listResponseGroupIncidentIds,
  makeDb,
  prepareResponseGroupRecoveryTx,
  promoteCausalFindingsTx,
  recordAgentCohortRelationTx,
  recordIncidentRelation,
  recordUnrelatedIncidents,
  setIncidentArchivedTx,
  withTenant,
  type DbHandle,
} from '../index';
import {
  agentToolCalls,
  incidentRelations,
  incidentSignals,
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
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Causal relation tenant' });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentRelations).where(eq(incidentRelations.tenantId, tenantId));
    await admin.db.delete(investigationRuns).where(eq(investigationRuns.tenantId, tenantId));
    await admin.db.delete(agentToolCalls).where(eq(agentToolCalls.tenantId, tenantId));
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
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

async function evidenceRun(incidentId: string): Promise<{ evidenceId: string; runId: string }> {
  return withTenant(app.db, tenantId, async (tx) => {
    const [evidence] = await tx
      .insert(agentToolCalls)
      .values({
        tenantId,
        incidentId,
        tool: 'prometheus_test_query',
        input: {},
        output: { aligned: true },
        latencyMs: 1,
        outcome: 'data',
      })
      .returning({ id: agentToolCalls.id });
    const [run] = await tx
      .insert(investigationRuns)
      .values({
        tenantId,
        incidentId,
        operation: 'investigate',
        outcome: 'conclusive',
        result: { summary: 'cause established' },
        evidenceIds: [evidence!.id],
        completedAt: new Date(),
      })
      .returning({ id: investigationRuns.id });
    return { evidenceId: evidence!.id, runId: run!.id };
  });
}

async function candidateSnapshot(incidentId: string) {
  return withTenant(app.db, tenantId, (tx) => listCausalCandidatesTx(tx, incidentId));
}

async function resolvedSignal(incidentId: string, suffix: string): Promise<void> {
  await applySignalObservation(app.db, tenantId, {
    incidentId,
    surface: 'slack',
    channel: 'C-CAUSE',
    externalMessageId: suffix,
    state: 'resolved',
    summary: suffix,
    contentHash: suffix,
    eventKey: `${suffix}:resolved`,
    eventAt: new Date(),
  });
}

async function firingSignal(incidentId: string, suffix: string): Promise<string> {
  return (
    await applySignalObservation(app.db, tenantId, {
      incidentId,
      surface: 'slack',
      channel: 'C-CAUSE',
      externalMessageId: suffix,
      state: 'firing',
      summary: suffix,
      contentHash: suffix,
      eventKey: `${suffix}:firing`,
      eventAt: new Date(),
    })
  ).signal.id;
}

test('promotes a cited directional cause without moving either incident workspace', async () => {
  const rootId = await incident('Database saturation');
  const symptomId = await incident('Checkout errors');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: symptomId,
    targetIncidentId: rootId,
    type: 'possible_related',
    rationale: 'Same bounded alert cohort.',
    evidence: ['cohort:test'],
    decidedBy: 'agent',
  });
  const run = await evidenceRun(symptomId);
  const candidates = await candidateSnapshot(symptomId);

  const promoted = await withTenant(app.db, tenantId, (tx) =>
    promoteCausalFindingsTx(
      tx,
      tenantId,
      symptomId,
      run.runId,
      [
        {
          candidateRef: 1,
          direction: 'candidate_caused_this',
          rationale: 'Database saturation caused the checkout errors.',
          confidence: 94,
          evidenceIds: [run.evidenceId],
        },
      ],
      [run.evidenceId],
      candidates,
    ),
  );

  expect(promoted).toEqual([
    expect.objectContaining({
      sourceIncidentId: symptomId,
      targetIncidentId: rootId,
      type: 'caused_by',
      confidence: 94,
      decisionRunId: run.runId,
      evidenceIds: [run.evidenceId],
    }),
  ]);
  expect(await listResponseGroupIncidentIds(app.db, tenantId, symptomId)).toEqual([
    rootId,
    symptomId,
  ]);
  expect(await listIncidentRelations(app.db, tenantId, symptomId)).toEqual([
    expect.objectContaining({ type: 'caused_by' }),
  ]);

  await resolvedSignal(rootId, `root-${randomUUID()}`);
  await resolvedSignal(symptomId, `symptom-${randomUUID()}`);
  const recovery = await withTenant(app.db, tenantId, (tx) =>
    prepareResponseGroupRecoveryTx(tx, tenantId, symptomId),
  );
  expect(recovery).toMatchObject({ rootIncidentId: rootId });
  expect(recovery?.signalFence.split('|')).toHaveLength(2);
});

test('does not let a later model cohort decision weaken a causal or human decision', async () => {
  const causalRootId = await incident('Protected causal root');
  const causalChildId = await incident('Protected causal child');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: causalChildId,
    targetIncidentId: causalRootId,
    type: 'caused_by',
    rationale: 'Responder-confirmed causal direction.',
    evidence: ['responder:causal-confirmation'],
    decidedBy: 'human',
    decidedByUserId: randomUUID(),
  });
  const separateFirstId = await incident('Protected separate first');
  const separateSecondId = await incident('Protected separate second');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: separateFirstId,
    targetIncidentId: separateSecondId,
    type: 'unrelated',
    rationale: 'Responder confirmed different causes.',
    evidence: ['responder:separate-confirmation'],
    decidedBy: 'human',
    decidedByUserId: randomUUID(),
  });

  const [causalAttempt, separateAttempt] = await withTenant(app.db, tenantId, async (tx) =>
    Promise.all([
      recordAgentCohortRelationTx(tx, tenantId, {
        sourceIncidentId: causalChildId,
        targetIncidentId: causalRootId,
        type: 'possible_related',
        rationale: 'A later cohort happened to contain the same pair.',
        evidence: ['cohort:later'],
      }),
      recordAgentCohortRelationTx(tx, tenantId, {
        sourceIncidentId: separateFirstId,
        targetIncidentId: separateSecondId,
        type: 'possible_related',
        rationale: 'A later cohort happened to contain the same pair.',
        evidence: ['cohort:later'],
      }),
    ]),
  );

  expect(causalAttempt).toBeNull();
  expect(separateAttempt).toBeNull();
  expect(await listIncidentRelations(app.db, tenantId, causalChildId)).toEqual([
    expect.objectContaining({ type: 'caused_by', decidedBy: 'human' }),
  ]);
  expect(await listIncidentRelations(app.db, tenantId, separateFirstId)).toEqual([
    expect.objectContaining({ type: 'unrelated', decidedBy: 'human' }),
  ]);
});

test('does not persist a cohort decision after either endpoint is archived', async () => {
  const visibleId = await incident('Visible cohort endpoint');
  const archivedId = await incident('Archived cohort endpoint');
  await withTenant(app.db, tenantId, async (tx) => {
    await tx
      .update(incidents)
      .set({ status: 'closed', lifecycleVersion: 1, closedAt: new Date() })
      .where(eq(incidents.id, archivedId));
    await setIncidentArchivedTx(tx, archivedId, true, {
      expectedVersion: 1,
      allowActiveSignalsForClosed: true,
    });
  });

  await expect(
    withTenant(app.db, tenantId, (tx) =>
      recordAgentCohortRelationTx(tx, tenantId, {
        sourceIncidentId: visibleId,
        targetIncidentId: archivedId,
        type: 'possible_related',
        rationale: 'A stale model result arrived after archival.',
        evidence: ['cohort:stale-archived-endpoint'],
      }),
    ),
  ).resolves.toBeNull();
  expect(await listIncidentRelations(app.db, tenantId, visibleId)).toEqual([]);
});

test('rejects an evidence-backed edge that would make a causal cycle', async () => {
  const first = await incident('First');
  const second = await incident('Second');
  const third = await incident('Third');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: first,
    targetIncidentId: second,
    type: 'caused_by',
    rationale: 'First is a symptom of second.',
    evidence: ['human:one'],
    decidedBy: 'human',
  });
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: second,
    targetIncidentId: third,
    type: 'caused_by',
    rationale: 'Second is a symptom of third.',
    evidence: ['human:two'],
    decidedBy: 'human',
  });
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: third,
    targetIncidentId: first,
    type: 'possible_related',
    rationale: 'Candidate relation for cycle guard.',
    evidence: ['cohort:cycle'],
    decidedBy: 'agent',
  });
  const run = await evidenceRun(third);
  const candidates = await candidateSnapshot(third);

  const promoted = await withTenant(app.db, tenantId, (tx) =>
    promoteCausalFindingsTx(
      tx,
      tenantId,
      third,
      run.runId,
      [
        {
          candidateRef: 1,
          direction: 'candidate_caused_this',
          rationale: 'This would complete a cycle.',
          confidence: 99,
          evidenceIds: [run.evidenceId],
        },
      ],
      [run.evidenceId],
      candidates,
    ),
  );

  expect(promoted).toEqual([]);
  expect((await listIncidentRelations(app.db, tenantId, third)).map((row) => row.type)).toContain(
    'possible_related',
  );
});

test('selects the highest-confidence cause when one symptom has multiple candidates', async () => {
  const symptomId = await incident('Multi-candidate symptom');
  const weakerId = await incident('Weaker candidate');
  const strongerId = await incident('Stronger candidate');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: symptomId,
    targetIncidentId: weakerId,
    type: 'possible_related',
    rationale: 'First candidate.',
    evidence: ['cohort:multi-candidate'],
    decidedBy: 'agent',
  });
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: symptomId,
    targetIncidentId: strongerId,
    type: 'possible_related',
    rationale: 'Second candidate.',
    evidence: ['cohort:multi-candidate'],
    decidedBy: 'agent',
  });
  const run = await evidenceRun(symptomId);
  const candidates = await candidateSnapshot(symptomId);

  const promoted = await withTenant(app.db, tenantId, (tx) =>
    promoteCausalFindingsTx(
      tx,
      tenantId,
      symptomId,
      run.runId,
      [
        {
          candidateRef: 1,
          direction: 'candidate_caused_this',
          rationale: 'The weaker candidate is plausible.',
          confidence: 82,
          evidenceIds: [run.evidenceId],
        },
        {
          candidateRef: 2,
          direction: 'candidate_caused_this',
          rationale: 'The stronger candidate explains the symptom.',
          confidence: 96,
          evidenceIds: [run.evidenceId],
        },
      ],
      [run.evidenceId],
      candidates,
    ),
  );

  expect(promoted).toEqual([
    expect.objectContaining({
      sourceIncidentId: symptomId,
      targetIncidentId: strongerId,
      confidence: 96,
    }),
  ]);
});

test('schedules one complete-group recovery candidate when child signals resolve concurrently', async () => {
  const rootId = await incident('Concurrent recovery root');
  const childId = await incident('Concurrent recovery child');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: childId,
    targetIncidentId: rootId,
    type: 'caused_by',
    rationale: 'The child is a verified symptom of the root.',
    evidence: ['human:concurrent-recovery'],
    decidedBy: 'human',
  });
  const [rootSignalId, childSignalId] = await Promise.all([
    firingSignal(rootId, `root-firing-${randomUUID()}`),
    firingSignal(childId, `child-firing-${randomUUID()}`),
  ]);
  let ready = 0;
  let release!: () => void;
  const bothUpdated = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resolveAndPrepare = (incidentId: string, signalId: string) =>
    withTenant(app.db, tenantId, async (tx) => {
      await tx
        .update(incidentSignals)
        .set({ state: 'resolved' })
        .where(eq(incidentSignals.id, signalId));
      ready += 1;
      if (ready === 2) release();
      await bothUpdated;
      return prepareResponseGroupRecoveryTx(tx, tenantId, incidentId);
    });

  const candidates = await Promise.all([
    resolveAndPrepare(rootId, rootSignalId),
    resolveAndPrepare(childId, childSignalId),
  ]);

  expect(candidates.filter(Boolean)).toEqual([expect.objectContaining({ rootIncidentId: rootId })]);
  expect(candidates.find(Boolean)?.signalFence.split('|')).toHaveLength(2);
});

test('causal rejection produces independent recovery candidates for both cleared incidents', async () => {
  const rootId = await incident('Correction recovery root');
  const childId = await incident('Correction recovery child');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: childId,
    targetIncidentId: rootId,
    type: 'caused_by',
    rationale: 'The child initially belonged to the root response.',
    evidence: ['human:initial-cause'],
    decidedBy: 'human',
    decidedByUserId: randomUUID(),
  });
  await Promise.all([
    resolvedSignal(rootId, `correction-root-${randomUUID()}`),
    resolvedSignal(childId, `correction-child-${randomUUID()}`),
  ]);

  await recordUnrelatedIncidents(app.db, tenantId, {
    sourceIncidentId: childId,
    targetIncidentId: rootId,
    rationale: 'Current evidence shows independent causes.',
    evidence: ['human:causal-rejection'],
    decidedByUserId: randomUUID(),
  });
  const recovery = await withTenant(app.db, tenantId, async (tx) =>
    Promise.all([
      prepareResponseGroupRecoveryTx(tx, tenantId, rootId),
      prepareResponseGroupRecoveryTx(tx, tenantId, childId),
    ]),
  );

  expect(recovery).toEqual([
    expect.objectContaining({ rootIncidentId: rootId }),
    expect.objectContaining({ rootIncidentId: childId }),
  ]);
});

test('archiving a causal member removes it from live response ownership', async () => {
  const rootId = await incident('Archived response root');
  const childId = await incident('Surviving response child');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: childId,
    targetIncidentId: rootId,
    type: 'caused_by',
    rationale: 'Root owns the response before archival.',
    evidence: ['human:archive-test'],
    decidedBy: 'human',
    decidedByUserId: randomUUID(),
  });
  await withTenant(app.db, tenantId, async (tx) => {
    await tx
      .update(incidents)
      .set({ status: 'closed', lifecycleVersion: 1, closedAt: new Date() })
      .where(eq(incidents.id, rootId));
    expect(
      await setIncidentArchivedTx(tx, rootId, true, {
        expectedVersion: 1,
        allowActiveSignalsForClosed: true,
      }),
    ).toMatchObject({ outcome: 'applied' });
  });

  expect(await listResponseGroupIncidentIds(app.db, tenantId, childId)).toEqual([childId]);
  expect(await listIncidentRelations(app.db, tenantId, childId)).toEqual([]);
  const archivedEdges = await admin.db
    .select({ supersededAt: incidentRelations.supersededAt })
    .from(incidentRelations)
    .where(eq(incidentRelations.sourceIncidentId, childId));
  expect(archivedEdges).toEqual([expect.objectContaining({ supersededAt: expect.any(Date) })]);

  const replacementRootId = await incident('Replacement response root');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: childId,
    targetIncidentId: replacementRootId,
    type: 'possible_related',
    rationale: 'Replacement candidate after the old root was archived.',
    evidence: ['cohort:replacement-root'],
    decidedBy: 'agent',
  });
  const run = await evidenceRun(childId);
  const candidates = await candidateSnapshot(childId);
  const promoted = await withTenant(app.db, tenantId, (tx) =>
    promoteCausalFindingsTx(
      tx,
      tenantId,
      childId,
      run.runId,
      [
        {
          candidateRef: 1,
          direction: 'candidate_caused_this',
          rationale: 'The replacement root now owns the surviving symptom.',
          confidence: 95,
          evidenceIds: [run.evidenceId],
        },
      ],
      [run.evidenceId],
      candidates,
    ),
  );
  expect(promoted).toEqual([
    expect.objectContaining({ targetIncidentId: replacementRootId, type: 'caused_by' }),
  ]);
});
