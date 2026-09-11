import { type IncidentSignal } from '@sre/alerts';

import { describe, expect, test, vi } from 'vitest';

// hermetic behavior tests for in-context correlation in the classify consumer.
// The consumer builds a candidate open-incident set (listActiveIncidents; retrieveNearestActive over
// CAP_N), runs the correlation classifier, and resolves the verdict:
//   not_worthy   -> ack
//   belongs_to   -> append + coalesced resume; bot alerts also bump recurrence
//                   to the hub + enqueues a resume
//   new_incident -> route a NEW structural-fingerprint incident, persist title, best-effort embed seed
// The repo shortlist fns are mocked so these stay hermetic (no live PG). RED now: the consumer still
// runs the {worthy} classifier and never builds candidates / resolves a correlation verdict.
vi.mock('@sre/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    lookupSurfaceIdentity: vi.fn(async () => null),
    listActiveIncidents: vi.fn(),
    retrieveNearestActive: vi.fn(),
    setIncidentEmbedding: vi.fn(async () => undefined),
    bumpIncidentOccurrenceOnce: vi.fn(async () => true),
    getBindingByIncident: vi.fn(),
    recordSurfaceBinding: vi.fn(async (_tx, _tenantId, input) => ({
      id: 'source-binding',
      incidentId: input.incidentId,
      channel: input.channel,
      threadId: input.threadId,
      externalId: `${input.channel}:${input.threadId}`,
      role: input.role ?? 'primary',
    })),
    activateSurfaceBinding: vi.fn(async (_tx, _tenantId, _surface, _incidentId, bindingId) => ({
      id: bindingId,
    })),
    withTenant: vi.fn(async (exec, _tenantId, fn) => fn(exec)),
  };
});

import { createFixture } from './classify-consumer.correlation.fixture';

const __fixture = createFixture();

describe('mention correlation', () => {
  test('C4 cross-thread belongs_to: breadcrumb to the human thread + resume; NO rebind, NO new incident', async () => {
    const { handler, route, appendOnce, enqueueResume, post } = __fixture.setupMention({
      verdict: { decision: 'belongs_to', index: 1 },
      active: [__fixture.summary({ id: 'inc-T', title: 'target' })],
      // The target incident is bound to a DIFFERENT thread than the human's mention thread.
      binding: { externalId: 'C-other:8888.0000' },
    });

    await expect(
      handler({
        id: 'jm',
        tenantId: 'tenant-1',
        type: 'classify',
        attempts: 1,
        payload: __fixture.makeMentionPayload(),
      }),
    ).resolves.toBeUndefined();

    // Consolidate in the canonical thread (append) + wake the engine.
    expect(
      appendOnce.mock.calls.filter((call) => (call[2] as { author: string }).author === 'human'),
    ).toHaveLength(1);
    expect(appendOnce.mock.calls[0]![1]).toBe('inc-T');
    expect(enqueueResume).toHaveBeenCalledWith('tenant-1', 'inc-T', 'hub-m1-2');
    // No rebind, no new incident.
    expect(route).not.toHaveBeenCalled();
    // A breadcrumb is posted to the human's thread (detached best-effort), addressed structurally.
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![1]).toEqual({
      channel: __fixture.M_CHANNEL,
      threadId: __fixture.M_ROOT_TS,
    });
  });

  test('C4 same-thread belongs_to: resume only, no breadcrumb, no rebind, no new incident', async () => {
    const { handler, route, appendOnce, enqueueResume, post } = __fixture.setupMention({
      verdict: { decision: 'belongs_to', index: 1 },
      active: [__fixture.summary({ id: 'inc-T', title: 'target' })],
      binding: { externalId: `${__fixture.M_CHANNEL}:${__fixture.M_ROOT_TS}` }, // same as the human's thread
    });

    await expect(
      handler({
        id: 'jm',
        tenantId: 'tenant-1',
        type: 'classify',
        attempts: 1,
        payload: __fixture.makeMentionPayload(),
      }),
    ).resolves.toBeUndefined();

    expect(
      appendOnce.mock.calls.filter((call) => (call[2] as { author: string }).author === 'human'),
    ).toHaveLength(1);
    expect(enqueueResume).toHaveBeenCalledWith('tenant-1', 'inc-T', 'hub-m1-2');
    expect(post).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  test('C6 a hallucinated index (mention) falls back to a new_incident on channel:root_ts', async () => {
    const { handler, route, enqueueResume, post } = __fixture.setupMention({
      verdict: { decision: 'belongs_to', index: 99 }, // out of the 1-incident candidate set
      active: [__fixture.summary({ id: 'inc-T', title: 'target' })],
    });

    await expect(
      handler({
        id: 'jm',
        tenantId: 'tenant-1',
        type: 'classify',
        attempts: 1,
        payload: __fixture.makeMentionPayload(),
      }),
    ).resolves.toBeUndefined();

    // No attach (no resume), no breadcrumb: the bad index fell through to a NEW incident on the mention
    // fingerprint, mirroring the push C6 fallback.
    expect(enqueueResume).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]![0].fingerprint).toBe(__fixture.mentionFingerprint);
    // The mention's own thread is the incident's origin: channel + thread root, bound in-tx.
    expect(route.mock.calls[0]![0].origin).toEqual({
      surface: 'slack',
      channel: __fixture.M_CHANNEL,
      threadId: __fixture.M_ROOT_TS,
    });
  });

  test('C10 the mention transcript is secret-scrubbed before the embedder (new_incident seed)', async () => {
    const SECRET = 'sk-abcdefghijklmnopqrstuvwx1234';
    const { handler } = __fixture.setupMention({
      verdict: { decision: 'new_incident', service: 'checkout', severity: 'sev2', title: 't' },
      readText: `checkout is on fire ${SECRET}`,
    });

    await handler({
      id: 'jm',
      tenantId: 'tenant-1',
      type: 'classify',
      attempts: 1,
      payload: __fixture.makeMentionPayload(),
    });

    // The seed the local embedder received is scrubbed (criterion 10, mention path).
    const embeddedTexts = __fixture.embedSpy.mock.calls.flatMap((c) => c[0]);
    expect(embeddedTexts.length).toBeGreaterThan(0);
    expect(embeddedTexts.join(' ')).not.toContain(SECRET);
  });

  // --- a hallucinated index on a thread that is ALREADY under investigation -----------------
  // C6 above pins the fallback: a bad index opens a new incident on the mention fingerprint. But that
  // fingerprint is `slack:{channel}:{rootTs}` — thread-derived — so when the thread's own incident is
  // still ACTIVE the funnel creates nothing: it REUSES that incident and finds its binding already
  // there. What the human gets today depends only on the owner's triage job:
  //   (a) still 'queued'   -> the funnel's second job insert hits jobs_resume_coalesce_idx -> 23505 ->
  //                           the mention dead-letters and the question is never answered.
  //   (b) has left 'queued' -> no collision, so a SECOND triage job investigates the same incident, the
  //                           transcript seed line is appended a second time, and the human's message is
  //                           attached nowhere at all. Silent.
  // One root cause: the funnel reports reuse as if it were a create. Once it says `reused`, the thread is
  // already under investigation and the mention is an ATTACH — which is exactly what onThreadTaken
  // already does for the case where the binding happened to be visible in time.
  //
  // route() is a double here, so this models the FIXED funnel's contract; C3 (outcome (a), the owner
  // still 'queued') and its sibling (outcome (b), the owner past it) in packages/alerts/src/__tests__/route-to-incident.test.ts
  // pin that contract against a real Postgres. (a) and (b) diverge only INSIDE the funnel, and the double
  // erases that difference by construction: both hand this consumer the same `reused:true`. So there is
  // one consumer test, not two: what it pins is that a reused owner means ATTACH, whatever the owner's job
  // status. The distinction is observable only at the funnel, which is where C3/C3b live.

  test('a reused owner attaches the human instead of seeding a second investigation: no duplicate seed line, no re-seeded embedding', async () => {
    const routed: IncidentSignal[] = [];
    const { handler, appendOnce, enqueueResume, append } = __fixture.setupMention({
      verdict: { decision: 'belongs_to', index: 99 }, // out of the 1-incident candidate set
      active: [__fixture.summary({ id: 'inc-T', title: 'target' })],
      // The owner is ACTIVE and already bound to this very thread, so the funnel reuses it, finds the
      // binding pre-existing, asks for no second job (and raises no 23505) and reports the reuse.
      routeImpl: async (s) => {
        routed.push(s);
        return { deduped: false, incidentId: 'inc-T', reused: true };
      },
    });

    // No dead-letter: the handler completes instead of rethrowing the funnel's 23505.
    await expect(
      handler({
        id: 'jm',
        tenantId: 'tenant-1',
        type: 'classify',
        attempts: 1,
        payload: __fixture.makeMentionPayload(),
      }),
    ).resolves.toBeUndefined();

    // The seed half of the open path must not run on an incident that was reused: today it re-appends
    // "Human-initiated via @mention. Prior thread:..." to a thread that already carries it, and re-seeds
    // the embedding of an incident whose seed was written on occurrence.
    expect(append).not.toHaveBeenCalled();
    expect(__fixture.embedSpy).not.toHaveBeenCalled();
    // The human's question joins the incident that owns the thread, and wakes its engine.
    expect(
      appendOnce.mock.calls.filter((call) => (call[2] as { author: string }).author === 'human'),
    ).toHaveLength(1);
    expect(appendOnce.mock.calls[0]![1]).toBe('inc-T');
    expect(enqueueResume).toHaveBeenCalledWith('tenant-1', 'inc-T', 'hub-m1');
    // One pass through the funnel: the attach is not a re-route.
    expect(routed).toHaveLength(1);
  });

  test('new_incident mention: opens a NEW incident on the channel:root_ts fingerprint (existing open path)', async () => {
    const { handler, route } = __fixture.setupMention({
      verdict: {
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 'Checkout on fire',
      },
    });

    await expect(
      handler({
        id: 'jm',
        tenantId: 'tenant-1',
        type: 'classify',
        attempts: 1,
        payload: __fixture.makeMentionPayload(),
      }),
    ).resolves.toBeUndefined();

    expect(route).toHaveBeenCalledTimes(1);
    expect(route.mock.calls[0]![0].fingerprint).toBe(__fixture.mentionFingerprint);
    // The mention's own thread is the incident's origin: channel + thread root, bound in-tx.
    expect(route.mock.calls[0]![0].origin).toEqual({
      surface: 'slack',
      channel: __fixture.M_CHANNEL,
      threadId: __fixture.M_ROOT_TS,
    });
  });
});

describe('cross-thread breadcrumb deep-links the canonical thread', () => {
  test('C1 permalink: a cross-thread breadcrumb deep-links the canonical thread', async () => {
    const { handler, post, resolvePermalink, appendOnce } = __fixture.setupMention({
      verdict: { decision: 'belongs_to', index: 1 },
      active: [__fixture.summary({ id: 'inc-T', title: 'target' })],
      binding: __fixture.CANON_BINDING, // bound to a DIFFERENT thread than the human's mention thread
      resolvePermalink: async () => __fixture.PERMALINK,
    });

    await expect(handler(__fixture.mentionJob())).resolves.toBeUndefined();
    expect(appendOnce.mock.calls[0]![1]).toBe('inc-T'); // consolidated in the canonical incident

    const text = await __fixture.postedText(post);
    // The URL genuinely appears, wrapped as Slack mrkdwn `<url|text>` so it renders clickable.
    expect(text).toContain(__fixture.PERMALINK);
    const escaped = __fixture.PERMALINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(text).toMatch(new RegExp(`<${escaped}\\|[^>]+>`));

    // The breadcrumb still lands in the HUMAN's thread — the link is what points elsewhere.
    expect(post.mock.calls[0]![1]).toEqual({
      channel: __fixture.M_CHANNEL,
      threadId: __fixture.M_ROOT_TS,
    });
    // ...and the link was resolved from the CANONICAL binding, not the human's own thread. Passing the
    // human's channel/ts here would resolve a permalink to the thread they are already reading — a link
    // to nowhere that still looks correct in the message. Pin the direction.
    await vi.waitFor(() => expect(resolvePermalink).toHaveBeenCalled());
    expect(resolvePermalink).toHaveBeenCalledWith(
      'tenant-1',
      __fixture.CANON_CHANNEL,
      __fixture.CANON_TS,
    );
    expect(resolvePermalink).not.toHaveBeenCalledWith(
      'tenant-1',
      __fixture.M_CHANNEL,
      __fixture.M_ROOT_TS,
    );
  });

  test('C2 permalink unresolvable (resolver returns null): the generic breadcrumb STILL posts', async () => {
    const { handler, post, resolvePermalink } = __fixture.setupMention({
      verdict: { decision: 'belongs_to', index: 1 },
      active: [__fixture.summary({ id: 'inc-T', title: 'target' })],
      binding: __fixture.CANON_BINDING,
      resolvePermalink: async () => null, // e.g. Slack 200 with ok:false, or a revoked token
    });

    await expect(handler(__fixture.mentionJob())).resolves.toBeUndefined();

    expect(resolvePermalink).toHaveBeenCalledWith(
      'tenant-1',
      __fixture.CANON_CHANNEL,
      __fixture.CANON_TS,
    );
    __fixture.expectGeneric(await __fixture.postedText(post));
  });

  test('C2/C5 the permalink resolver THROWS: the generic breadcrumb still posts and the job completes', async () => {
    const { handler, post, resolvePermalink, appendOnce, enqueueResume } = __fixture.setupMention({
      verdict: { decision: 'belongs_to', index: 1 },
      active: [__fixture.summary({ id: 'inc-T', title: 'target' })],
      binding: __fixture.CANON_BINDING,
      resolvePermalink: async () => {
        throw new Error('slack chat.getPermalink 500');
      },
    });

    // A decorative lookup must never fail the classify job. Throwing here would NOT re-post the
    // human's message on redelivery — it would re-run the whole LLM characterize for a missing hyperlink.
    await expect(handler(__fixture.mentionJob())).resolves.toBeUndefined();

    expect(resolvePermalink).toHaveBeenCalledTimes(1);
    __fixture.expectGeneric(await __fixture.postedText(post));
    // The real work is untouched by the resolver blowing up.
    expect(
      appendOnce.mock.calls.filter((call) => (call[2] as { author: string }).author === 'human'),
    ).toHaveLength(1);
    expect(enqueueResume).toHaveBeenCalledWith('tenant-1', 'inc-T', 'hub-m1-2');
  });

  test('C3 no binding row: the generic breadcrumb posts and no permalink is attempted', async () => {
    const { handler, post, resolvePermalink } = __fixture.setupMention({
      verdict: { decision: 'belongs_to', index: 1 },
      active: [__fixture.summary({ id: 'inc-T', title: 'target' })],
      binding: undefined, // the incident is bound to no thread — there is nothing to link to
      resolvePermalink: async () => __fixture.PERMALINK, // would resolve, but must never be asked
    });

    await expect(handler(__fixture.mentionJob())).resolves.toBeUndefined();

    __fixture.expectGeneric(await __fixture.postedText(post));
    expect(resolvePermalink).not.toHaveBeenCalled();
  });
});
