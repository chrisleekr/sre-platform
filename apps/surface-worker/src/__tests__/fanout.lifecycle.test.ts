import { describe, expect, test, vi } from 'vitest';

import { SurfaceRegistry } from '@sre/surfaces';

import { fanoutHubMessage } from '../fanout';

import { createFixture } from './fanout.fixture';

const __fixture = createFixture();

describe('fanoutHubMessage', () => {
  test('projects relationship notices with the incident dashboard link', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);

    await fanoutHubMessage(
      __fixture.liveDeps(registry, { dashboardBaseUrl: 'https://app.example.com' }),
      __fixture.msg({
        id: 'relationship-1',
        author: 'system',
        kind: 'relationship',
        content: 'This alert is related to a separate investigation.',
      }),
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]!.link).toBe('https://app.example.com/w/incidents/i1');
  });

  test('projects one lifecycle version independently to primary and source threads', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const finishDelivery = vi.fn(async () => true);
    await fanoutHubMessage(
      __fixture.baseDeps({
        registry,
        listDeliveryTargets: async () => [
          { surface: 'slack', bindingId: 'primary-binding', bindingAssignmentVersion: 0 },
          { surface: 'slack', bindingId: 'source-binding', bindingAssignmentVersion: 0 },
        ],
        getBinding: async (_tenantId, _surface, bindingId) =>
          bindingId === 'primary-binding'
            ? { channel: 'C1', threadId: 'primary-root' }
            : { channel: 'C1', threadId: 'source-root' },
        finishDelivery,
      }),
      __fixture.msg({
        id: 'lifecycle-multi',
        kind: 'lifecycle',
        author: 'system',
        content: 'Incident mitigated.',
        lifecycleFrom: 'open',
        lifecycleTo: 'mitigated',
        lifecycleVersion: 1,
      }),
    );

    expect(posts.map((post) => post.thread)).toEqual(['primary-root', 'source-root']);
    expect(finishDelivery).toHaveBeenCalledTimes(2);
    expect(finishDelivery).toHaveBeenNthCalledWith(
      1,
      't1',
      'slack',
      'primary-binding',
      'lifecycle-multi',
      expect.objectContaining({ state: 'accepted' }),
    );
    expect(finishDelivery).toHaveBeenNthCalledWith(
      2,
      't1',
      'slack',
      'source-binding',
      'lifecycle-multi',
      expect.objectContaining({ state: 'accepted' }),
    );
  });

  test('concludes old activity and isolates new activity when the active thread changes', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const deps = __fixture.liveDeps(registry, {
      dashboardBaseUrl: 'https://app.example.com',
      listDeliveryTargets: async (_tenantId, messageId) =>
        messageId === 'handoff'
          ? [
              {
                surface: 'slack',
                bindingId: 'old-binding',
                bindingAssignmentVersion: 0,
              },
              {
                surface: 'slack',
                bindingId: 'new-binding',
                bindingAssignmentVersion: 0,
              },
            ]
          : [
              {
                surface: 'slack',
                bindingId: messageId === 'old-activity' ? 'old-binding' : 'new-binding',
                bindingAssignmentVersion: 0,
              },
            ],
      getBinding: async (_tenantId, _surface, bindingId) => ({
        channel: 'C1',
        threadId: bindingId === 'old-binding' ? 'old-root' : 'new-root',
      }),
    });

    await fanoutHubMessage(deps, __fixture.msg({ id: 'old-activity', kind: 'tool_step' }));
    await fanoutHubMessage(deps, __fixture.msg({ id: 'new-activity', kind: 'tool_step' }));
    await fanoutHubMessage(
      deps,
      __fixture.msg({
        id: 'handoff',
        author: 'system',
        kind: 'relationship',
        content: 'Related alert correlated with this incident.',
        originMessageId: 'correlated-source:slack:C1:new-root',
      }),
    );
    await fanoutHubMessage(deps, __fixture.msg({ id: 'new-finding', kind: 'finding' }));

    expect(posts.map((post) => post.thread)).toEqual(['old-root', 'new-root', 'new-root']);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ id: 'ts1', msg: { id: 'handoff' } });
    expect(updates[0]!.link).toBe('https://app.example.com/w/incidents/i1');
    expect(updates[1]).toMatchObject({ id: 'ts2', msg: { id: 'new-finding' } });
  });

  test('a non-handoff relationship does not consume active investigation progress', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const deps = __fixture.liveDeps(registry);

    await fanoutHubMessage(deps, __fixture.msg({ id: 'activity', kind: 'tool_step' }));
    await fanoutHubMessage(
      deps,
      __fixture.msg({
        id: 'merge-link',
        author: 'system',
        kind: 'relationship',
        content: 'Related to another incident.',
        originMessageId: 'incident-relation:merge:1',
      }),
    );
    await fanoutHubMessage(deps, __fixture.msg({ id: 'finding', kind: 'finding' }));

    expect(posts.map((post) => post.msg.id)).toEqual(['activity', 'merge-link']);
    expect(updates).toEqual([
      expect.objectContaining({ id: 'ts1', msg: expect.objectContaining({ id: 'finding' }) }),
    ]);
  });

  test('maintains one platform-owned lifecycle post and never regresses its version', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const finishDelivery = vi.fn(async () => true);
    const deps = __fixture.liveDeps(registry, { finishDelivery });

    await fanoutHubMessage(
      deps,
      __fixture.msg({
        id: 'lifecycle-1',
        kind: 'lifecycle',
        author: 'human',
        content: 'Incident open: alert accepted for investigation.',
        lifecycleFrom: null,
        lifecycleTo: 'open',
        lifecycleVersion: 0,
      }),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.thread).toBe(__fixture.BOUND_THREAD);
    expect(posts[0]!.msg.kind).toBe('lifecycle');

    await fanoutHubMessage(
      deps,
      __fixture.msg({
        id: 'lifecycle-2',
        kind: 'lifecycle',
        author: 'agent',
        content: 'Incident mitigated: traffic shifted away from the failing pool.',
        lifecycleFrom: 'open',
        lifecycleTo: 'mitigated',
        lifecycleVersion: 1,
      }),
    );
    expect(posts).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: 'ts1', msg: { lifecycleVersion: 1 } });

    await fanoutHubMessage(
      deps,
      __fixture.msg({
        id: 'lifecycle-stale',
        kind: 'lifecycle',
        author: 'human',
        content: 'Delayed older transition.',
        lifecycleFrom: 'open',
        lifecycleTo: 'mitigated',
        lifecycleVersion: 0,
      }),
    );
    expect(posts).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(finishDelivery).toHaveBeenLastCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'lifecycle-stale',
      {
        state: 'skipped',
        operation: 'update',
        remoteMessageId: 'ts1',
        reasonCode: 'stale_lifecycle_version',
      },
    );
  });

  test('blocks a second lifecycle post when an older creation attempt is ambiguous', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const finishDelivery = vi.fn(async () => true);

    await fanoutHubMessage(
      __fixture.baseDeps({
        registry,
        hasAmbiguousStatusPostCreation: async () => true,
        finishDelivery,
      }),
      __fixture.msg({
        id: 'lifecycle-after-uncertain',
        kind: 'lifecycle',
        lifecycleFrom: 'open',
        lifecycleTo: 'mitigated',
        lifecycleVersion: 1,
      }),
    );

    expect(posts).toHaveLength(0);
    expect(finishDelivery).toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'lifecycle-after-uncertain',
      {
        state: 'blocked',
        operation: 'composite',
        reasonCode: 'prior_status_post_uncertain',
      },
    );
  });

  test('does not accept a lifecycle post when its binding CAS loses', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const finishDelivery = vi.fn(async () => true);

    await fanoutHubMessage(
      __fixture.baseDeps({ registry, advanceStatusPost: async () => false, finishDelivery }),
      __fixture.msg({
        id: 'lifecycle-cas-lost',
        kind: 'lifecycle',
        lifecycleFrom: null,
        lifecycleTo: 'open',
        lifecycleVersion: 0,
      }),
    );

    expect(posts).toHaveLength(1);
    expect(finishDelivery).toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'lifecycle-cas-lost',
      {
        state: 'uncertain',
        operation: 'composite',
        reasonCode: 'unexpected_poster_failure',
      },
    );
    expect(finishDelivery).not.toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'lifecycle-cas-lost',
      expect.objectContaining({ state: 'accepted' }),
    );
  });

  test('renews ownership before accepting a surface delivery', async () => {
    const { poster } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const renew = vi.fn(async () => true);

    await fanoutHubMessage(
      __fixture.baseDeps({
        registry,
        lock: { acquire: async () => 'token', renew, release: async () => {} },
      }),
      __fixture.msg(),
    );

    expect(renew).toHaveBeenCalledWith(`surface:binding:${__fixture.BINDING_ID}`, 'token');
  });

  test('records an attempted delivery uncertain when final lease renewal loses ownership', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const finishDelivery = vi.fn(async () => true);
    const release = vi.fn(async () => {});

    await fanoutHubMessage(
      __fixture.baseDeps({
        registry,
        lock: { acquire: async () => 'token', renew: async () => false, release },
        finishDelivery,
      }),
      __fixture.msg(),
    );

    expect(posts).toHaveLength(1);
    expect(finishDelivery).toHaveBeenCalledWith('t1', 'slack', __fixture.BINDING_ID, 'm1', {
      state: 'uncertain',
      operation: 'composite',
      reasonCode: 'unexpected_poster_failure',
    });
    expect(finishDelivery).not.toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'm1',
      expect.objectContaining({ state: 'accepted' }),
    );
    expect(release).toHaveBeenCalledWith(`surface:binding:${__fixture.BINDING_ID}`, 'token');
  });

  test('records an in-flight delivery uncertain when the lease heartbeat loses ownership', async () => {
    vi.useFakeTimers();
    try {
      const { poster } = __fixture.fakePoster('slack');
      let markPostStarted!: () => void;
      const postStarted = new Promise<void>((resolve) => (markPostStarted = resolve));
      let completePost!: (messageId: string) => void;
      const postCompleted = new Promise<string>((resolve) => (completePost = resolve));
      poster.post = async () => {
        markPostStarted();
        return postCompleted;
      };
      const registry = new SurfaceRegistry();
      registry.register(poster);
      const renew = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      const finishDelivery = vi.fn(async () => true);

      const delivery = fanoutHubMessage(
        __fixture.baseDeps({
          registry,
          lock: { acquire: async () => 'token', renew, release: async () => {} },
          finishDelivery,
        }),
        __fixture.msg(),
      );
      await postStarted;
      await vi.advanceTimersByTimeAsync(10_000);
      completePost('ts-heartbeat');
      await delivery;

      expect(renew).toHaveBeenCalledOnce();
      expect(finishDelivery).toHaveBeenCalledWith('t1', 'slack', __fixture.BINDING_ID, 'm1', {
        state: 'uncertain',
        operation: 'composite',
        reasonCode: 'unexpected_poster_failure',
      });
      expect(finishDelivery).not.toHaveBeenCalledWith(
        't1',
        'slack',
        __fixture.BINDING_ID,
        'm1',
        expect.objectContaining({ state: 'accepted' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('agent text creates the working post inside the incident\u2019s bound thread', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const finishDelivery = vi.fn(async () => true);

    await fanoutHubMessage(__fixture.baseDeps({ registry, finishDelivery }), __fixture.msg());

    expect(posts).toHaveLength(1);
    // The thread already exists — it is the alert. Nothing is opened; we reply under it.
    expect(posts[0]!.thread).toBe(__fixture.BOUND_THREAD);
    expect(posts[0]!.target.channel).toBe('chat-1');
    expect(finishDelivery).toHaveBeenCalledWith('t1', 'slack', __fixture.BINDING_ID, 'm1', {
      state: 'accepted',
      operation: 'post',
      remoteMessageId: 'ts1',
      reasonCode: null,
    });
  });

  test('reads the revocable token for every message and memoizes only the immutable binding', async () => {
    const { poster } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const getToken = vi.fn(async () => 'BOT');
    const getBinding = vi.fn(async () => __fixture.BOUND);
    const deps = __fixture.liveDeps(registry, { getToken, getBinding });

    await fanoutHubMessage(deps, __fixture.msg({ id: 'a', incidentId: 'inc-1' }));
    await fanoutHubMessage(deps, __fixture.msg({ id: 'b', incidentId: 'inc-1' }));
    await fanoutHubMessage(deps, __fixture.msg({ id: 'c', incidentId: 'inc-1' }));

    expect(getToken).toHaveBeenCalledTimes(3);
    expect(getBinding).toHaveBeenCalledTimes(1);
  });

  test('a disconnect blocks the next queued message instead of using an earlier credential', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const getToken = vi.fn().mockResolvedValueOnce('BOT').mockResolvedValueOnce(null);
    const blockDelivery = vi.fn(async () => {});
    const deps = __fixture.liveDeps(registry, { getToken, blockDelivery });

    await fanoutHubMessage(deps, __fixture.msg({ id: 'a', incidentId: 'inc-disconnect' }));
    await fanoutHubMessage(deps, __fixture.msg({ id: 'b', incidentId: 'inc-disconnect' }));

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(posts).toHaveLength(1);
    expect(blockDelivery).toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'b',
      'not_connected',
    );
  });

  // T1 disconnect-safety: a null token (surface not connected) is NEVER cached, so a surface that
  // connects mid-incident is picked up on the very next message rather than skipped for 30s.
  test('re-reads the token when the first read returned null (connect mid-incident)', async () => {
    const { poster } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    let call = 0;
    const getToken = vi.fn(async () => (++call === 1 ? null : 'BOT'));
    const deps = __fixture.liveDeps(registry, { getToken });

    await fanoutHubMessage(deps, __fixture.msg({ id: 'a', incidentId: 'inc-connect' }));
    await fanoutHubMessage(deps, __fixture.msg({ id: 'b', incidentId: 'inc-connect' }));
    expect(getToken).toHaveBeenCalledTimes(2); // null was not frozen
  });

  // A missing binding is never cached, so a later message can see a repaired binding.
  test('re-reads the binding when the first read returned null (never freezes a missing binding)', async () => {
    const { poster } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    let call = 0;
    const getBinding = vi.fn(async () => (++call === 1 ? null : __fixture.BOUND));
    const deps = __fixture.liveDeps(registry, { getBinding, onError: () => {} });

    await fanoutHubMessage(deps, __fixture.msg({ id: 'a', incidentId: 'inc-bind' }));
    await fanoutHubMessage(deps, __fixture.msg({ id: 'b', incidentId: 'inc-bind' }));
    expect(getBinding).toHaveBeenCalledTimes(2); // missing binding was not frozen
  });

  // A binding commits in the SAME transaction as the incident, so a connected surface always has
  // one. If it is ever missing, report it and mark the durable destination blocked.
  test('a missing binding is durably blocked before any Slack request', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const blockDelivery = vi.fn(async () => {});
    const onError = vi.fn();

    const handled = await fanoutHubMessage(
      __fixture.baseDeps({ registry, getBinding: async () => null, blockDelivery, onError }),
      __fixture.msg(),
    );

    expect(handled).toBe(true);
    expect(posts).toHaveLength(0); // never guess a channel
    expect(onError).toHaveBeenCalledOnce();
    expect(String((onError.mock.calls[0]![0] as Error).message)).toContain('no slack binding');
    expect(blockDelivery).toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'm1',
      'missing_binding',
    );
  });
});
