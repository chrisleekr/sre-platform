import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  applySignalObservation,
  applyTriageResult,
  createIncident,
  getIncident,
  incidents,
  jobs,
  serializeSignalFence,
  setInvestigationStatus,
  withTenant,
} from '@sre/db';

import {
  type RecoveryInput,
  type ResumeInput,
  type TriageEngine,
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

  test('turns a final model recheck into human attention instead of exceeding the cost ceiling', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-budget-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: `recovery-budget-clear:${id}`,
      eventKey: `recovery-budget-clear:${id}`,
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
          summary: 'Checkout latency remains elevated.',
          confidence: 0,
          evidenceReceipts: [{ evidenceId, tool: 'prometheus_query_range', outcome: 'complete' }],
          recovery: {
            outcome: 'recheck',
            recovered: false,
            evidence: [__fixture.recoveryCheck('1.4s', '2.1s', 'Checkout latency')],
            evidenceIds: [evidenceId],
            unknowns: [],
            nextStep: null,
            recheckAfterMinutes: 5,
            scheduleReason: 'Latency is still changing.',
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
          attempt: 3,
          maxChecks: 3,
        },
      },
      { signal: new AbortController().signal },
    );

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'open',
      recoveryState: 'not_verified',
      recoveryAttempt: 3,
      recoveryMaxChecks: 3,
      recoveryNextCheckAt: null,
    });
    expect(
      await __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'recovery.verify' and payload->>'incidentId' = ${id}`,
        ),
    ).toHaveLength(0);
    expect((await __fixture.hub.history(__fixture.tenantId, id)).at(-1)).toMatchObject({
      kind: 'finding',
      recovery: expect.objectContaining({ outcome: 'needs_human', attempt: 3, maxChecks: 3 }),
    });
  });

  test('an interactive recovery recheck uses structured evidence and resolves the incident', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `interactive-recovery-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: `interactive-recovery-clear:${id}`,
      eventKey: `interactive-recovery-clear:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx
        .update(incidents)
        .set({ recoveryState: 'not_verified', recoveryAttempt: 1, recoveryMaxChecks: 3 })
        .where(eq(incidents.id, id)),
    );
    const human = await __fixture.hub.append(__fixture.tenantId, id, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      kind: 'text',
      content: 'Can you recheck whether this is still ongoing?',
      originSurface: 'slack',
    });
    let seenRecoveryContext: ResumeInput['recoveryContext'];
    const engine: TriageEngine = {
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume(input, runtime) {
        seenRecoveryContext = input.recoveryContext;
        const evidenceId = await recoveryEvidence(id, runtime);
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          summary: 'Checkout latency and errors are back to baseline.',
          confidence: 0,
          evidenceReceipts: [{ evidenceId, tool: 'prometheus_query_range', outcome: 'complete' }],
          recovery: {
            outcome: 'recovered',
            recovered: true,
            evidence: [__fixture.recoveryCheck('Healthy', 'Alerting', 'Checkout health')],
            evidenceIds: [evidenceId],
            unknowns: [],
            nextStep: null,
            recheckAfterMinutes: null,
            scheduleReason: null,
          },
        };
      },
      verifyRecovery: __fixture.verifyRecovery,
    };

    await __fixture.workerWithEngine(engine).handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'resume',
        attempts: 1,
        payload: { incidentId: id, humanMessageId: human.id },
      },
      { signal: new AbortController().signal },
    );

    expect(seenRecoveryContext).toMatchObject({ attempt: 2, maxChecks: 3 });
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 1,
      recoveryState: 'verified',
      recoveryAttempt: 2,
      lastResumeMessageId: human.id,
    });
    expect(
      (await __fixture.hub.history(__fixture.tenantId, id)).filter(
        (message) => message.kind === 'lifecycle',
      ),
    ).toEqual([expect.objectContaining({ lifecycleFrom: 'open', lifecycleTo: 'resolved' })]);
  });

  test('resolves a recovered incident while preserving follow-up work', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-followup-${randomUUID()}`,
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
      contentHash: `recovery-followup-clear:${id}`,
      eventKey: `recovery-followup-clear:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const followUp = {
      question: 'Does the downstream synthetic need a separate reliability follow-up?',
      category: 'partial_evidence' as const,
      evidenceKind: 'metrics' as const,
      attemptedEvidenceIds: [],
      resolutionRelevance: 'follow_up' as const,
      nextAction: 'Open a follow-up to confirm the downstream synthetic.',
    };
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
          summary: 'Current checkout telemetry is healthy, but a synthetic remains unchecked.',
          confidence: 0,
          evidenceReceipts: [{ evidenceId, tool: 'prometheus_query_range', outcome: 'complete' }],
          recovery: {
            recovered: true,
            evidence: [
              __fixture.recoveryCheck('The current error rate is below the alert threshold.'),
            ],
            evidenceIds: [evidenceId],
            unknowns: [],
            questions: [followUp],
            nextStep: 'Open a follow-up to confirm the downstream synthetic.',
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
      status: 'resolved',
      lifecycleVersion: 1,
      recoveryState: 'verified',
      recoveryQuestions: [followUp],
      recoveryUnknowns: [followUp.question],
      recoveryNextStep: 'Open a follow-up to confirm the downstream synthetic.',
    });
    expect(
      (await __fixture.hub.history(__fixture.tenantId, id)).filter(
        (message) => message.kind === 'lifecycle',
      ),
    ).toEqual([
      expect.objectContaining({
        lifecycleFrom: 'open',
        lifecycleTo: 'resolved',
        lifecycleVersion: 1,
        originSurface: 'automation',
      }),
    ]);
  });

  test('resolves a recovered high-severity degraded incident while preserving RCA and follow-up', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'A bad deploy exhausted the connection pool.',
      confidence: 80,
    });
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantId, id, 'degraded');
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
      async verifyRecovery(input, runtime) {
        const evidenceId = await recoveryEvidence(id, runtime);
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          summary: 'Error rate and saturation returned to baseline.',
          confidence: 0,
          evidenceReceipts: [{ evidenceId, tool: 'prometheus_query_range', outcome: 'complete' }],
          recovery: {
            recovered: true,
            evidence: [__fixture.recoveryCheck('Current error rate is below the alert threshold.')],
            evidenceIds: [evidenceId],
            unknowns: ['A downstream synthetic check is still delayed.'],
            nextStep: 'Confirm the downstream synthetic check before resolving.',
          },
        };
      },
    };

    const recoveryWorker = __fixture.workerWithEngine(engine);
    const recoveryJob = {
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
    await recoveryWorker.handle(recoveryJob, { signal: new AbortController().signal });
    await recoveryWorker.handle(recoveryJob, { signal: new AbortController().signal });

    const incident = await getIncident(__fixture.app.db, __fixture.tenantId, id);
    expect(incident).toMatchObject({
      status: 'resolved',
      investigationStatus: 'assessed',
      lifecycleVersion: 1,
      rcaSummary: 'A bad deploy exhausted the connection pool.',
      recoveryState: 'verified',
      recoverySummary: 'Error rate and saturation returned to baseline.',
      recoveryUnknowns: ['A downstream synthetic check is still delayed.'],
      recoveryNextStep: 'Confirm the downstream synthetic check before resolving.',
      recoveryUpdatedAt: expect.any(Date),
    });
    const lifecycle = (await __fixture.hub.history(__fixture.tenantId, id)).filter(
      (message) => message.kind === 'lifecycle',
    );
    expect(lifecycle).toEqual([
      expect.objectContaining({
        lifecycleFrom: 'open',
        lifecycleTo: 'resolved',
        lifecycleVersion: 1,
        originSurface: 'automation',
      }),
    ]);
    const outcomes = (await __fixture.hub.history(__fixture.tenantId, id)).filter((message) =>
      message.content.startsWith('RECOVERED'),
    );
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.content).toContain('Current error rate is below the alert threshold.');
    expect(outcome?.content).toContain('A downstream synthetic check is still delayed.');
    expect(outcome?.content).toContain('Confirm the downstream synthetic check before resolving.');
    expect(outcome?.recovery).toMatchObject({
      recovered: true,
      checks: [expect.objectContaining({ name: 'Current health' })],
    });
  });

  test('an active lifecycle change during recovery redelivers against the newer version', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `recovery-lifecycle-race-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, id, {
      provider: 'fake',
      sessionId: `fake:${id}`,
      summary: 'The checkout pool saturated.',
      confidence: 75,
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
      ...signal(id),
      state: 'resolved',
      contentHash: 'recovery-lifecycle-race-cleared',
      eventKey: `recovery-lifecycle-race-cleared:${id}`,
      eventAt: new Date('2026-08-21T02:01:00.000Z'),
    });
    const verifyRecovery = vi.fn(
      async (_input: RecoveryInput, runtime: TriageRuntime): Promise<TriageResult> => {
        if (verifyRecovery.mock.calls.length === 1) {
          await __fixture.hub.transitionIncident(__fixture.tenantId, id, {
            to: 'mitigated',
            reason: 'Traffic shifted while verification was running.',
            transitionKey: `recovery-race-mitigated:${id}`,
            author: 'human',
            authorUserId: __fixture.actorUserId,
            expectedVersion: 0,
          });
        }
        const evidenceId = await recoveryEvidence(id, runtime);
        return {
          provider: 'fake',
          sessionId: `fake:${id}:recovery`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'recovery',
          summary: 'Current error rate returned to baseline.',
          confidence: 0,
          evidenceReceipts: [{ evidenceId, tool: 'prometheus_query_range', outcome: 'complete' }],
          recovery: {
            recovered: true,
            evidence: [__fixture.recoveryCheck('Current checkout error rate is below threshold.')],
            evidenceIds: [evidenceId],
            unknowns: [],
            nextStep: null,
          },
        };
      },
    );
    const recoveryWorker = __fixture.workerWithEngine({
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      async resume() {
        throw new Error('not used');
      },
      verifyRecovery,
    });
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
    await __fixture.admin.db.insert(jobs).values({
      ...job,
      status: 'processing',
      stream: 'worker-recovery-test',
    });

    await expect(
      recoveryWorker.handle(job, { signal: new AbortController().signal }),
    ).rejects.toThrow('recovery lifecycle changed; redelivering');
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'mitigated',
      lifecycleVersion: 1,
      investigationStatus: 'assessed',
    });
    const retry = (
      await __fixture.admin.db
        .select({ payload: jobs.payload })
        .from(jobs)
        .where(eq(jobs.id, job.id))
    )[0]!;
    expect(retry.payload).toMatchObject({ lifecycleVersion: 1 });
    await recoveryWorker.handle(
      { ...job, attempts: 2, payload: retry.payload },
      { signal: new AbortController().signal },
    );

    expect(verifyRecovery).toHaveBeenCalledTimes(2);
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, id)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 2,
      investigationStatus: 'assessed',
    });
    expect(
      (await __fixture.hub.history(__fixture.tenantId, id)).filter((message) =>
        message.content.startsWith('RECOVERED'),
      ),
    ).toHaveLength(1);
  });
});
