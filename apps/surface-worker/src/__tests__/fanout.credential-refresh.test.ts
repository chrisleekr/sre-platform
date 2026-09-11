import { describe, expect, test, vi } from 'vitest';

import { SlackApiError, SurfaceRegistry } from '@sre/surfaces';

import type { HubMessage } from '@sre/hub';

import { fanoutHubMessage } from '../fanout';

import { createFixture } from './fanout.fixture';

const __fixture = createFixture();

describe('fanoutHubMessage', () => {
  // Fallback guard (stays GREEN through Phase B): an unresolved author (null) is posted with no label.
  test('no authorLabel is stamped when the reply authorUserId is null (generic fallback)', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const resolveAuthorLabel = vi.fn(async () => null);
    const deps = { ...__fixture.baseDeps({ registry }), resolveAuthorLabel };

    await fanoutHubMessage(
      deps,
      __fixture.msg({
        author: 'human',
        kind: 'text',
        content: 'db is down',
        originSurface: 'dashboard',
        authorUserId: null,
      }),
    );

    expect(posts).toHaveLength(1);
    const posted = posts[0]!.msg as HubMessage & { authorLabel?: string | null };
    expect(posted.authorLabel ?? null).toBeNull();
  });

  // --- the reply must land in the thread the alert arrived in, not in a configured channel. ---
  // BOTH halves of the destination — channel and thread id — come from the binding. A thread id is only
  // meaningful inside the channel that owns its root message, so sourcing the channel anywhere else
  // posts under a thread that does not exist there and the answer never appears under the alert.
  test('posts to the binding channel', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    // The incident was born in C_NEW (the alert's own channel), NOT in the fixture's default chat-1.
    // The binding is now the only thing that can name a channel: there is no configured post target.
    const deps = __fixture.baseDeps({
      registry,
      getBinding: async () => ({ channel: 'C_NEW', threadId: '1783760625.776459' }),
    });

    await fanoutHubMessage(
      deps,
      __fixture.msg({ kind: 'reply', content: 'root cause: db pool exhausted' }),
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]!.target.channel).toBe('C_NEW'); // the binding's channel, not the fixture's chat-1
    // The thread id reaches the poster verbatim — no composite, nothing to split back apart.
    expect(posts[0]!.thread).toBe('1783760625.776459');
  });
});

describe('fanoutHubMessage credential refresh', () => {
  const throwingRegistry = (error: Error): SurfaceRegistry => {
    const registry = new SurfaceRegistry();
    registry.register({
      surface: 'slack',
      post: async () => {
        throw error;
      },
      update: async () => {},
      delete: async () => {},
    });
    return registry;
  };

  test('re-reads the credential after invalid_auth', async () => {
    const getToken = vi.fn(async () => 'BOT');
    const deps = __fixture.baseDeps({
      registry: throwingRegistry(
        new SlackApiError(
          'rejected',
          'invalid_auth',
          'slack chat.postMessage not-ok: invalid_auth',
        ),
      ),
      getToken,
      onError: () => {},
    });

    await fanoutHubMessage(deps, __fixture.msg({ id: 'a', incidentId: 'inc-auth' }));
    expect(getToken).toHaveBeenCalledTimes(1);
    await fanoutHubMessage(deps, __fixture.msg({ id: 'b', incidentId: 'inc-auth' }));
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  test('also re-reads the credential after a non-auth poster failure', async () => {
    const getToken = vi.fn(async () => 'BOT');
    const deps = __fixture.baseDeps({
      registry: throwingRegistry(new Error('slack chat.postMessage not-ok: internal_error')),
      getToken,
      onError: () => {},
    });

    await fanoutHubMessage(deps, __fixture.msg({ id: 'a', incidentId: 'inc-5xx' }));
    await fanoutHubMessage(deps, __fixture.msg({ id: 'b', incidentId: 'inc-5xx' }));
    expect(getToken).toHaveBeenCalledTimes(2);
  });
});
