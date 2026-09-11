import { describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  applyTriageResult,
  createIncident,
  getIncident,
  recordToolCall,
  setInvestigationStatus,
} from '@sre/db';
import { makeDbAuditSink } from '@sre/agent-tools';
import { makeClaudeEngine, type AnthropicLike } from '../engine/claude';
import { TriageWorker } from '../worker';
import {
  type ResumeInput,
  type TriageEngine,
  type TriageInput,
  type TriageResult,
} from '../engine/types';

import { createFixture } from './worker.fixture';
import { INTERNAL_REFERENCE } from './internal-reference.fixture';

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

  test('respond → posts a reply row (content=detail, summary=takeaway), leaves the RCA untouched, advances the watermark', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    // A prior RCA on the incident; the reply must NOT overwrite it.
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, incId, {
      provider: 'claude',
      sessionId: 'claude:x',
      summary: 'ORIGINAL RCA: bad deploy',
      confidence: 70,
    });
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'is the DB pool the cause?',
    });
    const evidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantId, {
      incidentId: incId,
      tool: 'query_metrics',
      input: { service: 'checkout' },
      output: { saturated: false },
      latencyMs: 2,
      outcome: 'data',
    });
    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'r1',
          name: 'respond',
          input: {
            summary: 'DB pool is healthy',
            detail:
              'The DB pool shows no saturation; the earlier deploy is still the leading cause.',
            evidenceIds: [evidenceId],
          },
        },
      ],
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await claudeWorkerFor({ messages: { create } }).tick('resp-1')).toBe(1);

    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    const reply = history.find((m) => m.kind === 'reply');
    expect(reply).toBeDefined();
    expect(reply!.author).toBe('agent');
    expect(reply!.content).toContain('no saturation');
    expect(reply!.summary).toBe('DB pool is healthy');
    expect(reply!.finding?.evidenceIds).toEqual([evidenceId]);
    // No finding was posted and the RCA is unchanged (a reply never overwrites the root cause).
    expect(history.some((m) => m.kind === 'finding')).toBe(false);
    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    expect(inc?.rcaSummary).toBe('ORIGINAL RCA: bad deploy');
    expect(inc?.lastResumeMessageId).toBe(humanMsg.id);
  });
  test('stay_silent → records a silent row (content=reason, no summary), no RCA write, advances the watermark', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, incId, {
      provider: 'claude',
      sessionId: 'claude:y',
      summary: 'ORIGINAL RCA: cache miss',
      confidence: 65,
    });
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'thanks!',
    });
    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 's1',
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
    expect(await claudeWorkerFor({ messages: { create } }).tick('silent-1')).toBe(1);

    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    const silent = history.find((m) => m.kind === 'silent');
    expect(silent).toBeDefined();
    expect(silent!.content).toBe('acknowledgement only, nothing to add');
    expect(silent!.summary ?? null).toBeNull();
    expect(history.some((m) => m.kind === 'finding')).toBe(false);
    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    expect(inc?.rcaSummary).toBe('ORIGINAL RCA: cache miss');
    expect(inc?.lastResumeMessageId).toBe(humanMsg.id);
  });
  test('resume exhaustion records a non-promoted finding, preserves the RCA, and advances the watermark', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    // A prior RCA must survive a newer run that has no accepted conclusion.
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, incId, {
      provider: 'claude',
      sessionId: 'claude:z',
      summary: 'ORIGINAL RCA: bad config push',
      confidence: 60,
    });
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'still happening?',
    });
    // The model stops early with no tool call, so there is no responder-facing conclusion.
    const create = vi.fn().mockResolvedValueOnce({ stop_reason: 'end_turn', content: [] });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await claudeWorkerFor({ messages: { create } }).tick('resume-degrade')).toBe(1);

    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.some((m) => m.kind === 'silent')).toBe(false);
    expect(history.find((m) => m.kind === 'finding')?.finding).toMatchObject({
      runId: expect.any(String),
      outcome: 'inconclusive',
      promotion: 'not_promoted',
      promotionReason: 'investigation_inconclusive',
    });
    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    expect(inc?.rcaSummary).toBe('ORIGINAL RCA: bad config push');
    expect(inc?.lastResumeMessageId).toBe(humanMsg.id);
  });
  test('batch drain: two queued human replies coalesce into ONE turn addressing the newest; redelivery is a no-op', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    // Two human replies land before either resume is processed.
    await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'first: check the pool',
    });
    const m2 = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'actually: check the cache',
    });

    let resumeCalls = 0;
    let seenHuman = '';
    const spyEngine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(i: TriageInput): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${i.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          summary: 's',
          confidence: 50,
        };
      },
      async resume(i: ResumeInput): Promise<TriageResult> {
        resumeCalls += 1;
        seenHuman = i.humanMessage;
        return {
          provider: 'fake',
          sessionId: `fake:${i.incident.id}`,
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'rca',
          summary: `answered: ${i.humanMessage}`,
          confidence: 55,
        };
      },
    };
    const spyWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: spyEngine,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: m2.id },
    });
    expect(await spyWorker.tick('batch-1')).toBe(1);
    // One turn, addressing the NEWEST reply; the watermark jumped to it.
    expect(resumeCalls).toBe(1);
    expect(seenHuman).toBe('actually: check the cache');
    expect(
      (await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.lastResumeMessageId,
    ).toBe(m2.id);

    // Redelivery of the same job: the pre-gate short-circuits, engine not re-run.
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: m2.id },
    });
    expect(await spyWorker.tick('batch-2')).toBe(1);
    expect(resumeCalls).toBe(1);

    // A stale job for an already-drained OLDER reply drains an empty batch — also a no-op.
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: randomUUID() },
    });
    expect(await spyWorker.tick('batch-3')).toBe(1);
    expect(resumeCalls).toBe(1);
  });
  test('batch drain applies every explicit lifecycle command in order instead of dropping older intent', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `commands-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'Mark this incident mitigated: traffic shifted to the healthy region.',
      originSurface: 'slack',
    });
    const resolved = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'Resolve this incident: recovery was verified.',
      originSurface: 'slack',
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: resolved.id },
    });
    expect(await __fixture.worker.tick('lifecycle-command-batch')).toBe(1);

    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incId)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 2,
      lastResumeMessageId: resolved.id,
    });
    const transitions = (await __fixture.hub.history(__fixture.tenantId, incId)).filter(
      (message) => message.kind === 'lifecycle',
    );
    expect(transitions).toEqual([
      expect.objectContaining({ lifecycleFrom: 'open', lifecycleTo: 'mitigated' }),
      expect.objectContaining({ lifecycleFrom: 'mitigated', lifecycleTo: 'resolved' }),
    ]);
  });
  test('batch drain applies lifecycle intent and still answers the newest ordinary message', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `mixed-command-${randomUUID()}`,
      alertSource: 'slack',
      service: 'payments',
      severity: 'sev2',
    });
    await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'Mark this incident mitigated: traffic shifted to the healthy region.',
      originSurface: 'slack',
    });
    const question = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'What do the latest logs show?',
      originSurface: 'slack',
    });
    const resume = vi.fn(async (input: ResumeInput): Promise<TriageResult> => {
      expect(input.incident).toMatchObject({ id: incId });
      expect(input.humanMessage).toBe('What do the latest logs show?');
      return {
        provider: 'fake',
        sessionId: `fake:${incId}`,
        outcome: 'conclusive',
        turnBudget: 1,
        disposition: 'reply',
        summary: 'The latest logs show recovery.',
        detail: 'The latest logs show recovery.',
        confidence: 80,
      };
    });
    const mixedWorker = __fixture.workerWithEngine({
      provider: 'fake',
      async investigate() {
        throw new Error('not used');
      },
      resume,
      verifyRecovery: __fixture.verifyRecovery,
    });

    await mixedWorker.handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'resume',
        attempts: 1,
        payload: { incidentId: incId, humanMessageId: question.id },
      },
      { signal: new AbortController().signal },
    );

    expect(resume).toHaveBeenCalledTimes(1);
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incId)).toMatchObject({
      status: 'mitigated',
      lifecycleVersion: 1,
      lastResumeMessageId: question.id,
    });
  });
  test.each([
    ['gathering', 'clarification_request'],
    ['degraded', 'degraded_reask'],
  ] as const)(
    'records a human-information demand at its production source from %s',
    async (status, kind) => {
      const { id: incidentId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
        fingerprint: `toil-${status}-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev3',
      });
      await setInvestigationStatus(__fixture.app.db, __fixture.tenantId, incidentId, status);
      const human = await __fixture.hub.append(__fixture.tenantId, incidentId, {
        author: 'human',
        authorUserId: __fixture.actorUserId,
        content: 'Please continue.',
        originSurface: 'slack',
      });
      const worker = __fixture.workerWithEngine({
        provider: 'fake',
        async investigate() {
          throw new Error('not used');
        },
        async resume(): Promise<TriageResult> {
          return {
            provider: 'fake',
            sessionId: `fake:${incidentId}`,
            outcome: 'conclusive',
            turnBudget: 1,
            disposition: 'reply',
            replyPurpose: 'clarification_request',
            summary: 'Region required.',
            detail: 'Which production region is affected?',
            confidence: 0,
          };
        },
        verifyRecovery: __fixture.verifyRecovery,
      });

      await worker.handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'resume',
          attempts: 1,
          payload: { incidentId, humanMessageId: human.id },
        },
        { signal: new AbortController().signal },
      );

      const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
      expect(history).toContainEqual(
        expect.objectContaining({
          author: 'agent',
          kind,
          content: 'Which production region is affected?',
        }),
      );
    },
  );

  // Terminal follow-ups preserve the accepted assessment while still answering the responder.

  test('a resume-produced rca does not overwrite a RESOLVED incident RCA, still answers, and still advances the watermark', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    // The root cause the incident was resolved on.
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, incId, {
      provider: 'claude',
      sessionId: 'claude:orig',
      summary: 'ORIGINAL RCA: bad config push',
      confidence: 60,
      rankedHypotheses: [
        { hypothesis: 'bad config push', confidence: 60, evidence: 'deploy window overlaps' },
      ],
      engineModel: 'claude-opus-4-8',
    });
    await __fixture.setLifecycle(__fixture.tenantId, incId, 'resolved');
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'what was the root cause again?',
    });
    // Weeks later the engine answers, and re-decides the RCA at 10% confidence off a thin transcript.
    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'r237c13',
          name: 'report_findings',
          input: {
            outcome: 'conclusive',
            summary: 'LATE RCA: something else entirely',
            confidence: 10,
            rankedHypotheses: [{ hypothesis: 'something else', confidence: 10, evidence: 'none' }],
          },
        },
      ],
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await claudeWorkerFor({ messages: { create } }).tick('resume-237-c13')).toBe(1);

    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    // The finished investigation's record survives, whole: summary, confidence AND hypotheses.
    expect(inc?.rcaSummary).toBe('ORIGINAL RCA: bad config push');
    expect(inc?.confidence).toBe(60);
    expect(inc?.rankedHypotheses).toEqual([
      { hypothesis: 'bad config push', confidence: 60, evidence: 'deploy window overlaps' },
    ]);
    expect(inc?.status).toBe('resolved');

    // Preserving the assessment must not silence the answer.
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    const lateFinding = history.find(
      (message) => message.kind === 'finding' && message.content.includes('LATE RCA'),
    );
    expect(lateFinding?.finding).toMatchObject({
      promotion: 'not_promoted',
      promotionReason: 'terminal_incident',
    });

    // The watermark still prevents duplicate investigation on redelivery.
    expect(inc?.lastResumeMessageId).toBe(humanMsg.id);
  });

  test('a resume on a NON-resolved incident still records the rca exactly as today', async () => {
    // The no-regression half: the guard is scoped to resolved incidents, and nothing else moves.
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: '237c14: any update?',
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    // The module-level fake engine's resume() returns an rca threading the human reply into the summary.
    expect(await __fixture.worker.tick('resume-237-c14')).toBe(1);

    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    expect(inc?.rcaSummary).toContain('237c14: any update?');
    expect(inc?.confidence).toBe(55);
    expect(inc?.lastResumeMessageId).toBe(humanMsg.id);
    // An open incident is still pulled into the active set by the reply — that half is unchanged.
    expect(inc).toMatchObject({ status: 'open', investigationStatus: 'assessed' });
  });

  test('a resume on a RESOLVED incident yielding `reply` advances the watermark and does not reopen', async () => {
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
      content: 'why did this happen?',
    });
    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'r237c15',
          name: 'respond',
          input: {
            summary: `Per ${INTERNAL_REFERENCE}, the deploy did it`,
            detail: `The 09:14 deploy to checkout introduced the regression. Per ${INTERNAL_REFERENCE} I will not apply the rollback.`,
          },
        },
      ],
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await claudeWorkerFor({ messages: { create } }).tick('resume-237-c15')).toBe(1);

    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    const reply = history.find((m) => m.kind === 'reply');
    expect(reply?.content).toContain('09:14 deploy');
    expect(reply?.content).toContain(INTERNAL_REFERENCE);
    expect(reply?.summary).toBe(`Per ${INTERNAL_REFERENCE}, the deploy did it`);
    expect(reply?.finding).toMatchObject({
      promotion: 'conversation_only',
      promotionReason: 'responder_reply',
    });
    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    // The answer lands, lifecycle stays resolved, and the watermark makes redelivery a clean no-op.
    expect(inc?.status).toBe('resolved');
    expect(inc?.lastResumeMessageId).toBe(humanMsg.id);
  });
});
