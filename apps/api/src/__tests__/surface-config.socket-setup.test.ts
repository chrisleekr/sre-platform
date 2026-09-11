import { describe, expect, test, vi } from 'vitest';

import { getSurfaceConfig, surfaceBotTokenKey, upsertSurfaceConfig } from '@sre/db';

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

  test('C10 no response body ever echoes a stored secret value', async () => {
    const appToken = 'xapp-super-secret';
    const bot = 'xoxb-super-secret';
    const putRes = await __fixture.putSlack(__fixture.orgA, {
      botUserId: 'U-c10',
      appToken,
      botToken: bot,
    });
    const putBody = JSON.stringify(await putRes.json());
    expect(putBody).not.toContain(appToken);
    expect(putBody).not.toContain(bot);

    const getBody = JSON.stringify(await __fixture.listSurfaces(__fixture.orgA));
    expect(getBody).not.toContain(appToken);
    expect(getBody).not.toContain(bot);

    const { fetch } = __fixture.fakeFetch({ ok: true, user_id: 'U0BOT', team_id: 'T0' });
    const testRes = await __fixture.makeSurfaceApp(fetch).request('/surfaces/slack/test', {
      method: 'POST',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(JSON.stringify(await testRes.json())).not.toContain(bot);
  });

  test('a new Slack connection requires both write-only tokens', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const botOnly = await __fixture.putSurface(__fixture.orgB, 'slack', { botToken: 'xoxb-only' });
    const appOnly = await __fixture.putSurface(__fixture.orgB, 'slack', { appToken: 'xapp-only' });
    const rowBeforeCleanup = await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack');
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });

    expect(botOnly.status).toBe(400);
    expect(appOnly.status).toBe(400);
    expect(rowBeforeCleanup).toBeUndefined();
  });

  test('save verifies the Slack identity and team, stores both tokens, and starts Socket Mode without returning secrets', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const appToken = __fixture.validAppToken('262');
    const { fetch } = __fixture.methodFetch({
      'auth.test': {
        body: { ok: true, user_id: 'U262', bot_id: 'B262', team_id: 'T262' },
      },
      'users.info': { body: { ok: true, user: { id: 'U262' } } },
    });
    const res = await __fixture
      .makeSurfaceApp(fetch, undefined, sockets)
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
        body: JSON.stringify({ botToken: 'xoxb-262', appToken }),
      });
    const body = JSON.stringify(await res.json());
    const row = await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack');
    const projected = await __fixture.getSlack(__fixture.orgB);

    expect(res.status).toBe(200);
    expect(row).toMatchObject({
      botUserId: 'U262',
      botId: 'B262',
      teamId: 'T262',
      appId: __fixture.TEST_APP_ID,
    });
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBe(
      'xoxb-262',
    );
    expect(await __fixture.secrets.get(__fixture.tenantB, __fixture.slackAppTokenKey())).toBe(
      appToken,
    );
    expect(projected).toMatchObject({ hasBotToken: true, hasAppToken: true });
    expect(sockets.replace).toHaveBeenCalledWith(row!.id, appToken, __fixture.TEST_APP_ID);
    expect(body).not.toContain('xoxb-262');
    expect(body).not.toContain(appToken);
  });

  test('PUT rejects a user token whose auth.test response has no bot_id before any write', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const appToken = __fixture.validAppToken('user-token');
    const { fetch } = __fixture.methodFetch({
      'auth.test': { body: { ok: true, user_id: 'UUSER', bot_id: null, team_id: 'TUSER' } },
    });

    const res = await __fixture
      .makeSurfaceApp(fetch, undefined, sockets)
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
        body: JSON.stringify({ botToken: 'xoxp-user-token', appToken }),
      });

    expect(res.status).toBe(400);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toBeUndefined();
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBeNull();
    expect(await __fixture.secrets.get(__fixture.tenantB, __fixture.slackAppTokenKey())).toBeNull();
    expect(sockets.replace).not.toHaveBeenCalled();
  });

  test('PUT rejects bot/app identity mismatch and app-token scope failure before writes', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const appToken = __fixture.validAppToken('mismatch');
    const auth = {
      ok: true,
      user_id: 'UMISMATCH',
      bot_id: 'BMISMATCH',
      team_id: 'TMISMATCH',
    };
    const mismatch = __fixture.methodFetch({
      'auth.test': { body: auth },
      'bots.info': { body: { ok: true, bot: { app_id: 'AOTHERAPP' } } },
    });
    const mismatchRes = await __fixture
      .makeSurfaceApp(mismatch.fetch, undefined, sockets)
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
        body: JSON.stringify({ botToken: 'xoxb-mismatch', appToken }),
      });
    expect(mismatchRes.status).toBe(400);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toBeUndefined();

    const missingScope = __fixture.methodFetch({
      'auth.test': { body: auth },
      'apps.connections.open': { body: { ok: false, error: 'missing_scope' } },
    });
    const scopeRes = await __fixture
      .makeSurfaceApp(missingScope.fetch, undefined, sockets)
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
        body: JSON.stringify({ botToken: 'xoxb-mismatch', appToken }),
      });
    expect(scopeRes.status).toBe(400);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toBeUndefined();
    expect(await __fixture.secrets.get(__fixture.tenantB, __fixture.slackAppTokenKey())).toBeNull();
    expect(sockets.replace).not.toHaveBeenCalled();
  });

  test('a Socket Mode connection failure is logged with safe stage and Slack error metadata', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const info = vi.fn();
    const error = vi.fn();
    const log = { info, error };
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => {
        throw Object.assign(new Error('request included xapp-must-not-be-logged'), {
          code: 'slack_webapi_platform_error',
          data: { error: 'not_allowed_token_type' },
          statusCode: 200,
        });
      }),
      stop: vi.fn(async () => {}),
    };
    const appToken = __fixture.validAppToken('secret');
    const { fetch } = __fixture.methodFetch({
      'auth.test': {
        body: { ok: true, user_id: 'UOBS', bot_id: 'BOBS', team_id: 'TOBS' },
      },
      'users.info': { body: { ok: true, user: { id: 'UOBS' } } },
    });

    const res = await __fixture
      .makeSurfaceApp(fetch, undefined, sockets, log)
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
        body: JSON.stringify({ botToken: 'xoxb-must-not-be-logged', appToken }),
      });

    expect(res.status).toBe(400);
    expect(error).toHaveBeenCalledWith(
      'Slack surface connection failed',
      expect.objectContaining({
        tenantId: __fixture.tenantB,
        surface: 'slack',
        stage: 'socket_start',
        status: 400,
        error: 'socket_start_failed',
        errorType: 'Error',
        errorCode: 'slack_webapi_platform_error',
        slackError: 'not_allowed_token_type',
        upstreamStatus: 200,
      }),
    );
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain('xapp-must-not-be-logged');
    expect(logged).not.toContain('xoxb-must-not-be-logged');
    expect(logged).not.toContain(appToken);
    expect(info).not.toHaveBeenCalled();
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toBeUndefined();
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBeNull();
    expect(await __fixture.secrets.get(__fixture.tenantB, __fixture.slackAppTokenKey())).toBeNull();
    expect(sockets.stop).toHaveBeenCalledTimes(1);
  });

  test('an edit socket failure restores the old row and secrets without stopping the old client', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const oldAppToken = __fixture.validAppToken('old', 'AOLDAPP');
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantB, {
      surface: 'slack',
      botUserId: 'UOLD',
      botId: 'BOLD',
      teamId: 'TOLD',
      appId: 'AOLDAPP',
    });
    await __fixture.secrets.put(__fixture.tenantB, surfaceBotTokenKey('slack'), 'xoxb-old');
    await __fixture.secrets.put(__fixture.tenantB, __fixture.slackAppTokenKey(), oldAppToken);
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => {
        throw new Error('candidate failed');
      }),
      stop: vi.fn(async () => {}),
    };
    const newAppToken = __fixture.validAppToken('new', 'ANEWAPP');
    const { fetch } = __fixture.methodFetch({
      'auth.test': {
        body: { ok: true, user_id: 'UNEW', bot_id: 'BNEW', team_id: 'TNEW' },
      },
      'bots.info': { body: { ok: true, bot: { app_id: 'ANEWAPP' } } },
    });

    const res = await __fixture
      .makeSurfaceApp(fetch, undefined, sockets)
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
        body: JSON.stringify({ botToken: 'xoxb-new', appToken: newAppToken }),
      });

    expect(res.status).toBe(400);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toMatchObject({
      botUserId: 'UOLD',
      botId: 'BOLD',
      teamId: 'TOLD',
      appId: 'AOLDAPP',
    });
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBe(
      'xoxb-old',
    );
    expect(await __fixture.secrets.get(__fixture.tenantB, __fixture.slackAppTokenKey())).toBe(
      oldAppToken,
    );
    expect(sockets.stop).not.toHaveBeenCalled();
  });

  test('a new connection secret failure removes the provisional config and secrets', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const put = vi
      .spyOn(__fixture.secrets, 'put')
      .mockRejectedValueOnce(new Error('secret store down'));
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const appToken = __fixture.validAppToken('secret-failure');
    const { fetch } = __fixture.methodFetch({
      'auth.test': {
        body: { ok: true, user_id: 'USECRET', bot_id: 'BSECRET', team_id: 'TSECRET' },
      },
    });

    const res = await __fixture
      .makeSurfaceApp(fetch, undefined, sockets)
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
        body: JSON.stringify({ botToken: 'xoxb-secret', appToken }),
      });
    put.mockRestore();

    expect(res.status).toBe(500);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toBeUndefined();
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBeNull();
    expect(await __fixture.secrets.get(__fixture.tenantB, __fixture.slackAppTokenKey())).toBeNull();
    expect(sockets.replace).not.toHaveBeenCalled();
  });

  test('a failed new connection retains its visible row when rollback cleanup fails, then DELETE can finish cleanup', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const info = vi.fn();
    const error = vi.fn();
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => {
        throw new Error('candidate failed');
      }),
      stop: vi.fn(async () => {}),
    };
    const appToken = __fixture.validAppToken('cleanup-failure');
    const { fetch } = __fixture.methodFetch({
      'auth.test': {
        body: { ok: true, user_id: 'UCLEANUP', bot_id: 'BCLEANUP', team_id: 'TCLEANUP' },
      },
    });
    const surfaceApp = __fixture.makeSurfaceApp(fetch, undefined, sockets, { info, error });
    const deleteSecret = vi
      .spyOn(__fixture.secrets, 'delete')
      .mockRejectedValueOnce(
        Object.assign(new Error('do not log this detail'), { code: 'KMS_DOWN' }),
      );

    const failed = await surfaceApp.request('/surfaces/slack', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
      body: JSON.stringify({ botToken: 'xoxb-cleanup', appToken }),
    });
    deleteSecret.mockRestore();

    expect(failed.status).toBe(400);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toMatchObject({
      botUserId: 'UCLEANUP',
      botId: 'BCLEANUP',
    });
    expect(error).toHaveBeenCalledWith(
      'Slack surface connection failed',
      expect.objectContaining({
        stage: 'rollback_cleanup',
        error: 'rollback_cleanup_failed',
        errorCode: 'KMS_DOWN',
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('do not log this detail');

    const disconnected = await surfaceApp.request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    expect(disconnected.status).toBe(200);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toBeUndefined();
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBeNull();
    expect(await __fixture.secrets.get(__fixture.tenantB, __fixture.slackAppTokenKey())).toBeNull();
  });

  test('logs an existing-update rollback failure with safe metadata', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const oldAppToken = __fixture.validAppToken('rollback-old', 'AROLLBACK');
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantB, {
      surface: 'slack',
      botUserId: 'UROLLBACKOLD',
      botId: 'BROLLBACKOLD',
      teamId: 'TROLLBACKOLD',
      appId: 'AROLLBACK',
    });
    await __fixture.secrets.put(
      __fixture.tenantB,
      surfaceBotTokenKey('slack'),
      'xoxb-rollback-old',
    );
    await __fixture.secrets.put(__fixture.tenantB, __fixture.slackAppTokenKey(), oldAppToken);
    const originalPut = __fixture.secrets.put.bind(__fixture.secrets);
    let putCall = 0;
    const put = vi.spyOn(__fixture.secrets, 'put').mockImplementation(async (...args) => {
      putCall += 1;
      if (putCall === 3)
        throw Object.assign(new Error('hidden rollback detail'), { code: 'KMS_DOWN' });
      return originalPut(...args);
    });
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => {
        throw new Error('candidate failed');
      }),
      stop: vi.fn(async () => {}),
    };
    const error = vi.fn();
    const appToken = __fixture.validAppToken('rollback-new', 'AROLLBACK');
    const { fetch } = __fixture.methodFetch({
      'auth.test': {
        body: {
          ok: true,
          user_id: 'UROLLBACKNEW',
          bot_id: 'BROLLBACKNEW',
          team_id: 'TROLLBACKOLD',
        },
      },
      'bots.info': { body: { ok: true, bot: { app_id: 'AROLLBACK' } } },
    });

    const res = await __fixture
      .makeSurfaceApp(fetch, undefined, sockets, { info: vi.fn(), error })
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
        body: JSON.stringify({ botToken: 'xoxb-rollback-new', appToken }),
      });
    put.mockRestore();

    expect(res.status).toBe(400);
    expect(error).toHaveBeenCalledWith(
      'Slack surface connection failed',
      expect.objectContaining({ stage: 'rollback_cleanup', errorCode: 'KMS_DOWN' }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('hidden rollback detail');
  });

  test('serializes a concurrent PUT and DELETE so disconnect runs after the connection mutation', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    let finishReplace!: () => void;
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishReplace = resolve;
          }),
      ),
      stop: vi.fn(async () => {}),
    };
    const appToken = __fixture.validAppToken('put-delete');
    const { fetch } = __fixture.methodFetch({
      'auth.test': { body: { ok: true, user_id: 'UPD', bot_id: 'BPD', team_id: 'TPD' } },
    });
    const surfaceApp = __fixture.makeSurfaceApp(fetch, undefined, sockets);
    const put = surfaceApp.request('/surfaces/slack', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
      body: JSON.stringify({ botToken: 'xoxb-put-delete', appToken }),
    });
    await vi.waitFor(() => expect(sockets.replace).toHaveBeenCalledTimes(1), { timeout: 5_000 });

    const disconnect = surfaceApp.request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets.stop).not.toHaveBeenCalled();

    finishReplace();
    expect((await put).status).toBe(200);
    expect((await disconnect).status).toBe(200);
    expect(sockets.stop).toHaveBeenCalledTimes(1);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toBeUndefined();
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBeNull();
    expect(await __fixture.secrets.get(__fixture.tenantB, __fixture.slackAppTokenKey())).toBeNull();
  });
});
