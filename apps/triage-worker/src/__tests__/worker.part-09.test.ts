import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  applySignalObservation,
  applyTriageResult,
  createIncident,
  getIncident,
  incidentSignals,
  investigationRuns,
  jobs,
  serializeSignalFence,
} from '@sre/db';

import { makeFakeEngine } from '../engine/fake';

import {
  type TriageEngine,
  type TriageInput,
  type TriageResult,
  type TriageRuntime,
} from '../engine/types';

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

  test('opening triage does not mark material that changed after its durable prompt snapshot', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `material-race-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `trusted-before-race:${id}`,
      summary: 'Trusted assessment before the signal changed.',
      confidence: 75,
    });
    const providerFingerprint = randomUUID();
    const firstMaterialHash = randomUUID();
    const first = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      provider: 'alertmanager',
      providerFingerprint,
      startsAt: new Date('2026-08-21T01:55:00.000Z'),
      materialHash: firstMaterialHash,
      contentHash: `material-race-first:${id}`,
      eventKey: `material-race-first:${id}`,
    });
    const latestMaterialHash = randomUUID();
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      provider: 'alertmanager',
      providerFingerprint,
      startsAt: new Date('2026-08-21T01:55:00.000Z'),
      materialHash: latestMaterialHash,
      summary: 'Checkout errors increased after the opening job was queued.',
      contentHash: `material-race-latest:${id}`,
      eventKey: `material-race-latest:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const engine = makeFakeEngine();

    const jobId = randomUUID();
    await __fixture.workerWithEngine(engine).handle(
      {
        id: jobId,
        tenantId: __fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: {
          incidentId: id,
          alert: { status: 'firing' },
          signalMaterials: [{ signalId: first.signal.id, materialHash: firstMaterialHash }],
        },
      },
      { signal: new AbortController().signal },
    );

    expect(
      await __fixture.admin.db
        .select({
          materialHash: incidentSignals.materialHash,
          lastInvestigatedMaterialHash: incidentSignals.lastInvestigatedMaterialHash,
        })
        .from(incidentSignals)
        .where(eq(incidentSignals.id, first.signal.id)),
    ).toEqual([{ materialHash: latestMaterialHash, lastInvestigatedMaterialHash: null }]);
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      rcaSummary: 'Trusted assessment before the signal changed.',
      confidence: 75,
      investigationStatus: 'assessed',
    });
    expect(
      await __fixture.admin.db
        .select({ outcome: investigationRuns.outcome, result: investigationRuns.result })
        .from(investigationRuns)
        .where(eq(investigationRuns.jobId, jobId)),
    ).toEqual([
      {
        outcome: 'failed',
        result: expect.objectContaining({ reason: 'stale_signal_material' }),
      },
    ]);
  });

  test('a refired signal cannot restore or reassess a deleted terminal incident', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `refire-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, signal(id));
    await __fixture.hub.transitionIncident(__fixture.tenantId, id, {
      to: 'resolved',
      reason: 'Responder verified recovery.',
      transitionKey: `resolve-before-refire:${id}`,
      author: 'human',
      authorUserId: __fixture.actorUserId,
      expectedVersion: 0,
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: 'cleared-before-refire',
      eventKey: `cleared-before-refire:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    expect(
      (
        await __fixture.hub.setIncidentArchived(__fixture.tenantId, id, {
          archived: true,
          reason: 'Retain the completed investigation as history.',
          archiveKey: `archive-before-refire:${id}`,
          author: 'human',
          authorUserId: __fixture.actorUserId,
          expectedVersion: 1,
        })
      ).archive.outcome,
    ).toBe('applied');
    const refired = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      contentHash: 'refired',
      eventKey: `refired:${id}`,
      eventAt: new Date('2026-08-21T02:02:00.000Z'),
    });
    expect(refired.signal.version).toBeGreaterThan(cleared.signal.version);
    const investigate = vi.fn(async (input: TriageInput): Promise<TriageResult> => ({
      provider: 'fake',
      sessionId: `fake:${input.incident.id}`,
      outcome: 'conclusive',
      turnBudget: 1,
      disposition: 'rca',
      summary: 'The checkout alert fired again.',
      confidence: 70,
    }));
    const engine: TriageEngine = {
      provider: 'fake',
      investigate,
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery() {
        throw new Error('not used');
      },
    };

    await __fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'signal.reassess',
        attempts: 1,
        payload: {
          incidentId: id,
          signalId: refired.signal.id,
          signalVersion: refired.signal.version,
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 1,
      archivedAt: expect.any(Date),
    });
    expect(investigate).not.toHaveBeenCalled();
    expect(
      (await __fixture.hub.history(__fixture.tenantId, id)).filter(
        (message) => message.kind === 'lifecycle',
      ),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ lifecycleTo: 'open' })]));
  });

  test('a material firing update cannot restore or reassess a deleted closed incident', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `archived-firing-update-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, signal(id));
    await __fixture.hub.transitionIncident(__fixture.tenantId, id, {
      to: 'closed',
      reason: 'Responder closed the incident despite the stale provider state.',
      transitionKey: `close-before-update:${id}`,
      author: 'human',
      authorUserId: __fixture.actorUserId,
      expectedVersion: 0,
    });
    expect(
      (
        await __fixture.hub.setIncidentArchived(__fixture.tenantId, id, {
          archived: true,
          reason: 'The provider state is stale and this investigation is complete.',
          archiveKey: `archive-before-update:${id}`,
          author: 'human',
          authorUserId: __fixture.actorUserId,
          expectedVersion: 1,
          allowActiveSignalsForClosed: true,
        })
      ).archive.outcome,
    ).toBe('applied');

    const updated = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      summary: 'Checkout errors increased to 20%',
      contentHash: 'material-update-after-archive',
      eventKey: `material-update-after-archive:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    expect(updated).toMatchObject({ applied: true, eventType: 'updated' });
    const investigate = vi.fn(async (input: TriageInput): Promise<TriageResult> => ({
      provider: 'fake',
      sessionId: `fake:${input.incident.id}`,
      outcome: 'conclusive',
      turnBudget: 1,
      disposition: 'rca',
      summary: 'The still-firing checkout alert materially changed.',
      confidence: 70,
    }));
    const engine: TriageEngine = {
      provider: 'fake',
      investigate,
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery() {
        throw new Error('not used');
      },
    };

    await __fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'signal.reassess',
        attempts: 1,
        payload: {
          incidentId: id,
          signalId: updated.signal.id,
          signalVersion: updated.signal.version,
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'closed',
      lifecycleVersion: 1,
      archivedAt: expect.any(Date),
    });
    expect(investigate).not.toHaveBeenCalled();
  });

  test('a resolved signal edited to unknown does not reopen a terminal incident', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `unknown-refire-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, signal(id));
    await __fixture.hub.transitionIncident(__fixture.tenantId, id, {
      to: 'resolved',
      reason: 'Responder verified recovery.',
      transitionKey: `resolve-before-unknown:${id}`,
      author: 'human',
      authorUserId: __fixture.actorUserId,
      expectedVersion: 0,
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: 'resolved-before-unknown',
      eventKey: `resolved-before-unknown:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const unknown = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'unknown',
      summary: 'A human edited the message to ordinary text.',
      contentHash: 'unknown-after-resolved',
      eventKey: `unknown-after-resolved:${id}`,
      eventAt: new Date('2026-08-21T02:02:00.000Z'),
    });
    const investigate = vi.fn();
    const engine: TriageEngine = {
      provider: 'fake',
      investigate,
      async resume() {
        throw new Error('not used');
      },
      async verifyRecovery() {
        throw new Error('not used');
      },
    };

    await __fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'signal.reassess',
        attempts: 1,
        payload: {
          incidentId: id,
          signalId: unknown.signal.id,
          signalVersion: unknown.signal.version,
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 1,
    });
    expect(investigate).not.toHaveBeenCalled();
    expect(
      (await __fixture.hub.history(__fixture.tenantId, id)).filter(
        (message) => message.kind === 'lifecycle',
      ),
    ).toHaveLength(1);
  });

  test('automatically resolves a still-platform-owned sev3 after fenced recovery verification', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `auto-recovery-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'A transient checkout dependency timed out.',
      confidence: 80,
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      summary: '[RESOLVED] Checkout dependency timeout',
      contentHash: `auto-recovery-clear:${id}`,
      eventKey: `auto-recovery-clear:${id}`,
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
      async verifyRecovery(input, runtime) {
        const evidenceId = await recoveryEvidence(id, runtime);
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          summary: 'Current checkout telemetry is healthy.',
          confidence: 0,
          evidenceReceipts: [{ evidenceId, tool: 'prometheus_query_range', outcome: 'complete' }],
          recovery: {
            recovered: true,
            evidence: [
              __fixture.recoveryCheck('The current error rate is below the alert threshold.'),
            ],
            evidenceIds: [evidenceId],
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
        incidentId: id,
        lifecycleVersion: 0,
        signalFence: serializeSignalFence([cleared.signal]),
      },
    };

    const recoveryWorker = __fixture.workerWithEngine(engine);
    await recoveryWorker.handle(job, { signal: new AbortController().signal });
    await recoveryWorker.handle(job, { signal: new AbortController().signal });

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 1,
      investigationStatus: 'assessed',
      recoveryState: 'verified',
      recoverySummary: 'Current checkout telemetry is healthy.',
    });
    const history = await __fixture.hub.history(__fixture.tenantId, id);
    expect(history.filter((message) => message.kind === 'finding')).toHaveLength(1);
    expect(history.filter((message) => message.kind === 'lifecycle')).toEqual([
      expect.objectContaining({
        author: 'system',
        originSurface: 'automation',
        lifecycleFrom: 'open',
        lifecycleTo: 'resolved',
        lifecycleVersion: 1,
      }),
    ]);
  });

  test('persists a model-selected delayed recovery check without asking a human', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-monitoring-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      summary: '[RESOLVED] Checkout dependency timeout',
      contentHash: `recovery-monitoring-clear:${id}`,
      eventKey: `recovery-monitoring-clear:${id}`,
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
      async verifyRecovery(input, runtime) {
        const evidenceId = await recoveryEvidence(id, runtime);
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          summary: 'Checkout latency is improving while the rollout converges.',
          confidence: 0,
          evidenceReceipts: [{ evidenceId, tool: 'prometheus_query_range', outcome: 'complete' }],
          recovery: {
            outcome: 'recheck',
            recovered: false,
            evidence: [__fixture.recoveryCheck('800ms and falling', '2.1s', 'Checkout latency')],
            evidenceIds: [evidenceId],
            unknowns: [],
            nextStep: 'Recheck after the rollout has had time to converge.',
            recheckAfterMinutes: 5,
            scheduleReason: 'The rollout is still converging and latency is trending down.',
          },
        };
      },
    };
    const startedAt = Date.now();

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
          attempt: 1,
          maxChecks: 3,
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'open',
      recoveryState: 'monitoring',
      recoveryAttempt: 1,
      recoveryMaxChecks: 3,
      recoveryScheduleReason: 'The rollout is still converging and latency is trending down.',
    });
    const successor = (
      await __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'recovery.verify' and payload->>'incidentId' = ${id}`,
        )
    )[0]!;
    expect(successor).toMatchObject({
      status: 'queued',
      streamId: null,
      payload: expect.objectContaining({ attempt: 2, maxChecks: 3 }),
    });
    expect(successor.availableAt.getTime()).toBeGreaterThanOrEqual(startedAt + 5 * 60_000 - 1_000);
    expect((await __fixture.hub.history(__fixture.tenantId, id)).at(-1)).toMatchObject({
      kind: 'status',
      recovery: expect.objectContaining({ outcome: 'recheck', attempt: 1, maxChecks: 3 }),
    });
  });
});
