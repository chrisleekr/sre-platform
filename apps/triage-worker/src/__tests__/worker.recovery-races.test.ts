import { randomUUID } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  applySignalObservation,
  applyTriageResult,
  createIncident,
  getIncident,
  jobs,
  recordSurfaceBinding,
  serializeSignalFence,
  surfaceDeliveries,
  upsertSurfaceConfig,
} from '@sre/db';
import type {
  RecoveryInput,
  ResumeInput,
  TriageEngine,
  TriageResult,
  TriageRuntime,
} from '../engine/types';
import { createFixture } from './worker.fixture';

const __fixture = createFixture();

async function clearedSignal(incidentId: string) {
  return applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    incidentId,
    surface: 'alertmanager',
    channel: 'checkout',
    externalMessageId: randomUUID(),
    state: 'resolved',
    summary: 'Checkout alert cleared.',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: new Date(),
  });
}

async function recoveredResult(incidentId: string, runtime: TriageRuntime): Promise<TriageResult> {
  const evidenceId = await runtime.ctx.audit.record({
    tenantId: __fixture.tenantId,
    incidentId,
    tool: 'query_metrics',
    input: { service: 'checkout' },
    output: { errorRate: 0.001 },
    latencyMs: 2,
    outcome: 'data',
  });
  return {
    provider: 'fake',
    sessionId: `fake:${incidentId}`,
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
}

describe('recovery lifecycle races', () => {
  test('reuses one pending run after active lifecycle drift and completes it on redelivery', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-active-race-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev2',
    });
    const cleared = await clearedSignal(incident.id);
    const verifyRecovery = vi.fn(
      async (_input: RecoveryInput, runtime: TriageRuntime): Promise<TriageResult> => {
        if (verifyRecovery.mock.calls.length === 1)
          await __fixture.hub.transitionIncident(__fixture.tenantId, incident.id, {
            to: 'mitigated',
            reason: 'Traffic shifted during recovery verification.',
            transitionKey: `mitigated:${incident.id}`,
            author: 'human',
            authorUserId: __fixture.actorUserId,
            expectedVersion: 0,
          });
        return recoveredResult(incident.id, runtime);
      },
    );
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      verifyRecovery,
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
    await __fixture.admin.db.insert(jobs).values({
      ...job,
      status: 'processing',
      stream: 'recovery-race-test',
    });
    const worker = __fixture.workerWithEngine(engine);

    await expect(worker.handle(job, { signal: new AbortController().signal })).rejects.toThrow(
      'recovery lifecycle changed; redelivering',
    );
    const [pending] = (await __fixture.admin.db.execute(sql`
      select id, outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId}
        and incident_id = ${incident.id}
        and operation = 'verify-recovery'
    `)) as unknown as Array<{ id: string; outcome: string | null; completedAt: Date | null }>;
    expect(pending).toMatchObject({ outcome: null, completedAt: null });
    const [retry] = await __fixture.admin.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.id, job.id));
    expect(retry?.payload).toMatchObject({ lifecycleVersion: 1 });

    await worker.handle(
      { ...job, attempts: 2, payload: retry!.payload },
      { signal: new AbortController().signal },
    );
    const runs = (await __fixture.admin.db.execute(sql`
      select id, outcome, completed_at as "completedAt"
      from investigation_runs
      where tenant_id = ${__fixture.tenantId}
        and incident_id = ${incident.id}
        and operation = 'verify-recovery'
    `)) as unknown as Array<{ id: string; outcome: string; completedAt: Date | string | null }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: pending!.id, outcome: 'conclusive' });
    expect(runs[0]!.completedAt).not.toBeNull();
    expect(verifyRecovery).toHaveBeenCalledTimes(2);
  });

  test('records a changed signal as one dashboard-only state-changed finding', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-signal-race-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, incident.id, {
      provider: 'fake',
      sessionId: `trusted:${incident.id}`,
      summary: 'The checkout rollout caused the error spike.',
      confidence: 82,
    });
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, { surface: 'slack' });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-RECOVERY-RACE',
      threadId: randomUUID(),
    });
    const cleared = await clearedSignal(incident.id);
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery(_input, runtime) {
        await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
          incidentId: incident.id,
          surface: 'alertmanager',
          channel: 'checkout',
          externalMessageId: cleared.signal.externalMessageId,
          state: 'firing',
          summary: 'Checkout alert refired.',
          contentHash: randomUUID(),
          eventKey: randomUUID(),
          eventAt: new Date(),
        });
        return recoveredResult(incident.id, runtime);
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
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident.id)).toMatchObject({
      status: 'open',
      investigationStatus: 'assessed',
      recoveryState: null,
    });
    const [run] = (await __fixture.admin.db.execute(sql`
      select id, outcome, result
      from investigation_runs
      where tenant_id = ${__fixture.tenantId}
        and incident_id = ${incident.id}
        and operation = 'verify-recovery'
    `)) as unknown as Array<{ id: string; outcome: string; result: Record<string, unknown> }>;
    expect(run).toMatchObject({ outcome: 'failed', result: { reason: 'state_changed' } });
    const finding = (await __fixture.hub.history(__fixture.tenantId, incident.id)).find(
      (message) => message.finding?.runId === run!.id,
    );
    expect(finding?.finding).toMatchObject({
      outcome: 'failed',
      promotion: 'not_promoted',
      promotionReason: 'state_changed',
    });
    expect(
      await __fixture.admin.db
        .select({ id: surfaceDeliveries.id })
        .from(surfaceDeliveries)
        .where(eq(surfaceDeliveries.messageId, finding!.id)),
    ).toEqual([]);
  });

  test('commits an interactive stale reply and resume watermark before a post-commit crash', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `interactive-recovery-crash-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev2',
    });
    const cleared = await clearedSignal(incident.id);
    const human = await __fixture.hub.append(__fixture.tenantId, incident.id, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      kind: 'text',
      content: 'Please verify whether checkout has recovered.',
      originSurface: 'slack',
    });
    const resume = vi.fn(async (_input: ResumeInput, runtime: TriageRuntime) => {
      await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
        incidentId: incident.id,
        surface: 'alertmanager',
        channel: 'checkout',
        externalMessageId: cleared.signal.externalMessageId,
        state: 'firing',
        summary: 'Checkout alert refired during verification.',
        contentHash: randomUUID(),
        eventKey: randomUUID(),
        eventAt: new Date(),
      });
      return recoveredResult(incident.id, runtime);
    });
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      resume,
      async verifyRecovery() {
        throw new Error('not used');
      },
    };
    const baseHub = __fixture.hub;
    let failAfterCommit = true;
    const crashingHub = new Proxy(baseHub, {
      get(target, property) {
        if (property === 'finalizeRecovery')
          return async (...args: Parameters<typeof target.finalizeRecovery>) => {
            const result = await target.finalizeRecovery(...args);
            if (failAfterCommit) {
              failAfterCommit = false;
              throw new Error('simulated crash after recovery commit');
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const crashingWorker = (() => {
      try {
        __fixture.hub = crashingHub;
        return __fixture.workerWithEngine(engine);
      } finally {
        __fixture.hub = baseHub;
      }
    })();
    const job = {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'resume',
      attempts: 1,
      payload: { incidentId: incident.id, humanMessageId: human.id },
    };

    await expect(
      crashingWorker.handle(job, { signal: new AbortController().signal }),
    ).rejects.toThrow('simulated crash after recovery commit');
    await __fixture
      .workerWithEngine(engine)
      .handle({ ...job, attempts: 2 }, { signal: new AbortController().signal });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident.id)).toMatchObject({
      lastResumeMessageId: human.id,
    });
    const runs = (await __fixture.admin.db.execute(sql`
      select id, outcome, result
      from investigation_runs
      where tenant_id = ${__fixture.tenantId}
        and incident_id = ${incident.id}
        and operation = 'resume'
    `)) as unknown as Array<{ id: string; outcome: string; result: Record<string, unknown> }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'failed', result: { reason: 'state_changed' } });
    const history = await __fixture.hub.history(__fixture.tenantId, incident.id);
    expect(history.filter((message) => message.finding?.runId === runs[0]!.id)).toHaveLength(1);
    expect(
      history.filter(
        (message) =>
          message.kind === 'reply' &&
          message.content.includes('provider state changed while I was checking recovery'),
      ),
    ).toHaveLength(1);
  });
});
