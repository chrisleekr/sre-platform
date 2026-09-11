import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import {
  applyTriageResult,
  approvals,
  createIncident,
  getIncident,
  incidents,
  withTenant,
} from '@sre/db';

import { makeDbAuditSink } from '@sre/agent-tools';

import { makeClaudeEngine, type AnthropicLike } from '../engine/claude';

import { TriageWorker } from '../worker';

import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('TriageWorker resume dispositions', () => {
  function claudeWorkerFor(sdk: AnthropicLike): TriageWorker {
    return new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk),
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });
  }

  // The tests below cover `rca` and `reply` on a resolved incident, plus the non-resolved control. A resume binds
  // FIVE terminals, so `approval` and `silent` remain reachable on a
  // resolved incident for the first time. `approval` is the one with a durable side effect outside the
  // hub. These two pin the INTENDED contract, which is that neither is special-cased.
  //
  // Letting a resolved incident propose an approval is the deliberate half. An approval proposal is a
  // legitimate answer to "should we roll this back?", and it is human-gated: the row and its buttons are an
  // OFFER, so nothing acts until someone clicks. Conversation does not change lifecycle.
  test('a resume on a RESOLVED incident yielding `suggest_action` posts the buttons and does not reopen', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    await __fixture.setLifecycle(__fixture.tenantId, incId, 'resolved');
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'should we roll back the 09:14 deploy after all?',
    });
    const level = 'L3';
    const explanation = 'The 09:14 checkout deploy introduced the regression.';
    const action = 'rollback: checkout@previous';
    const prompt =
      `Recommended Action (${level})\n\n${explanation}\n\n` +
      `Command or rollback reference:\n${action}`;
    const options = [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ];
    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'r237c16',
          name: 'suggest_action',
          input: { level, explanation, action },
        },
      ],
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await claudeWorkerFor({ messages: { create } }).tick('resume-237-c16')).toBe(1);

    // The durable row is created exactly as on a live incident: a decidable proposal, not a no-op.
    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(approvals).where(eq(approvals.incidentId, incId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prompt).toBe(prompt);
    expect(rows[0]!.decision).toBeNull();
    // ...and the buttons actually reach the surfaces, linked to that row. A durable approval nobody is
    // shown is the failure shape: the engine waits forever on a decision that cannot be made.
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    const appr = history.find((m) => m.kind === 'approval');
    expect(appr?.approvalId).toBe(rows[0]!.id);
    expect(appr?.approval?.options).toEqual(options);

    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    // The proposal asks for the reopen (it is active engagement) and the clamp refuses it: the incident
    // stays filed as history while still carrying an open decision.
    expect(inc?.status).toBe('resolved');
    // The watermark advances, so a redelivery re-walks nothing: no second button block for one question.
    expect(inc?.lastResumeMessageId).toBe(humanMsg.id);
  });

  test('a resume on a RESOLVED incident yielding `stay_silent` records the note and changes nothing else', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, incId, {
      provider: 'claude',
      sessionId: 'claude:c17',
      summary: 'ORIGINAL RCA: expired cert',
      confidence: 70,
    });
    await __fixture.setLifecycle(__fixture.tenantId, incId, 'resolved');
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'thanks team 🎉',
    });
    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'r237c17',
          name: 'stay_silent',
          input: { reason: 'acknowledgement only, nothing to add' },
        },
      ],
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await claudeWorkerFor({ messages: { create } }).tick('resume-237-c17')).toBe(1);

    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.find((m) => m.kind === 'silent')?.content).toBe(
      'acknowledgement only, nothing to add',
    );
    // Silent means nothing happened: no answer posted, and the settled root cause is not re-decided.
    expect(history.some((m) => m.kind === 'finding' || m.kind === 'reply')).toBe(false);
    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    expect(inc?.rcaSummary).toBe('ORIGINAL RCA: expired cert');
    expect(inc?.confidence).toBe(70);
    // A silent turn consumes the message without changing lifecycle.
    expect(inc?.status).toBe('resolved');
    // The watermark still advances: exactly-once holds even when the turn says nothing.
    expect(inc?.lastResumeMessageId).toBe(humanMsg.id);
  });
});

describe('TriageWorker terminal lifecycle conversation', () => {
  test('a human reply leaves closed and resolved lifecycle unchanged', async () => {
    const { id: closedId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const closedReply = await __fixture.hub.append(__fixture.tenantId, closedId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'seeing this again',
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ status: 'closed' })
      .where(eq(incidents.id, closedId));
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: closedId, humanMessageId: closedReply.id },
    });
    expect(await __fixture.worker.tick('closed-conversation')).toBe(1);
    expect((await getIncident(__fixture.app.db, __fixture.tenantId, closedId))?.status).toBe(
      'closed',
    );

    const { id: resolvedId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    await __fixture.setLifecycle(__fixture.tenantId, resolvedId, 'resolved');
    const resolvedReply = await __fixture.hub.append(__fixture.tenantId, resolvedId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'reopen?',
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: resolvedId, humanMessageId: resolvedReply.id },
    });
    expect(await __fixture.worker.tick('resolved-conversation')).toBe(1);
    expect((await getIncident(__fixture.app.db, __fixture.tenantId, resolvedId))?.status).toBe(
      'resolved',
    );
  });
});
