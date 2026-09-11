import { describe, expect, test, vi } from 'vitest';

import {
  getSurfaceConfig,
  isChannelSubscribed,
  listSubscribedChannels,
  subscribeChannel,
  surfaceBotTokenKey,
  upsertSurfaceConfig,
} from '@sre/db';

import type { FetchLike } from '@sre/surfaces';

interface SlackSocketLifecycle {
  replace(configId: string, appToken: string, appId: string): Promise<void>;
  stop(configId: string): Promise<void>;
  status?(configId: string): {
    state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
    connectedAt: string | null;
    updatedAt: string;
  };
}

import { createFixture } from './surface-config.fixture';

const __fixture = createFixture();

describe('surface config CRUD', () => {
  // --- GET /surfaces/slack/available-channels ------------------------------------------------
  // Slack events carry channel IDs (C07…), but the UI invites typing a #name, and isChannelSubscribed
  // compares strings exactly — so every inbound alert is acked 200 and silently dropped. The operator
  // must PICK from the channels the bot can see (conversations.list), storing the id and showing the name.

  test('serializes concurrent PUTs so the final row, secrets, and client come from one request', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const appId = 'APAIR';
    const firstAppToken = __fixture.validAppToken('pair-one', appId);
    const secondAppToken = __fixture.validAppToken('pair-two', appId);
    const authCalls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      const method = new URL(url).pathname.split('/').pop();
      const token = init?.headers?.authorization?.replace('Bearer ', '') ?? '';
      if (method === 'auth.test') {
        authCalls.push(token);
        const second = token === 'xoxb-pair-two';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            user_id: second ? 'UPAIR2' : 'UPAIR1',
            bot_id: second ? 'BPAIR2' : 'BPAIR1',
            team_id: 'TPAIR',
          }),
        };
      }
      if (method === 'bots.info') {
        return { ok: true, status: 200, json: async () => ({ ok: true, bot: { app_id: appId } }) };
      }
      if (method === 'apps.connections.open') {
        return { ok: true, status: 200, json: async () => ({ ok: true, url: 'wss://slack.test' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, user: {} }) };
    };
    let finishFirst!: () => void;
    const replace = vi.fn(() => {
      if (replace.mock.calls.length === 1) {
        return new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
      return Promise.resolve();
    });
    const sockets: SlackSocketLifecycle = {
      replace,
      stop: vi.fn(async () => {}),
    };
    const surfaceApp = __fixture.makeSurfaceApp(fetch, undefined, sockets);
    const first = surfaceApp.request('/surfaces/slack', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
      body: JSON.stringify({ botToken: 'xoxb-pair-one', appToken: firstAppToken }),
    });
    await vi.waitFor(() => expect(sockets.replace).toHaveBeenCalledTimes(1));
    const second = surfaceApp.request('/surfaces/slack', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
      body: JSON.stringify({ botToken: 'xoxb-pair-two', appToken: secondAppToken }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authCalls).toEqual(['xoxb-pair-one']);

    finishFirst();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toMatchObject({
      botUserId: 'UPAIR2',
      botId: 'BPAIR2',
      teamId: 'TPAIR',
      appId,
    });
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBe(
      'xoxb-pair-two',
    );
    expect(await __fixture.secrets.get(__fixture.tenantB, __fixture.slackAppTokenKey())).toBe(
      secondAppToken,
    );
    expect(sockets.replace).toHaveBeenCalledTimes(2);
  });

  test('blank edits preserve both stored tokens', async () => {
    const appTokenKey = __fixture.slackAppTokenKey();
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantB, {
      surface: 'slack',
      botUserId: 'U262-EDIT',
      teamId: 'T262-EDIT',
    } as Parameters<typeof upsertSurfaceConfig>[2]);
    await __fixture.secrets.put(__fixture.tenantB, surfaceBotTokenKey('slack'), 'xoxb-262-edit');
    await __fixture.secrets.put(__fixture.tenantB, appTokenKey, 'xapp-262-edit');

    const res = await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
      body: JSON.stringify({ botToken: '', appToken: '' }),
    });

    expect(res.status).toBe(200);
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBe(
      'xoxb-262-edit',
    );
    expect(await __fixture.secrets.get(__fixture.tenantB, appTokenKey)).toBe('xapp-262-edit');
  });

  test('disconnect disables subscriptions, stops reception, deletes both tokens and config, and preserves channel-name history', async () => {
    const appTokenKey = __fixture.slackAppTokenKey();
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantB, {
      surface: 'slack',
      botUserId: 'U262-DISCONNECT',
      teamId: 'T262-DISCONNECT',
    } as Parameters<typeof upsertSurfaceConfig>[2]);
    await __fixture.secrets.put(
      __fixture.tenantB,
      surfaceBotTokenKey('slack'),
      'xoxb-262-disconnect',
    );
    await __fixture.secrets.put(__fixture.tenantB, appTokenKey, 'xapp-262-disconnect');
    await subscribeChannel(__fixture.app.db, {
      tenantId: __fixture.tenantB,
      surface: 'slack',
      channel: 'C0DISC262',
      channelName: '#disconnect-262',
      enabled: true,
    });
    const row = await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack');
    expect(row).toBeDefined();
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => {}),
      stop: vi.fn(async (configId) => {
        expect(configId).toBe(row!.id);
        expect(
          await isChannelSubscribed(__fixture.app.db, __fixture.tenantB, 'slack', 'C0DISC262'),
        ).toBe(false);
        expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toBeDefined();
        expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBe(
          'xoxb-262-disconnect',
        );
        expect(await __fixture.secrets.get(__fixture.tenantB, appTokenKey)).toBe(
          'xapp-262-disconnect',
        );
      }),
    };

    const res = await __fixture
      .makeSurfaceApp(undefined, undefined, sockets)
      .request('/surfaces/slack', {
        method: 'DELETE',
        headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
      });

    expect(res.status).toBe(200);
    expect(sockets.stop).toHaveBeenCalledTimes(1);
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBeNull();
    expect(await __fixture.secrets.get(__fixture.tenantB, appTokenKey)).toBeNull();
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toBeUndefined();
    expect(
      await listSubscribedChannels(__fixture.app.db, __fixture.tenantB, 'slack'),
    ).toContainEqual(
      expect.objectContaining({
        channel: 'C0DISC262',
        channelName: '#disconnect-262',
        enabled: false,
      }),
    );
  });
});
