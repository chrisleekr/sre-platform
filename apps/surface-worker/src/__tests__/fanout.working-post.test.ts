import { describe, expect, test, vi } from 'vitest';

import { SurfaceRegistry } from '@sre/surfaces';

import { fanoutHubMessage } from '../fanout';

import { createFixture } from './fanout.fixture';

const __fixture = createFixture();

describe('fanoutHubMessage', () => {
  // No token = the surface is not connected: nowhere to speak, and that is legitimate, not an error.
  test('skips a surface with no bot token, without raising', async () => {
    const { poster, posts } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const blockDelivery = vi.fn(async () => {});
    const onError = vi.fn();

    await fanoutHubMessage(
      __fixture.baseDeps({ registry, getToken: async () => null, blockDelivery, onError }),
      __fixture.msg(),
    );

    expect(posts).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
    expect(blockDelivery).toHaveBeenCalledWith(
      't1',
      'slack',
      __fixture.BINDING_ID,
      'm1',
      'not_connected',
    );
  });

  test('a tool_step then a text produce ONE post then an update, not two posts', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const finishDelivery = vi.fn(async () => true);
    const deps = __fixture.liveDeps(registry, { finishDelivery });

    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'm1', kind: 'tool_step', content: 'get_logs {"s":"x"}' }),
    );
    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'm2', kind: 'text', content: 'digging deeper' }),
    );

    expect(posts).toHaveLength(1); // opened + created the working post once
    expect(updates).toHaveLength(1); // second narration edited it in place
    expect(posts[0]!.msg.summary).toContain('get logs'); // friendly tool line, raw args dropped
    expect(finishDelivery).toHaveBeenNthCalledWith(2, 't1', 'slack', __fixture.BINDING_ID, 'm2', {
      state: 'accepted',
      operation: 'update',
      remoteMessageId: 'ts1',
      reasonCode: null,
    });
  });

  test('a finding folds the working post into the terminal answer (+link) and clears it', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);
    const deps = __fixture.liveDeps(registry, { dashboardBaseUrl: 'https://app.example.com' });

    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'm1', kind: 'tool_step', content: 'get_logs' }),
    );
    await fanoutHubMessage(
      deps,
      __fixture.msg({
        id: 'm2',
        kind: 'finding',
        content: 'full RCA',
        summary: 'db pool exhausted',
      }),
    );

    expect(posts).toHaveLength(1);
    expect(updates).toHaveLength(1); // the working post became the final answer
    expect(updates[0]!.link).toBe('https://app.example.com/w/incidents/i1');
    expect(updates[0]!.msg.summary).toBe('db pool exhausted');

    // Cleared: a fresh narration turn opens a NEW post rather than editing the concluded one.
    await fanoutHubMessage(
      deps,
      __fixture.msg({ id: 'm3', kind: 'tool_step', content: 'get_traces' }),
    );
    expect(posts).toHaveLength(2);
  });

  test('a reply with no working post posts directly (a no-tool turn)', async () => {
    const { poster, posts, updates } = __fixture.fakePoster('slack');
    const registry = new SurfaceRegistry();
    registry.register(poster);

    await fanoutHubMessage(
      __fixture.liveDeps(registry),
      __fixture.msg({ kind: 'reply', content: 'here is the answer', summary: 'answer' }),
    );

    expect(posts).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });
});
