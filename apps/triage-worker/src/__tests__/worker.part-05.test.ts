import { afterEach, describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { applyTriageResult, createIncident, getIncident, jobs } from '@sre/db';

import { makeDbAuditSink } from '@sre/agent-tools';

import { makeClaudeEngine } from '../engine/claude';

import { ELISION_MARKER, TriageWorker, splitResumeInput, transcriptBudgetChars } from '../worker';
import { modelPrior } from '../worker/transcript';

import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('splitResumeInput', () => {
  test.each([
    ['escaped opener', '\n'.repeat(13_000), 24_000, true],
    ['escaped prior', '\n'.repeat(13_000), 24_000, false],
    ['larger opener budget', 'x'.repeat(25_000), 100_000, true],
    ['larger prior budget', 'x'.repeat(25_000), 100_000, false],
  ] as const)(
    'rejected human input stays out of model context: %s',
    (_name, content, budget, pin) => {
      const oversized = __fixture.msg('old', 'human', content);
      const target = __fixture.msg('new', 'human', 'Check current state');
      const input = splitResumeInput([oversized, target], target.id, {
        opener: pin ? oversized : null,
        budget,
      });
      expect(input?.humanMessage).toBe('Check current state');
      expect(input?.prior).toEqual([ELISION_MARKER]);
      expect(modelPrior([oversized, target])).toEqual([
        ELISION_MARKER,
        { author: target.author, kind: target.kind, content: target.content },
      ]);
      expect(JSON.stringify(input)).not.toContain(JSON.stringify(content).slice(1, -1));
    },
  );
  test('an external oversized opener is omitted with one explicit elision marker', () => {
    const opener = __fixture.msg('old', 'human', 'x'.repeat(100));
    const target = __fixture.msg('new', 'human', 'Check current state');
    const input = splitResumeInput([target], target.id, { opener, budget: 40 });
    expect(input?.humanMessage).toBe('Check current state');
    expect(input?.prior).toEqual([ELISION_MARKER]);
    expect(JSON.stringify(input)).not.toContain('x'.repeat(100));
  });
  test('splits out the target human message and keeps the rest, in order, as prior', () => {
    const history = [
      __fixture.msg('1', 'agent', 'initial finding'),
      __fixture.msg('2', 'human', 'reply A'),
      __fixture.msg('3', 'agent', 'note'),
    ];
    const r = splitResumeInput(history, '2');
    expect(r?.humanMessage).toBe('reply A');
    // The target is excluded from prior (so it does not appear twice in the resume prompt).
    expect(r?.prior.map((p) => p.content)).toEqual(['initial finding', 'note']);
  });

  test('humanMessageId is required — the latest-human fallback is gone', () => {
    // The fallback (guess the newest human message when no id was given) is removed: handleResume always
    // passes the newest drained reply id. The directive below pins the tightening — if `| undefined` is
    // ever re-added to the signature, undefined becomes valid, the suppression goes unused, and tsc fails.
    // @ts-expect-error humanMessageId is required; undefined is no longer accepted.
    expect(splitResumeInput([__fixture.msg('1', 'human', 'x')], undefined)).toBeNull();
  });

  test('returns null when the target message is gone', () => {
    expect(splitResumeInput([__fixture.msg('1', 'agent', 'x')], 'missing')).toBeNull();
  });

  // bound the resume transcript. New opts arg: { opener?, budget? }.

  test('drops status and silent messages from prior', () => {
    const history = [
      __fixture.msgK('1', 'agent', 'finding', 'root cause candidate'),
      __fixture.msgK('2', 'system', 'status', 'investigating'),
      __fixture.msgK('3', 'agent', 'silent', 'internal note'),
      __fixture.msgK('4', 'agent', 'text', 'follow-up'),
      __fixture.msgK('5', 'human', 'text', 'the trigger'),
    ];
    const r = splitResumeInput(history, '5', { budget: 10_000 });
    const contents = r?.prior.map((p) => p.content) ?? [];
    expect(contents).not.toContain('investigating');
    expect(contents).not.toContain('internal note');
    expect(contents).toEqual(['root cause candidate', 'follow-up']);
  });

  test('budget fills newest-first, keeps included messages ascending, omits older ones', () => {
    // Five prior agent messages, each content length 5, then the target human message.
    const history = [
      __fixture.msgK('1', 'agent', 'text', 'aaaaa'),
      __fixture.msgK('2', 'agent', 'text', 'bbbbb'),
      __fixture.msgK('3', 'agent', 'text', 'ccccc'),
      __fixture.msgK('4', 'agent', 'text', 'ddddd'),
      __fixture.msgK('5', 'agent', 'text', 'eeeee'),
      __fixture.msgK('6', 'human', 'text', 'trigger'),
    ];
    // Budget 12: newest-first fits eeeee (5) + ddddd (10); ccccc (15) would exceed → omitted.
    const r = splitResumeInput(history, '6', { budget: 12 });
    const kept = (r?.prior ?? [])
      .filter((p) => p.content !== ELISION_MARKER.content)
      .map((p) => p.content);
    expect(kept).toEqual(['ddddd', 'eeeee']); // ascending
    expect(kept).not.toContain('aaaaa');
    expect(kept).not.toContain('bbbbb');
    expect(kept).not.toContain('ccccc');
  });

  test('inserts exactly one elision marker after the opener when the budget trims', () => {
    const history = [
      __fixture.msgK('0', 'agent', 'text', 'OP'),
      __fixture.msgK('1', 'agent', 'text', 'm1'),
      __fixture.msgK('2', 'agent', 'text', 'm2'),
      __fixture.msgK('3', 'agent', 'text', 'm3'),
      __fixture.msgK('4', 'human', 'text', 'trigger'),
    ];
    const opener = history[0]!;
    // Budget 5: opener 'OP' (2) pinned, newest-first fits m3 (4 total); m2 (6) would exceed → trim.
    const r = splitResumeInput(history, '4', { opener, budget: 5 });
    const prior = r?.prior ?? [];
    const markers = prior.filter((p) => p.content === ELISION_MARKER.content);
    expect(markers).toHaveLength(1);
    expect(prior[0]).toEqual({ author: opener.author, kind: opener.kind, content: opener.content });
    expect(prior[1]).toEqual(ELISION_MARKER);
    expect(prior[prior.length - 1]?.content).toBe('m3');
  });

  test('pins the opener first even when it is outside history, but never when it is the target', () => {
    const history = [
      __fixture.msgK('1', 'agent', 'text', 'kept finding'),
      __fixture.msgK('2', 'human', 'text', 'trigger'),
    ];
    // Opener that fell outside the newest window (not present in `history`).
    const opener = __fixture.msgK('0', 'agent', 'text', 'the very first message');
    const r = splitResumeInput(history, '2', { opener, budget: 10_000 });
    expect(r?.prior[0]).toEqual({
      author: opener.author,
      kind: opener.kind,
      content: opener.content,
    });
    // The openerGap path fires (opener predates the window) even though nothing was budget-trimmed:
    // exactly one marker, positioned right after the pinned opener.
    const gapMarkers = (r?.prior ?? []).filter((p) => p.content === ELISION_MARKER.content);
    expect(gapMarkers).toHaveLength(1);
    expect(r?.prior[1]).toEqual(ELISION_MARKER);

    // When the supplied opener IS the target, it must not be pinned (target is never in prior).
    const target = history[1];
    const r2 = splitResumeInput(history, '2', { opener: target, budget: 10_000 });
    expect(r2?.prior.map((p) => p.content)).toEqual(['kept finding']);
    expect(r2?.prior.map((p) => p.content)).not.toContain('trigger');
  });

  test('short incident under a large budget: all non-excluded messages, no elision marker', () => {
    const history = [
      __fixture.msgK('1', 'agent', 'text', 'one'),
      __fixture.msgK('2', 'agent', 'text', 'two'),
      __fixture.msgK('3', 'agent', 'text', 'three'),
      __fixture.msgK('4', 'human', 'text', 'trigger'),
    ];
    const r = splitResumeInput(history, '4', { budget: 10_000 });
    expect(r?.prior.map((p) => p.content)).toEqual(['one', 'two', 'three']);
    expect(r?.prior.some((p) => p.content === ELISION_MARKER.content)).toBe(false);
  });

  test('default budget (no opts) on a small history includes everything with no marker', () => {
    const history = [
      __fixture.msgK('1', 'agent', 'text', 'alpha'),
      __fixture.msgK('2', 'agent', 'text', 'beta'),
      __fixture.msgK('3', 'human', 'text', 'trigger'),
    ];
    const r = splitResumeInput(history, '3', {});
    expect(r?.prior.map((p) => p.content)).toEqual(['alpha', 'beta']);
    expect(r?.prior.some((p) => p.content === ELISION_MARKER.content)).toBe(false);
  });

  test('does not pin an opener of an excluded kind, and inserts no marker', () => {
    const history = [
      __fixture.msgK('1', 'agent', 'text', 'kept finding'),
      __fixture.msgK('2', 'human', 'text', 'trigger'),
    ];
    // A status banner is never valuable context; supplying it as the opener must not pin it.
    const opener = __fixture.msgK('0', 'system', 'status', 'banner');
    const r = splitResumeInput(history, '2', { opener, budget: 10_000 });
    expect(r?.prior[0]?.content).not.toBe('banner');
    expect(r?.prior.map((p) => p.content)).toEqual(['kept finding']);
    expect(r?.prior.some((p) => p.content === ELISION_MARKER.content)).toBe(false);
  });

  test('a row-cap-truncated read inserts exactly one marker even with no opener and no budget trim', () => {
    const history = [
      __fixture.msgK('1', 'agent', 'text', 'one'),
      __fixture.msgK('2', 'agent', 'text', 'two'),
      __fixture.msgK('3', 'human', 'text', 'trigger'),
    ];
    const r = splitResumeInput(history, '3', { truncated: true, budget: 10_000 });
    const markers = (r?.prior ?? []).filter((p) => p.content === ELISION_MARKER.content);
    expect(markers).toHaveLength(1);
    // The tail is untouched; only the truncation signal was added.
    expect(
      r?.prior.filter((p) => p.content !== ELISION_MARKER.content).map((p) => p.content),
    ).toEqual(['one', 'two']);
  });
});

describe('transcriptBudgetChars env guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('reads a valid positive env value', () => {
    vi.stubEnv('TRANSCRIPT_BUDGET_CHARS', '48000');
    expect(transcriptBudgetChars()).toBe(48000);
  });

  test('falls back to the default for 0, negative, non-numeric, or unset', () => {
    vi.stubEnv('TRANSCRIPT_BUDGET_CHARS', '0');
    expect(transcriptBudgetChars()).toBe(24000);
    vi.stubEnv('TRANSCRIPT_BUDGET_CHARS', '-5');
    expect(transcriptBudgetChars()).toBe(24000);
    vi.stubEnv('TRANSCRIPT_BUDGET_CHARS', 'notanumber');
    expect(transcriptBudgetChars()).toBe(24000);
    vi.unstubAllEnvs();
    delete process.env.TRANSCRIPT_BUDGET_CHARS;
    expect(transcriptBudgetChars()).toBe(24000);
  });
});

describe('TriageWorker resume', () => {
  test('a resume job continues the investigation, building on the prior transcript', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    // Prior transcript: an initial finding, then a human follow-up (the resume trigger).
    await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'agent',
      kind: 'finding',
      content: 'Initial RCA: suspected deploy.',
    });
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'What about the DB pool?',
    });

    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'r1',
          name: 'report_findings',
          input: {
            outcome: 'conclusive',
            summary: 'DB pool exhaustion confirmed',
            confidence: 82,
            rankedHypotheses: [],
          },
        },
      ],
    });
    const resumeWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, { messages: { create } }),
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });

    // Spy the transcript reads to lock the bounded-read wiring: a row-capped history and an
    // opener fetch feed splitResumeInput. spyOn calls through, so behavior is unchanged.
    const historySpy = vi.spyOn(__fixture.hub, 'history');
    const openerSpy = vi.spyOn(__fixture.hub, 'opener');

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await resumeWorker.tick('resume-1')).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);

    // handleResume reads the newest-N transcript (TRANSCRIPT_MAX_ROWS = 500) and the incident opener.
    expect(historySpy).toHaveBeenCalledWith(__fixture.tenantId, incId, { limit: 500 });
    expect(openerSpy).toHaveBeenCalledWith(__fixture.tenantId, incId);
    historySpy.mockRestore();
    openerSpy.mockRestore();

    // The engine saw the human reply AND the prior finding (splitResumeInput fed the session).
    const seed = (create.mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages[0]!
      .content;
    expect(seed).toContain('What about the DB pool?');
    expect(seed).toContain('Initial RCA');

    // The resumed conclusion persisted, and a new finding streamed to the hub.
    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    expect(inc?.rcaSummary).toContain('DB pool exhaustion');
    expect(inc?.confidence).toBe(82);
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(
      history.some((m) => m.kind === 'finding' && m.content.includes('DB pool exhaustion')),
    ).toBe(true);
  });

  test('serializes per incident: a resume redelivers while the lock is held, then runs once free', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'ping',
    });
    // Simulate an in-flight run for this incident by holding the lock.
    const heldToken = await __fixture.engineLock.acquire(incId);
    expect(heldToken).toBeTruthy();

    const create = vi.fn();
    const resumeWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, { messages: { create } }),
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });
    const jobId = await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });

    // Lock held → RetryableError → re-queued (not dead), engine never ran.
    await __fixture.queue.process(
      'resume-2',
      (j) => resumeWorker.handle(j, { signal: new AbortController().signal }),
      { idleMs: 0 },
    );
    expect(create).not.toHaveBeenCalled();
    expect(
      (await __fixture.admin.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.status,
    ).toBe('queued');

    // Release the lock → the redelivery now runs the resume.
    await __fixture.engineLock.release(incId, heldToken!);
    create.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'r',
          name: 'report_findings',
          input: {
            outcome: 'conclusive',
            summary: 'done after lock freed',
            confidence: 60,
            rankedHypotheses: [],
          },
        },
      ],
    });
    await __fixture.queue.process(
      'resume-2',
      (j) => resumeWorker.handle(j, { signal: new AbortController().signal }),
      { idleMs: 0 },
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect((await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.rcaSummary).toContain(
      'done after lock freed',
    );
  });

  // Resolved means the operational case is filed, not that the conversation is closed.
  test('a resume on a RESOLVED incident runs the engine and answers in the thread; C12 it stays resolved', async () => {
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
      content: 'reopen?',
    });

    const create = vi.fn().mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'r237',
          name: 'report_findings',
          input: {
            outcome: 'conclusive',
            summary: 'answered after resolution',
            confidence: 60,
            rankedHypotheses: [],
          },
        },
      ],
    });
    const resumeWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, { messages: { create } }),
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
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await resumeWorker.tick('resume-3')).toBe(1);

    // The engine ran, and the answer reached the thread the human asked in.
    expect(create).toHaveBeenCalled();
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(
      history.some((m) => m.author === 'agent' && m.content.includes('answered after resolution')),
    ).toBe(true);
    // Answering is not reopening. 'resolved' is terminal — a human's resolution outranks anything
    // the engine says afterwards (option B) — and the clamp is what holds it, not the gate.
    expect((await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.status).toBe(
      'resolved',
    );
  });

  // The module-level `worker` uses makeFakeEngine, whose resume() streams ONE finding
  // ("Reviewed the human reply and re-checked <service>: <humanMessage>") via onStep and returns
  // summary "After the human reply, still likely a recent change to <service>" (confidence 55).
  test('a redelivered resume for the same human message does not produce a second answer (exactly-once)', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const humanText = '115a: is the DB pool exhausted?';
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: humanText,
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await __fixture.worker.tick('resume-115a-1')).toBe(1);

    // Crash-then-redelivery of a COMPLETED resume: the SAME payload is delivered again.
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    await __fixture.worker.tick('resume-115a-2');

    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    // Without the watermark pre-gate the redelivered resume re-streams the finding via onStep and
    // re-applies it, leaving TWO findings.
    expect(
      history.filter((m) => m.kind === 'finding' && m.content.includes(humanText)).length,
    ).toBe(1);
  });

  test('a late triage does not overwrite a resume RCA', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: '115b: what about the cache?',
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await __fixture.worker.tick('resume-115b')).toBe(1);
    // The resume RCA is now the fake resume summary.
    expect((await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.rcaSummary).toContain(
      'still likely a recent change',
    );

    // A late triage completion for the same incident — no resumeMessageId (that is the Phase-B column).
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, incId, {
      provider: 'claude',
      sessionId: 'late',
      summary: 'LATE TRIAGE root cause',
      confidence: 10,
    });

    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, incId);
    // Without the watermark pre-gate applyTriageResult is blind last-writer-wins, so the late triage
    // overwrites the resume RCA.
    expect(inc?.rcaSummary).toContain('still likely a recent change');
    expect(inc?.rcaSummary).not.toContain('LATE TRIAGE');
  });

  test('a resume for a NEW human message still applies (must not over-block)', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const text1 = '115c: first reply about the DB pool';
    const humanMsg1 = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: text1,
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg1.id },
    });
    expect(await __fixture.worker.tick('resume-115c-1')).toBe(1);

    const text2 = '115c: second reply about the cache layer';
    const humanMsg2 = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: text2,
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg2.id },
    });
    expect(await __fixture.worker.tick('resume-115c-2')).toBe(1);

    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    // GREEN today: a distinct finding per human message — the newer reply still gets its own answer.
    // Guards the Phase-B fix against over-blocking legitimately-new resumes.
    expect(history.some((m) => m.kind === 'finding' && m.content.includes(text1))).toBe(true);
    expect(history.some((m) => m.kind === 'finding' && m.content.includes(text2))).toBe(true);
    expect((await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.rcaSummary).toContain(
      'still likely a recent change',
    );
  });
});
