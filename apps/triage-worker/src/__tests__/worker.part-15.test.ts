import { randomUUID } from 'node:crypto';

import {
  applySignalObservation,
  createIncident,
  getIncident,
  recordToolCall,
  recordSurfaceBinding,
  serializeSignalFence,
  surfaceDeliveries,
  upsertSurfaceConfig,
} from '@sre/db';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';

import type { TriageEngine, TriageResult } from '../engine/types';
import { createFixture } from './worker.fixture';

const __fixture = createFixture();

function resultFor(
  incidentId: string,
  outcome: TriageResult['outcome'],
  over: Partial<TriageResult> = {},
): TriageResult {
  return {
    provider: 'fake',
    sessionId: `fake:${incidentId}`,
    model: 'fake-terminal',
    outcome,
    turnBudget: 1,
    evidenceReceipts: [],
    summary: 'Investigation did not produce a promotable assessment.',
    confidence: 0,
    rankedHypotheses: [],
    ...over,
  } as TriageResult;
}

function engineFor(result: TriageResult): TriageEngine {
  return {
    provider: 'fake',
    async investigate() {
      return result;
    },
    async resume() {
      return result;
    },
    async verifyRecovery() {
      return result;
    },
  };
}

async function latestRun(incidentId: string, operation?: string) {
  const operationFilter = operation ? sql`and operation = ${operation}` : sql``;
  const [run] = (await __fixture.admin.db.execute(sql`
    select id,
           provider,
           engine_model as "engineModel",
           engine_session_id as "engineSessionId",
           turn_budget as "turnBudget",
           operation,
           outcome,
           result,
           evidence_ids as "evidenceIds",
           completed_at as "completedAt"
    from investigation_runs
    where tenant_id = ${__fixture.tenantId}
      and incident_id = ${incidentId}
      ${operationFilter}
    order by started_at desc, id desc
    limit 1
  `)) as unknown as Array<{
    id: string;
    provider: string | null;
    engineModel: string | null;
    engineSessionId: string | null;
    turnBudget: number;
    operation: string;
    outcome: string | null;
    result: Record<string, unknown> | null;
    evidenceIds: string[];
    completedAt: Date | string | null;
  }>;
  return run;
}

async function createTrustedIncident(prefix: string) {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `${prefix}-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'checkout',
    severity: 'sev2',
  });
  const trusted = resultFor(incident.id, 'conclusive', {
    disposition: 'rca',
    summary: 'The checkout rollout exhausted the connection pool.',
    confidence: 86,
  });
  await __fixture.workerWithEngine(engineFor(trusted)).handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'triage',
      attempts: 1,
      payload: { incidentId: incident.id },
    },
    { signal: new AbortController().signal },
  );
  return {
    incident,
    trusted: (await getIncident(__fixture.app.db, __fixture.tenantId, incident.id))!,
  };
}

async function resolveSignal(incidentId: string, prefix: string) {
  return applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    incidentId,
    surface: 'alertmanager',
    channel: 'checkout',
    externalMessageId: `${prefix}-resolved-${incidentId}`,
    state: 'resolved',
    summary: 'Checkout error rate is below threshold.',
    contentHash: `${prefix}-hash-${incidentId}`,
    eventKey: `${prefix}-event-${incidentId}`,
    eventAt: new Date('2026-08-31T00:00:00.000Z'),
  });
}

describe('terminal run failure and recovery fences', () => {
  test('a provider failure after evidence preserves execution metadata and evidence provenance', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `failure-provenance-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, { surface: 'slack' });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-FAILURE',
      threadId: randomUUID(),
    });
    let evidenceId = '';
    const failAfterEvidence = async (
      _input: unknown,
      runtime: Parameters<TriageEngine['investigate']>[1],
    ): Promise<TriageResult> => {
      runtime.onExecutionMetadata?.({
        provider: 'claude',
        model: 'claude-test',
        sessionId: 'session-after-evidence',
        turnBudget: 7,
      });
      evidenceId = await runtime.ctx.audit.record({
        tenantId: __fixture.tenantId,
        incidentId: incident.id,
        tool: 'query_metrics',
        input: { service: 'checkout' },
        output: { errorRate: 0.42 },
        latencyMs: 4,
        outcome: 'data',
      });
      runtime.onEvidenceReceipt?.({
        evidenceId,
        tool: 'query_metrics',
        outcome: 'complete',
      });
      throw new Error('provider finalizer failed');
    };
    const engine: TriageEngine = {
      provider: 'fake',
      investigate: failAfterEvidence,
      resume: failAfterEvidence,
      verifyRecovery: failAfterEvidence,
    };

    await expect(
      __fixture.workerWithEngine(engine).handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'triage',
          attempts: 1,
          payload: { incidentId: incident.id },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('provider finalizer failed');

    const run = await latestRun(incident.id);
    expect(run).toMatchObject({
      provider: 'claude',
      engineModel: 'claude-test',
      engineSessionId: 'session-after-evidence',
      turnBudget: 7,
      operation: 'investigate',
      outcome: 'failed',
      evidenceIds: [evidenceId],
      completedAt: expect.anything(),
    });
    const finding = (await __fixture.hub.history(__fixture.tenantId, incident.id)).find(
      (message) => message.finding?.runId === run!.id,
    );
    expect(finding?.finding).toMatchObject({
      runId: run!.id,
      outcome: 'failed',
      promotion: 'not_promoted',
      promotionReason: 'investigation_failed',
      evidenceIds: [evidenceId],
    });
    expect(
      await __fixture.admin.db
        .select({ id: surfaceDeliveries.id })
        .from(surfaceDeliveries)
        .where(eq(surfaceDeliveries.messageId, finding!.id)),
    ).toHaveLength(1);
  });

  test('recovery cannot resolve from a conclusive claim that cites only unavailable evidence', async () => {
    const { incident, trusted } = await createTrustedIncident('recovery-unavailable');
    const observed = await resolveSignal(incident.id, 'unavailable');
    const evidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantId, {
      incidentId: incident.id,
      tool: 'query_metrics',
      input: { service: 'checkout' },
      latencyMs: 4,
      outcome: 'error',
    });
    const historyBefore = await __fixture.hub.history(__fixture.tenantId, incident.id);
    const rawResult = resultFor(incident.id, 'conclusive', {
      disposition: 'recovery',
      summary: 'Checkout recovered.',
      confidence: 90,
      evidenceReceipts: [{ evidenceId, tool: 'query_metrics', outcome: 'unavailable' }],
      recovery: {
        outcome: 'recovered',
        recovered: true,
        evidenceIds: [evidenceId],
        evidence: [{ name: 'Error rate', before: 'high', now: 'unknown' }],
        unknowns: [],
        nextStep: null,
      },
    });

    await __fixture.workerWithEngine(engineFor(rawResult)).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'recovery.verify',
        attempts: 1,
        payload: {
          incidentId: incident.id,
          lifecycleVersion: trusted.lifecycleVersion,
          signalFence: serializeSignalFence([observed.signal]),
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident.id)).toMatchObject({
      status: 'open',
      investigationStatus: 'assessed',
      recoveryState: null,
      recoveryRunId: null,
      trustedAssessmentRunId: trusted.trustedAssessmentRunId,
    });
    const history = await __fixture.hub.history(__fixture.tenantId, incident.id);
    expect(history).toHaveLength(historyBefore.length + 1);
    expect(history.at(-1)?.finding).toMatchObject({
      outcome: 'inconclusive',
      promotion: 'not_promoted',
      promotionReason: 'investigation_inconclusive',
    });
    expect(await latestRun(incident.id, 'verify-recovery')).toMatchObject({
      outcome: 'inconclusive',
      evidenceIds: [evidenceId],
      result: { recovery: expect.objectContaining({ evidenceIds: [] }) },
    });
  });

  test('triage, resume, and recovery setup failures each leave a terminal run', async () => {
    const unavailableConnectors = () => async () => {
      throw new Error('connector registry unavailable');
    };
    const badWorker = () =>
      __fixture.workerWithEngine(engineFor(resultFor(randomUUID(), 'inconclusive')), {
        connectorProvider: unavailableConnectors,
      });

    const triageIncident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `triage-setup-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    await expect(
      badWorker().handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'triage',
          attempts: 1,
          payload: { incidentId: triageIncident.id },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('connector registry unavailable');
    expect(await latestRun(triageIncident.id)).toMatchObject({
      operation: 'investigate',
      outcome: 'failed',
      completedAt: expect.anything(),
    });

    const { incident: resumeIncident, trusted: resumeTrusted } =
      await createTrustedIncident('resume-setup');
    const human = await __fixture.hub.append(__fixture.tenantId, resumeIncident.id, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      kind: 'text',
      content: 'Please recheck the current error rate.',
    });
    await expect(
      badWorker().handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'resume',
          attempts: 1,
          payload: { incidentId: resumeIncident.id, humanMessageId: human.id },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('connector registry unavailable');
    expect(await latestRun(resumeIncident.id)).toMatchObject({
      operation: 'resume',
      outcome: 'failed',
      completedAt: expect.anything(),
    });
    expect(
      await getIncident(__fixture.app.db, __fixture.tenantId, resumeIncident.id),
    ).toMatchObject({
      investigationStatus: 'assessed',
      trustedAssessmentRunId: resumeTrusted.trustedAssessmentRunId,
    });

    const { incident: recoveryIncident, trusted: recoveryTrusted } =
      await createTrustedIncident('recovery-setup');
    const resolved = await resolveSignal(recoveryIncident.id, 'setup');
    await expect(
      badWorker().handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'recovery.verify',
          attempts: 1,
          payload: {
            incidentId: recoveryIncident.id,
            lifecycleVersion: recoveryTrusted.lifecycleVersion,
            signalFence: serializeSignalFence([resolved.signal]),
          },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('connector registry unavailable');
    expect(await latestRun(recoveryIncident.id)).toMatchObject({
      operation: 'verify-recovery',
      outcome: 'failed',
      completedAt: expect.anything(),
    });
    expect(
      await getIncident(__fixture.app.db, __fixture.tenantId, recoveryIncident.id),
    ).toMatchObject({
      investigationStatus: 'assessed',
      recoveryState: null,
      recoveryRunId: null,
      trustedAssessmentRunId: recoveryTrusted.trustedAssessmentRunId,
    });
  }, 15_000);
});
