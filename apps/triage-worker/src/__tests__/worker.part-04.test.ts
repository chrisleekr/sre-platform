import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { approvals, createIncident, decideApproval, getIncident, jobs, withTenant } from '@sre/db';

import { makeDbAuditSink } from '@sre/agent-tools';

import Anthropic from '@anthropic-ai/sdk';

import { Queue } from '@sre/queue';

import { makeClaudeEngine, type AnthropicLike } from '../engine/claude';

import { TriageWorker } from '../worker';

import {
  type ResumeInput,
  type TriageEngine,
  type TriageInput,
  type TriageResult,
} from '../engine/types';

import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('TriageWorker', () => {
  // Build a worker with a capturing engine (records the first-turn TriageInput) and an injected
  // runbookSeeder. `runbookSeeder` is not yet on TriageWorkerDeps, so cast — RED until the worker
  // both accepts and consumes it.

  // REDUX: the TRIAGE path has no resumeMessageId, so the salt base degenerates to the constant
  // incidentId. A one-shot re-key therefore breaks on the SECOND re-proposal: the salted row is decided
  // too, and nothing re-keys again — the engine proposes a remediation no human is ever shown. A flapper
  // re-alerting past the dedup TTL re-triages the SAME incident, which is exactly this sequence.
  test('triage path: a THIRD proposal after two decisions still posts its own button block', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const prompt = 'Restart checkout?';
    const options = [{ id: 'approve', label: 'Approve' }];
    // The fake engine proposes the identical action every time. Worker persistence must remain
    // idempotent even on the triage path, which has no resume-message salt.
    const triageProposer: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(input: TriageInput): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'approval',
          summary: prompt,
          confidence: 0,
          approval: { prompt, options },
        } as unknown as TriageResult;
      },
      async resume(input: ResumeInput): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          summary: 's',
          confidence: 50,
        };
      },
    };
    const w = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: triageProposer,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });
    const approvalRows = () =>
      withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
        tx.select().from(approvals).where(eq(approvals.incidentId, incId)),
      );
    const decideNewest = async (): Promise<void> => {
      const open = (await approvalRows()).filter((r) => r.decision === null);
      expect(open).toHaveLength(1);
      expect(
        await decideApproval(
          __fixture.app.db,
          __fixture.tenantId,
          incId,
          open[0]!.actionId,
          'deny',
          'u-human',
        ),
      ).toBe(true);
    };
    const triage = async (consumer: string): Promise<void> => {
      // A re-alert past the dedup TTL reuses the incident and enqueues a FRESH triage job (the funnel is
      // idempotent on the incident, not on the job), so the same incident is triaged again.
      await __fixture.setLifecycle(__fixture.tenantId, incId, 'open');
      await __fixture.queue.enqueue({
        tenantId: __fixture.tenantId,
        type: 'triage',
        payload: { incidentId: incId },
      });
      expect(await w.tick(consumer)).toBe(1);
    };

    await triage('appr-tri-1'); // proposal 1 -> the unsalted content-hash row
    await decideNewest();
    await triage('appr-tri-2'); // proposal 2 -> salted
    await decideNewest();
    await triage('appr-tri-3'); // proposal 3 -> must NOT collide with the decided salted row

    const rows = await approvalRows();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.decision === null)).toHaveLength(1); // a live one to act on
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.filter((m) => m.kind === 'approval')).toHaveLength(3); // three button blocks

    // And the third proposal REDELIVERED (the run really happens again) lands on the SAME row: the chain
    // is deterministic, not a nonce. A nonce salt would mint a fourth row here.
    await triage('appr-tri-4');
    expect(await approvalRows()).toHaveLength(3);
    expect(
      (await __fixture.hub.history(__fixture.tenantId, incId)).filter((m) => m.kind === 'approval'),
    ).toHaveLength(3);
  });
});

describe('TriageWorker degrade-and-redeliver', () => {
  test('provider outage posts the assembled brief + escalation once, redelivers, then completes on recovery', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    // Two outage turns, then the provider recovers with a terminal report_findings.
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        Anthropic.APIError.generate(503, undefined, 'unavailable', new Headers()),
      )
      .mockRejectedValueOnce(
        Anthropic.APIError.generate(503, undefined, 'unavailable', new Headers()),
      )
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'r1',
            name: 'report_findings',
            input: {
              outcome: 'conclusive',
              summary: 'recovered: root cause found',
              confidence: 70,
              rankedHypotheses: [],
            },
          },
        ],
      });
    const sdk: AnthropicLike = { messages: { create } };
    const degStream = `sre:jobs:deg-${randomUUID().slice(0, 8)}`;
    const degQueue = new Queue(__fixture.admin.db, __fixture.redis, {
      stream: degStream,
      deadStream: `${degStream}:dead`,
      group: 'deg',
    });
    await degQueue.ensureGroup();
    const degradeWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk),
      queue: degQueue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: () => async () => [__fixture.briefConnector()],
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });
    const jobId = await degQueue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: incId, alert: { fingerprint: 'z' } },
    });

    // Attempt 1: outage → degrade.
    await degQueue.process(
      'c',
      (j) => degradeWorker.handle(j, { signal: new AbortController().signal }),
      { idleMs: 0 },
    );
    expect(
      (await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.investigationStatus,
    ).toBe('degraded');
    let job = (await __fixture.admin.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
    // Re-queued via RetryableError, NOT dead-lettered.
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(1);
    let history = await __fixture.hub.history(__fixture.tenantId, incId);
    const brief = history.find((m) => m.content.includes('evidence brief'));
    expect(brief).toBeDefined();
    // Assembled context: the connector's real data reached the brief, with no LLM involved.
    expect(brief!.content).toContain('deadbee');
    expect(history.filter((m) => m.content.includes('Escalated'))).toHaveLength(1);

    // Attempt 2: still down → degrade again, but idempotent (no duplicate brief/escalation).
    await degQueue.process(
      'c',
      (j) => degradeWorker.handle(j, { signal: new AbortController().signal }),
      { idleMs: 0 },
    );
    history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.filter((m) => m.content.includes('evidence brief'))).toHaveLength(1);
    expect(history.filter((m) => m.content.includes('Escalated'))).toHaveLength(1);
    expect(
      (await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.investigationStatus,
    ).toBe('degraded');

    // Attempt 3: provider recovers → synthesis completes, clearing 'degraded'.
    await degQueue.process(
      'c',
      (j) => degradeWorker.handle(j, { signal: new AbortController().signal }),
      { idleMs: 0 },
    );
    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    expect(inc).toMatchObject({ status: 'open', investigationStatus: 'assessed' });
    expect(inc?.rcaSummary).toContain('recovered');
    job = (await __fixture.admin.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
    expect(job.status).toBe('done');
    // Still exactly one brief; the engine's own finding is a separate message.
    history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.filter((m) => m.content.includes('evidence brief'))).toHaveLength(1);

    await __fixture.redis.del(degStream, `${degStream}:dead`);
  });

  test('a hard error (400) posts the brief once, then dead-letters at maxAttempts (not the retryable ceiling)', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const hardStream = `sre:jobs:hard-${randomUUID().slice(0, 8)}`;
    // maxAttempts=1 so a single non-retryable tick dead-letters immediately.
    const hardQueue = new Queue(__fixture.admin.db, __fixture.redis, {
      stream: hardStream,
      deadStream: `${hardStream}:dead`,
      group: 'hard',
      maxAttempts: 1,
    });
    await hardQueue.ensureGroup();
    const create = vi
      .fn()
      .mockRejectedValue(Anthropic.APIError.generate(400, undefined, 'bad request', new Headers()));
    const sdk: AnthropicLike = { messages: { create } };
    const hardWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk),
      queue: hardQueue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: () => async () => [__fixture.briefConnector()],
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });
    const jobId = await hardQueue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: incId },
    });

    await hardQueue.process(
      'h',
      (j) => hardWorker.handle(j, { signal: new AbortController().signal }),
      { idleMs: 0 },
    );

    // A hard error is not retryable: it dead-letters at maxAttempts (1), never the retryable ceiling.
    expect(
      (await __fixture.admin.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.status,
    ).toBe('dead');
    // The brief + escalation were still posted (a human gets context) and the incident is degraded.
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.filter((m) => m.content.includes('evidence brief'))).toHaveLength(1);
    expect(history.filter((m) => m.content.includes('Escalated'))).toHaveLength(1);
    expect(
      (await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.investigationStatus,
    ).toBe('degraded');

    await __fixture.redis.del(hardStream, `${hardStream}:dead`);
  });

  test('a failure while posting the brief leaves progress gathering and stays retryable', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const create = vi.fn().mockImplementation(async () => {
      throw __fixture.rateLimited();
    });
    const appendTxOnce = __fixture.hub.appendTxOnce.bind(__fixture.hub);
    const appendFailure = vi.spyOn(__fixture.hub, 'appendTxOnce').mockImplementation((...args) => {
      const message = args[3];
      if (message.originMessageId?.startsWith('triage-assessment:'))
        return Promise.reject(new Error('durable finding write failed'));
      return appendTxOnce(...args);
    });
    const sdk: AnthropicLike = { messages: { create } };
    const stream = `sre:jobs:degfail-${randomUUID().slice(0, 8)}`;
    const q = new Queue(__fixture.admin.db, __fixture.redis, {
      stream,
      deadStream: `${stream}:dead`,
      group: 'degfail',
    });
    await q.ensureGroup();
    const w = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk),
      queue: q,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });
    const jobId = await q.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: incId },
    });

    await q.process('c', (j) => w.handle(j, { signal: new AbortController().signal }), {
      idleMs: 0,
    });
    appendFailure.mockRestore();

    // The transaction rolled back: the incident is NOT stuck 'degraded' with a missing brief.
    expect(
      (await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.investigationStatus,
    ).toBe('gathering');
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.some((m) => m.content.includes('evidence brief'))).toBe(false);
    // The provider outage still re-queued (RetryableError), so it retries once infra recovers.
    expect(
      (await __fixture.admin.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.status,
    ).toBe('queued');

    await __fixture.redis.del(stream, `${stream}:dead`);
  });
});
