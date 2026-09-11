import { describe, expect, test, vi } from 'vitest';

import { SurfaceRegistry } from '@sre/surfaces';

import type { HubMessage } from '@sre/hub';

import { fanoutHubMessage } from '../fanout';

import { createFixture } from './fanout.fixture';

const __fixture = createFixture();

describe('fanoutHubMessage', () => {
  // --- Cross-surface sync-back regression: dashboard → hub → Slack. ---
  // Locks the invariant that a human reply typed on the dashboard fans out to the BOUND Slack thread,
  // while echo-suppression stays origin-scoped (a slack-origin message is NOT re-posted to slack).

  test('C1: a dashboard-origin human text posts into the bound Slack thread (not suppressed)', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);

    // The incident's Slack thread (channel:root_ts) is where the dashboard reply lands.
    await fanoutHubMessage(
      __fixture.baseDeps({ registry }),
      __fixture.msg({
        author: 'human',
        kind: 'text',
        content: 'db is down',
        originSurface: 'dashboard',
      }),
    );

    expect(posts).toHaveLength(1); // dashboard-origin != slack, so it fans out to slack
    expect(posts[0]!.thread).toBe(__fixture.BOUND_THREAD); // targets the incident's bound thread
    expect(posts[0]!.msg.content).toBe('db is down'); // human content posted verbatim
  });

  test('C2: echo-suppression is origin-scoped — dashboard-origin posts to slack, slack-origin does not', async () => {
    const dashboardOrigin = __fixture.fakePoster('slack');
    const reg1 = new SurfaceRegistry();
    reg1.register(dashboardOrigin.poster);
    await fanoutHubMessage(
      __fixture.liveDeps(reg1),
      __fixture.msg({
        author: 'human',
        kind: 'text',
        content: 'from the web',
        originSurface: 'dashboard',
      }),
    );
    expect(dashboardOrigin.posts).toHaveLength(1); // a different origin: mirrored to slack

    const slackOrigin = __fixture.fakePoster('slack');
    const reg2 = new SurfaceRegistry();
    reg2.register(slackOrigin.poster);
    await fanoutHubMessage(
      __fixture.liveDeps(reg2, { listDeliveryTargets: async () => [] }),
      __fixture.msg({
        author: 'human',
        kind: 'text',
        content: 'from slack',
        originSurface: 'slack',
      }),
    );
    expect(slackOrigin.posts).toHaveLength(0); // same origin: suppressed (no echo back)
  });

  test('C3: a human text posts fresh each turn into the incident\u2019s thread (plain threaded post, not the agent working-post)', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const deps = __fixture.liveDeps(registry);

    await fanoutHubMessage(
      deps,
      __fixture.msg({
        id: 'h1',
        author: 'human',
        kind: 'text',
        content: 'first',
        originSurface: 'dashboard',
      }),
    );
    await fanoutHubMessage(
      deps,
      __fixture.msg({
        id: 'h2',
        author: 'human',
        kind: 'text',
        content: 'second',
        originSurface: 'dashboard',
      }),
    );

    expect(posts).toHaveLength(2); // each human turn is its own post
    expect(updates).toHaveLength(0); // never edits a working post (that is the agent-narration path)
    expect(posts.map((p) => p.msg.content)).toEqual(['first', 'second']); // content preserved
    expect(posts[0]!.msg.summary).toBeUndefined(); // not rewritten to a "🔍 …" activity line
    // Both turns reply under the SAME bound thread — the conversation the alert arrived in.
    expect(posts.map((p) => p.thread)).toEqual([__fixture.BOUND_THREAD, __fixture.BOUND_THREAD]);
  });

  // --- author attribution for dashboard human replies synced to Slack. ---
  // Fan-out resolves a display label for authorUserId and stamps it transiently on the outbound message.
  test('resolves and stamps authorLabel from the reply authorUserId onto the fanned-out message', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const resolveAuthorLabel = vi.fn(
      async (_tenantId: string, userId: string | null | undefined) =>
        userId === 'u1' ? 'jane.doe' : null,
    );
    const deps = { ...__fixture.baseDeps({ registry }), resolveAuthorLabel };

    await fanoutHubMessage(
      deps,
      __fixture.msg({
        author: 'human',
        kind: 'text',
        content: 'db is down',
        originSurface: 'dashboard',
        authorUserId: 'u1',
      }),
    );

    expect(posts).toHaveLength(1);
    const posted = posts[0]!.msg as HubMessage & { authorLabel?: string | null };
    expect(posted.authorLabel).toBe('jane.doe'); // resolved label rides the message to the poster
    expect(resolveAuthorLabel).toHaveBeenCalledWith('t1', 'u1'); // tenant-scoped call site pinned
  });
});
