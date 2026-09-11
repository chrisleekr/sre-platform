import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  getIncident,
  recordSurfaceBinding,
  serializeSignalFence,
  surfaceDeliveries,
  upsertSurfaceConfig,
} from '@sre/db';
import type { TriageEngine, TriageResult } from '../engine/types';
import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('recovery run provenance', () => {
  test('commits one run-linked recovery finding and lifecycle transition across redelivery', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-provenance-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev2',
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      incidentId: incident.id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: randomUUID(),
      state: 'resolved',
      summary: 'Checkout alert cleared.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    let evidenceId = '';
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery(input, runtime): Promise<TriageResult> {
        evidenceId = await runtime.ctx.audit.record({
          tenantId: __fixture.tenantId,
          incidentId: incident.id,
          tool: 'query_metrics',
          input: { service: 'checkout' },
          output: { errorRate: 0.001 },
          latencyMs: 2,
          outcome: 'data',
        });
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake-recovery',
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          summary: 'Checkout telemetry is back to baseline.',
          confidence: 0,
          rankedHypotheses: [],
          evidenceReceipts: [{ evidenceId, tool: 'query_metrics', outcome: 'complete' }],
          recovery: {
            outcome: 'recovered',
            recovered: true,
            evidenceIds: [evidenceId],
            evidence: [{ name: 'Error rate', before: 'high', now: 'baseline' }],
            unknowns: [],
            nextStep: null,
          },
        };
      },
    };
    const job = {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'recovery.verify',
      attempts: 1,
      payload: {
        incidentId: incident.id,
        lifecycleVersion: 0,
        signalFence: serializeSignalFence([cleared.signal]),
      },
    };
    const worker = __fixture.workerWithEngine(engine);

    await worker.handle(job, { signal: new AbortController().signal });
    await worker.handle(job, { signal: new AbortController().signal });

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident.id)).toMatchObject({
      status: 'resolved',
      investigationStatus: 'assessed',
      recoveryState: 'verified',
    });
    const runs = (await __fixture.admin.db.execute(sql`
      select id, outcome, evidence_ids as "evidenceIds", completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId}
        and incident_id = ${incident.id}
        and operation = 'verify-recovery'
    `)) as unknown as Array<{
      id: string;
      outcome: string;
      evidenceIds: string[];
      completedAt: Date | string | null;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      outcome: 'conclusive',
      evidenceIds: [evidenceId],
      completedAt: expect.anything(),
    });
    const history = await __fixture.hub.history(__fixture.tenantId, incident.id);
    const findings = history.filter((message) => message.finding?.runId === runs[0]!.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'finding',
      finding: {
        promotion: 'conversation_only',
        promotionReason: 'terminal_incident',
        evidenceIds: [evidenceId],
      },
      recovery: { outcome: 'recovered' },
    });
    expect(history.filter((message) => message.kind === 'lifecycle')).toHaveLength(1);
  });

  test('deduplicates a committed nonconclusive recovery across job redelivery', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-inconclusive-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev2',
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      incidentId: incident.id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: randomUUID(),
      state: 'resolved',
      summary: 'Checkout alert cleared.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    let verifyCalls = 0;
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery(): Promise<TriageResult> {
        verifyCalls += 1;
        return {
          provider: 'fake',
          sessionId: `fake:${incident.id}`,
          outcome: 'inconclusive',
          turnBudget: 1,
          summary: 'Current recovery evidence is insufficient.',
          confidence: 0,
          rankedHypotheses: [],
          evidenceReceipts: [],
        };
      },
    };
    const job = {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'recovery.verify',
      attempts: 1,
      payload: {
        incidentId: incident.id,
        lifecycleVersion: 0,
        signalFence: serializeSignalFence([cleared.signal]),
      },
    };
    const worker = __fixture.workerWithEngine(engine);

    await worker.handle(job, { signal: new AbortController().signal });
    await worker.handle({ ...job, attempts: 2 }, { signal: new AbortController().signal });

    expect(verifyCalls).toBe(1);
    const runs = (await __fixture.admin.db.execute(sql`
      select id, outcome
      from investigation_runs
      where tenant_id = ${__fixture.tenantId}
        and incident_id = ${incident.id}
        and operation = 'verify-recovery'
    `)) as unknown as Array<{ id: string; outcome: string }>;
    expect(runs).toEqual([expect.objectContaining({ outcome: 'inconclusive' })]);
    const findings = (await __fixture.hub.history(__fixture.tenantId, incident.id)).filter(
      (message) => message.finding?.runId === runs[0]!.id,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.originMessageId).toBe(`recovery:${job.id}`);
  });

  test('keeps an automatic intermediate recovery check off Slack while retaining its finding', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-recheck-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev2',
    });
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, { surface: 'slack' });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-RECOVERY-RECHECK',
      threadId: randomUUID(),
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      incidentId: incident.id,
      surface: 'alertmanager',
      channel: 'checkout',
      externalMessageId: randomUUID(),
      state: 'resolved',
      summary: 'Checkout alert cleared.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    let evidenceId = '';
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery(input, runtime): Promise<TriageResult> {
        evidenceId = await runtime.ctx.audit.record({
          tenantId: __fixture.tenantId,
          incidentId: incident.id,
          tool: 'query_metrics',
          input: { service: 'checkout' },
          output: { errorRate: 0.02 },
          latencyMs: 2,
          outcome: 'data',
        });
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          summary: 'Checkout is improving but has not stabilized.',
          confidence: 0,
          rankedHypotheses: [],
          evidenceReceipts: [{ evidenceId, tool: 'query_metrics', outcome: 'complete' }],
          recovery: {
            outcome: 'recheck',
            recovered: false,
            evidenceIds: [evidenceId],
            evidence: [{ name: 'Error rate', before: 'high', now: 'improving' }],
            unknowns: [],
            nextStep: 'Recheck after the rollout converges.',
            recheckAfterMinutes: 5,
            scheduleReason: 'The rollout is still converging.',
          },
        };
      },
    };

    await __fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'recovery.verify',
        attempts: 1,
        payload: {
          incidentId: incident.id,
          lifecycleVersion: 0,
          signalFence: serializeSignalFence([cleared.signal]),
          attempt: 1,
          maxChecks: 3,
        },
      },
      { signal: new AbortController().signal },
    );

    const recheck = (await __fixture.hub.history(__fixture.tenantId, incident.id)).find(
      (message) => message.recovery?.outcome === 'recheck',
    );
    expect(recheck).toMatchObject({
      kind: 'status',
      finding: { promotionReason: 'terminal_incident', evidenceIds: [evidenceId] },
    });
    expect(
      await __fixture.admin.db
        .select({ id: surfaceDeliveries.id })
        .from(surfaceDeliveries)
        .where(eq(surfaceDeliveries.messageId, recheck!.id)),
    ).toEqual([]);
  });
});
