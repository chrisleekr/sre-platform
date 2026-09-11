import { describe, expect, test, vi } from 'vitest';

import { SlackApiError, SurfaceRegistry, type Surface } from '@sre/surfaces';

import { fanoutHubMessage, type SurfaceLock } from '../fanout';

import { createFixture } from './fanout.fixture';

const __fixture = createFixture();

describe('fanoutHubMessage', () => {
  test('agent silent turns the working post into a concise acknowledgement and clears it', async () => {
    const { poster, posts, updates, deletes } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const finishDelivery = vi.fn(async () => true);
    const deps = __fixture.liveDeps(registry, { finishDelivery });

    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'm1', kind: 'tool_step', content: 'get_logs' }),
    );
    await fanoutHubMessage(deps, __fixture.msg({ id: 'm2', kind: 'silent', content: '' }));

    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.msg).toMatchObject({
      kind: 'reply',
      summary: 'Message received.',
      content: 'No additional response was needed.',
    });
    expect(finishDelivery).toHaveBeenNthCalledWith(2, 't1', 'slack', __fixture.BINDING_ID, 'm2', {
      state: 'accepted',
      operation: 'update',
      remoteMessageId: 'ts1',
      reasonCode: null,
    });

    // Cleared: the next turn opens a fresh post.
    await fanoutHubMessage(deps, __fixture.msg({ id: 'm3', kind: 'text', content: 'back at it' }));
    expect(posts).toHaveLength(2);
  });

  test('agent silent with no working post is a no-op', async () => {
    const { poster, posts, deletes } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const finishDelivery = vi.fn(async () => true);

    await fanoutHubMessage(
      __fixture.liveDeps(registry, { finishDelivery }),
      __fixture.msg({ kind: 'silent', content: '' }),
    );

    expect(posts).toHaveLength(0);
    expect(deletes).toHaveLength(0);
    expect(finishDelivery).toHaveBeenCalledWith('t1', 'slack', __fixture.BINDING_ID, 'm1', {
      state: 'skipped',
      operation: 'delete',
      remoteMessageId: null,
      reasonCode: 'nothing_to_delete',
    });
  });

  test('a system finding (degrade) deletes the dangling working post, then posts the note (no silent)', async () => {
    const { poster, posts, updates, deletes } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const deps = __fixture.liveDeps(registry);

    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'm1', kind: 'tool_step', content: 'get_logs' }),
    );
    // The degrade note pair: a system `finding`, then a system `text` escalation.
    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'm2', author: 'system', kind: 'finding', content: 'degrade brief' }),
    );
    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'm3', author: 'system', kind: 'text', content: 'Escalated' }),
    );

    expect(deletes).toHaveLength(1); // the dangling "🔍 …" working post was removed
    expect(updates).toHaveLength(0); // never routed through the working post
    // 1 opener (the tool_step working post) + the degrade finding + the escalation text.
    expect(posts).toHaveLength(3);
    // Cleared: the trailing system `text` found no working post (it just posted).
    expect(posts[2]!.msg.content).toBe('Escalated');
  });

  test('an approval posts normally (its own buttoned message)', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);

    await fanoutHubMessage(
      __fixture.liveDeps(registry),
      __fixture.msg({
        kind: 'approval',
        content: 'Restart?',
        approval: { id: 'a1', options: [{ id: 'y', label: 'Y' }] },
      }),
    );

    expect(posts).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  test('a redelivered message is skipped by the durable delivery claim', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    let claimed = false;
    const deps = __fixture.liveDeps(registry, {
      claimDelivery: async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
    });

    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'm1', kind: 'tool_step', content: 'get_logs' }),
    );
    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'm1', kind: 'tool_step', content: 'get_logs' }),
    );

    expect(posts).toHaveLength(1); // did NOT double-create
    expect(updates).toHaveLength(0);
  });

  test('two concurrent narration messages open the thread exactly once (lock)', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const wp = __fixture.wpStore();
    const held = new Set<string>();
    const lock: SurfaceLock = {
      acquire: async (key) => {
        if (held.has(key)) return null;
        held.add(key);
        return 'tok';
      },
      renew: async () => true,
      release: async (key) => void held.delete(key),
    };
    const deps = __fixture.baseDeps({
      registry,
      lock,
      getWorkingPost: wp.get,
      setWorkingPost: wp.set,
      clearWorkingPost: wp.clear,
    });

    await Promise.all([
      fanoutHubMessage(deps, __fixture.msg({ id: 'm1', kind: 'tool_step', content: 'get_logs' })),
      fanoutHubMessage(
        deps,
        __fixture.msg({ id: 'm2', kind: 'tool_step', content: 'get_metrics' }),
      ),
    ]);

    expect(posts).toHaveLength(1); // created the working post once
    expect(updates).toHaveLength(1); // the other edited it
    expect(posts[0]!.thread).toBe(__fixture.BOUND_THREAD);
  });

  test('skips non-mirrored kinds (status) before any lookup', async () => {
    const resolveTenant = vi.fn(async () => 't1');
    await fanoutHubMessage(
      __fixture.baseDeps({ resolveTenant }),
      __fixture.msg({ kind: 'status' }),
    );
    expect(resolveTenant).not.toHaveBeenCalled();
  });

  test('skips a surface with no registered adapter (before the token lookup)', async () => {
    const getToken = vi.fn(async () => 'BOT');
    await fanoutHubMessage(
      __fixture.baseDeps({ registry: new SurfaceRegistry(), getToken }),
      __fixture.msg(),
    );
    expect(getToken).not.toHaveBeenCalled();
  });

  test('skips a configured surface with no stored token', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    await fanoutHubMessage(
      __fixture.baseDeps({ registry, getToken: async () => null }),
      __fixture.msg(),
    );
    expect(posts).toHaveLength(0);
  });

  test('a poster failure is best-effort: onError called, never rethrown', async () => {
    const registry = new SurfaceRegistry();
    registry.register({
      surface: 'slack',
      post: async () => {
        throw new Error('slack down');
      },
      update: async () => {},
      delete: async () => {},
    });
    const onError = vi.fn();
    await expect(
      fanoutHubMessage(__fixture.baseDeps({ registry, onError }), __fixture.msg()),
    ).resolves.toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  test('a resolveTenant failure routes to onError (surface: resolve), no throw', async () => {
    const onError = vi.fn();
    await expect(
      fanoutHubMessage(
        __fixture.baseDeps({
          resolveTenant: async () => {
            throw new Error('db down');
          },
          onError,
        }),
        __fixture.msg(),
      ),
    ).resolves.toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![1]).toMatchObject({ surface: 'resolve' });
  });

  test('no queued delivery targets is a no-op', async () => {
    const getToken = vi.fn(async () => 'BOT');
    await fanoutHubMessage(
      __fixture.baseDeps({ listDeliveryTargets: async () => [], getToken }),
      __fixture.msg(),
    );
    expect(getToken).not.toHaveBeenCalled();
  });

  test('outbox recovery uses its trusted tenant and destinations when scoped readers are unavailable', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const resolveTenant = vi.fn(async () => {
      throw new Error('admin lookup unavailable');
    });
    const listDeliveryTargets = vi.fn(async () => {
      throw new Error('app database unavailable');
    });

    await fanoutHubMessage(
      __fixture.baseDeps({ registry, resolveTenant, listDeliveryTargets }),
      __fixture.msg(),
      {
        tenantId: 't1',
        targets: [
          { surface: 'slack', bindingId: __fixture.BINDING_ID, bindingAssignmentVersion: 0 },
        ],
      },
    );

    expect(posts).toHaveLength(1);
    expect(resolveTenant).not.toHaveBeenCalled();
    expect(listDeliveryTargets).not.toHaveBeenCalled();
  });

  test('outbox recovery durably delays a scoped dependency failure', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const scheduleDeliveryRetry = vi.fn(async () => true);
    const claimDelivery = vi.fn(async () => true);

    const handled = await fanoutHubMessage(
      __fixture.baseDeps({
        registry,
        getToken: async () => {
          throw new Error('app database unavailable');
        },
        scheduleDeliveryRetry,
        claimDelivery,
        now: () => 1_000,
        onError: () => {},
      }),
      __fixture.msg(),
      {
        tenantId: 't1',
        targets: [
          { surface: 'slack', bindingId: __fixture.BINDING_ID, bindingAssignmentVersion: 0 },
        ],
      },
    );

    expect(handled).toBe(false);
    expect(posts).toHaveLength(0);
    expect(claimDelivery).not.toHaveBeenCalled();
    expect(scheduleDeliveryRetry).toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'm1',
      'queued',
      new Date(6_000),
      'dependency_unavailable',
    );
  });

  test('a redelivered message is not re-posted after its durable claim', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    let queued = true;
    const deps = __fixture.liveDeps(registry, {
      claimDelivery: async () => {
        if (!queued) return false;
        queued = false;
        return true;
      },
    });

    await fanoutHubMessage(deps, __fixture.msg()); // first delivery: opens + posts
    await fanoutHubMessage(deps, __fixture.msg()); // redelivery of the SAME message id: skipped

    expect(posts).toHaveLength(1);
  });

  test('does not echo a message back to its origin surface, but still mirrors to the others', async () => {
    const origin = __fixture.fakePoster('slack');
    const other = __fixture.fakePoster('other');
    const registry = new SurfaceRegistry();
    registry.register(origin.poster);
    registry.register(other.poster);

    await fanoutHubMessage(
      __fixture.liveDeps(registry, {
        listDeliveryTargets: async () => [
          {
            surface: 'other' as Surface,
            bindingId: __fixture.BINDING_ID,
            bindingAssignmentVersion: 0,
          },
        ],
      }),
      __fixture.msg({ originSurface: 'slack' }),
    );

    expect(origin.posts).toHaveLength(0); // origin surface: no echo back
    expect(other.posts).toHaveLength(1); // still synced to the other surface
  });

  test('does not claim an origin surface omitted by the durable outbox', async () => {
    const { poster } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const claimDelivery = vi.fn(async () => true);

    await fanoutHubMessage(
      __fixture.baseDeps({ registry, listDeliveryTargets: async () => [], claimDelivery }),
      __fixture.msg({ originSurface: 'slack' }),
    );

    expect(claimDelivery).not.toHaveBeenCalled();
  });

  test('an ambiguous post is marked uncertain and is not retried', async () => {
    let attempts = 0;
    const registry = new SurfaceRegistry();
    registry.register({
      surface: 'slack',
      post: async () => {
        attempts++;
        if (attempts === 1) throw new Error('slack down');
        return 'ts9';
      },
      update: async () => {},
      delete: async () => {},
    });
    let queued = true;
    const finishDelivery = vi.fn(async () => true);
    const deps = __fixture.liveDeps(registry, {
      claimDelivery: async () => {
        if (!queued) return false;
        queued = false;
        return true;
      },
      finishDelivery,
      onError: () => {},
    });

    await fanoutHubMessage(deps, __fixture.msg());
    await fanoutHubMessage(deps, __fixture.msg());
    expect(attempts).toBe(1);
    expect(finishDelivery).toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'm1',
      expect.objectContaining({ state: 'uncertain' }),
    );
  });

  test('a Slack rate limit durably returns the claimed delivery to a delayed queue', async () => {
    const registry = new SurfaceRegistry();
    registry.register({
      surface: 'slack',
      post: async () => {
        throw new SlackApiError('retryable', 'rate_limited', 'rate limited', 12_000);
      },
      update: async () => {},
      delete: async () => {},
    });
    const scheduleDeliveryRetry = vi.fn(async () => true);
    const finishDelivery = vi.fn(async () => true);

    const handled = await fanoutHubMessage(
      __fixture.baseDeps({
        registry,
        scheduleDeliveryRetry,
        finishDelivery,
        now: () => 1_000,
      }),
      __fixture.msg(),
    );

    expect(handled).toBe(true);
    expect(scheduleDeliveryRetry).toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'm1',
      'sending',
      new Date(13_000),
      'rate_limited',
    );
    expect(finishDelivery).not.toHaveBeenCalled();
  });

  test('defers (returns false) when the opener never wins the lock', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const neverWins: SurfaceLock = {
      acquire: async () => null,
      renew: async () => false,
      release: async () => {},
    };
    const scheduleDeliveryRetry = vi.fn(async () => true);

    const handled = await fanoutHubMessage(
      __fixture.baseDeps({ registry, lock: neverWins, scheduleDeliveryRetry, now: () => 1_000 }),
      __fixture.msg(),
    );

    expect(handled).toBe(false);
    expect(posts).toHaveLength(0);
    expect(scheduleDeliveryRetry).toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'm1',
      'queued',
      new Date(6_000),
      'projection_busy',
    );
  });

  test('returns true (handled) when the message posts normally', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);

    const handled = await fanoutHubMessage(__fixture.liveDeps(registry), __fixture.msg());

    expect(handled).toBe(true);
    expect(posts).toHaveLength(1);
  });

  test('returns true (handled) when a surface is skipped for a missing token', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);

    const handled = await fanoutHubMessage(
      __fixture.baseDeps({ registry, getToken: async () => null }),
      __fixture.msg(),
    );

    expect(handled).toBe(true);
    expect(posts).toHaveLength(0);
  });
});
