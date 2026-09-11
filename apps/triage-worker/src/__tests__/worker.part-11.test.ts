import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { Redis } from 'ioredis';

import {
  applySignalObservation,
  applyTriageResult,
  createIncident,
  getIncident,
  incidentSignals,
  jobs,
  recordSurfaceBinding,
  serializeSignalFence,
  surfaceDeliveries,
  upsertSurfaceConfig,
} from '@sre/db';

import { type Job } from '@sre/queue';

import { ConversationHub, SURFACE_STREAM } from '@sre/hub';

import { ProviderUnavailableError, type TriageEngine, type TriageRuntime } from '../engine/types';

import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('signal-driven recovery and explicit lifecycle commands', () => {
  const signal = (
    id: string,
    over: Partial<Parameters<typeof applySignalObservation>[2]> = {},
  ) => ({
    incidentId: id,
    surface: 'slack',
    channel: 'C-lifecycle',
    externalMessageId: `signal-${id}`,
    state: 'firing' as const,
    summary: 'Checkout errors are firing',
    contentHash: 'firing-hash',
    eventKey: `firing-${id}`,
    eventAt: new Date('2026-08-21T02:00:00.000Z'),
    ...over,
  });

  const recoveryEvidence = (incidentId: string, runtime: TriageRuntime) =>
    runtime.ctx.audit.record({
      tenantId: __fixture.tenantId,
      incidentId,
      tool: 'prometheus_query_range',
      input: { query: 'rate(errors_total[5m])' },
      output: { data: { resultType: 'matrix', result: [] } },
      latencyMs: 1,
      outcome: 'data',
    });

  test('a redelivered recovery outage records one brief without demoting the trusted assessment', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-degraded-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'The checkout database pool saturated.',
      confidence: 75,
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: 'recovery-degraded-cleared',
      eventKey: `recovery-degraded-cleared:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const jobId = randomUUID();
    const payload = {
      incidentId: id,
      lifecycleVersion: 0,
      signalFence: serializeSignalFence([cleared.signal]),
    };
    await __fixture.admin.db.insert(jobs).values({
      id: jobId,
      tenantId: __fixture.tenantId,
      type: 'recovery.verify',
      payload,
      status: 'processing',
      stream: 'sre:jobs',
    });
    const outageWorker = __fixture.workerWithEngine({
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery() {
        throw new ProviderUnavailableError('provider unavailable');
      },
    });
    const job: Job = {
      id: jobId,
      tenantId: __fixture.tenantId,
      type: 'recovery.verify',
      payload,
      attempts: 1,
    };

    await expect(
      outageWorker.handle(job, { signal: new AbortController().signal }),
    ).rejects.toThrow('triage provider unavailable; redelivering');
    await expect(
      outageWorker.handle({ ...job, attempts: 2 }, { signal: new AbortController().signal }),
    ).rejects.toThrow('triage provider unavailable; redelivering');

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'open',
      investigationStatus: 'assessed',
      rcaSummary: 'The checkout database pool saturated.',
    });
    const history = await __fixture.hub.history(__fixture.tenantId, id);
    expect(history.filter((message) => message.content.includes('evidence brief'))).toHaveLength(1);
    expect(history.filter((message) => message.content.includes('Escalated'))).toHaveLength(1);
  });

  test('post-commit delivery loss preserves recovery without rerunning the engine', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-publish-retry-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'The checkout pool was saturated.',
      confidence: 70,
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      materialHash: 'recovery-publish-retry-material',
      contentHash: 'publish-retry-clear',
      eventKey: `publish-retry-clear:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, { surface: 'slack' });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-RECOVERY-STATUS',
      threadId: randomUUID(),
    });
    const stepContent = `Checked the current checkout error rate ${id}.`;
    const verify = vi.fn(async (_input: unknown, runtime: TriageRuntime) => {
      await runtime.onStep('tool_step', stepContent);
      const evidenceId = await recoveryEvidence(id, runtime);
      return {
        provider: 'fake' as const,
        sessionId: `fake:${id}`,
        outcome: 'conclusive' as const,
        turnBudget: 1,
        disposition: 'recovery' as const,
        summary: 'The checkout error rate returned to baseline.',
        confidence: 0,
        evidenceReceipts: [
          { evidenceId, tool: 'prometheus_query_range', outcome: 'complete' as const },
        ],
        recovery: {
          recovered: true,
          evidence: [__fixture.recoveryCheck('The current error rate is below the threshold.')],
          evidenceIds: [evidenceId],
          unknowns: [],
          nextStep: null,
        },
      };
    });
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      verifyRecovery: verify,
    };
    const job = {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'recovery.verify',
      attempts: 1,
      payload: {
        incidentId: id,
        lifecycleVersion: 0,
        signalFence: serializeSignalFence([cleared.signal]),
      },
    };
    const failedPublishRedis = {
      publish: vi.fn(async () => {
        throw new Error('simulated post-commit publish failure');
      }),
      xadd: vi.fn(async () => 'must-not-run'),
    } as unknown as Redis;
    const primaryHub = __fixture.hub;
    __fixture.hub = new ConversationHub(__fixture.app.db, __fixture.redis, failedPublishRedis);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const recoveryWorker = __fixture.workerWithEngine(engine);
      await expect(
        recoveryWorker.handle(job, { signal: new AbortController().signal }),
      ).resolves.toBeUndefined();
      expect(
        await __fixture.admin.db
          .select({ lastInvestigatedMaterialHash: incidentSignals.lastInvestigatedMaterialHash })
          .from(incidentSignals)
          .where(eq(incidentSignals.id, cleared.signal.id)),
      ).toEqual([{ lastInvestigatedMaterialHash: 'recovery-publish-retry-material' }]);

      expect(verify).toHaveBeenCalledTimes(1);
      const history = await __fixture.hub.history(__fixture.tenantId, id);
      expect(history.filter((message) => message.content === stepContent)).toEqual([
        expect.objectContaining({ kind: 'status' }),
      ]);
      const statusMessage = history.find((message) => message.content === stepContent)!;
      expect(
        await __fixture.admin.db
          .select({ id: surfaceDeliveries.id })
          .from(surfaceDeliveries)
          .where(eq(surfaceDeliveries.messageId, statusMessage.id)),
      ).toEqual([]);
      const surfaceEntries = await __fixture.redis.xrange(SURFACE_STREAM, '-', '+');
      expect(
        surfaceEntries.some(([, fields]) => {
          const msgIndex = fields.indexOf('msg');
          return msgIndex >= 0 && fields[msgIndex + 1]?.includes(stepContent);
        }),
      ).toBe(false);
      expect(history.filter((message) => message.content.startsWith('RECOVERED'))).toHaveLength(1);
      expect(failedPublishRedis.publish).toHaveBeenCalledTimes(3);
      expect(failedPublishRedis.xadd).not.toHaveBeenCalled();
      expect(
        await __fixture.admin.db
          .select({ id: surfaceDeliveries.id })
          .from(surfaceDeliveries)
          .where(eq(surfaceDeliveries.incidentId, id)),
      ).toHaveLength(2);
      expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
        status: 'resolved',
      });
    } finally {
      warn.mockRestore();
      __fixture.hub = primaryHub;
    }
  });

  test('an inconclusive recovery check records unknowns without changing lifecycle or RCA', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-inconclusive-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'The database pool saturated.',
      confidence: 72,
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: 'inconclusive-cleared',
      eventKey: `inconclusive-cleared:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery(input) {
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          summary: 'Recovery is not yet proven.',
          confidence: 0,
          recovery: {
            recovered: false,
            evidence: [
              __fixture.recoveryCheck('Health endpoint responds; saturation is unavailable.'),
            ],
            unknowns: ['The current saturation metric is unavailable.'],
            nextStep: 'Check database pool saturation again in five minutes.',
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
          incidentId: id,
          lifecycleVersion: 0,
          signalFence: serializeSignalFence([cleared.signal]),
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'open',
      lifecycleVersion: 0,
      rcaSummary: 'The database pool saturated.',
      investigationStatus: 'assessed',
      recoveryState: 'not_verified',
      recoverySummary: 'Recovery is not yet proven.',
      recoveryUpdatedAt: expect.any(Date),
    });
    const findings = (await __fixture.hub.history(__fixture.tenantId, id)).filter(
      (message) => message.kind === 'finding',
    );
    expect(findings.at(-1)?.content).toContain('The current saturation metric is unavailable.');
    expect(findings.at(-1)?.content).toContain(
      'Health endpoint responds; saturation is unavailable.',
    );
    expect(findings.at(-1)?.content).toContain(
      'Check database pool saturation again in five minutes.',
    );
    expect(
      (await __fixture.hub.history(__fixture.tenantId, id)).some(
        (message) => message.kind === 'lifecycle',
      ),
    ).toBe(false);
  });

  test('a recovery job whose complete signal fence is stale does no work', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-stale-before-start-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'The checkout pool saturated.',
      confidence: 70,
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, signal(id));
    const secondSignal = signal(id, {
      externalMessageId: `signal-b-${id}`,
      contentHash: 'second-open',
      eventKey: `second-open:${id}`,
      eventAt: new Date('2026-08-21T02:00:30.000Z'),
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, secondSignal);
    const firstClear = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: 'first-clear',
      eventKey: `first-clear:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const secondClear = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...secondSignal,
      state: 'resolved',
      contentHash: 'second-clear',
      eventKey: `second-clear:${id}`,
      eventAt: new Date('2026-08-21T02:01:30.000Z'),
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      contentHash: 'refire-before-old-job',
      eventKey: `refire-before-old-job:${id}`,
      eventAt: new Date('2026-08-21T02:02:00.000Z'),
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: 'second-clear',
      eventKey: `second-clear:${id}`,
      eventAt: new Date('2026-08-21T02:03:00.000Z'),
    });
    const verifyRecovery = vi.fn();
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

    await __fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'recovery.verify',
        attempts: 1,
        payload: {
          incidentId: id,
          lifecycleVersion: 0,
          signalFence: serializeSignalFence([firstClear.signal, secondClear.signal]),
        },
      },
      { signal: new AbortController().signal },
    );

    expect(verifyRecovery).not.toHaveBeenCalled();
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'open',
      investigationStatus: 'assessed',
    });
    expect(
      (await __fixture.hub.history(__fixture.tenantId, id)).some((message) =>
        message.content.startsWith('RECOVERED'),
      ),
    ).toBe(false);
  });

  test('a refire during recovery verification invalidates the result and keeps the incident open', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-race-${randomUUID()}`,
      alertSource: 'slack',
      service: 'payments',
      severity: 'sev1',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'The payment worker exhausted its pool.',
      confidence: 70,
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, signal(id));
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      summary: '[RESOLVED] Checkout errors',
      contentHash: 'resolved-hash',
      eventKey: `resolved-${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery(input) {
        await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
          ...signal(id),
          contentHash: 'refired-hash',
          eventKey: `refired-${id}`,
          eventAt: new Date('2026-08-21T02:02:00.000Z'),
        });
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          summary: 'The first health read looked normal.',
          confidence: 0,
          recovery: {
            recovered: true,
            evidence: [__fixture.recoveryCheck('One health read passed.')],
            unknowns: [],
            nextStep: null,
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
          incidentId: id,
          lifecycleVersion: 0,
          signalFence: serializeSignalFence([cleared.signal]),
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'open',
      investigationStatus: 'assessed',
      lifecycleVersion: 0,
    });
    expect(
      (await __fixture.hub.history(__fixture.tenantId, id)).some(
        (message) => message.kind === 'lifecycle',
      ),
    ).toBe(false);
  });
});
