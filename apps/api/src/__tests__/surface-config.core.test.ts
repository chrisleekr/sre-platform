import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import {
  acceptSurfaceInboundEventTx,
  getSurfaceConfig,
  isChannelSubscribed,
  jobs,
  linkSurfaceInboundJobTx,
  listSubscribedChannels,
  subscribeChannel,
  surfaceInboundEvents,
  surfaceBotTokenKey,
  updateSurfaceInboundState,
  upsertSurfaceConfig,
  type SecretStore,
} from '@sre/db';

import type { FetchLike } from '@sre/surfaces';

// Router under test.
import { surfaceRoutes } from '../surface-config';

interface SlackSocketLifecycle {
  replace(configId: string, appToken: string, appId: string): Promise<void>;
  stop(configId: string): Promise<void>;
  status?(configId: string): {
    state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
    connectedAt: string | null;
    updatedAt: string;
  };
}

interface SanitizedSurface {
  id: string;
  surface: string;
  botUserId: string | null;
  hasBotToken: boolean;
  hasAppToken: boolean;
  runtime?: {
    socket: { state: string } | null;
    inbound: {
      latest: {
        state: string;
        jobStatus: string | null;
        attemptCount: number;
        terminalDisposition: string | null;
        terminalDispositionAt: string | null;
        terminalDispositionEventAt: string | null;
      } | null;
      pendingCount: number;
      failedLast24Hours: number;
    } | null;
  };
}

import { createFixture } from './surface-config.fixture';

const __fixture = createFixture();

describe('surface config CRUD', () => {
  // --- GET /surfaces/slack/available-channels ------------------------------------------------
  // Slack events carry channel IDs (C07…), but the UI invites typing a #name, and isChannelSubscribed
  // compares strings exactly — so every inbound alert is acked 200 and silently dropped. The operator
  // must PICK from the channels the bot can see (conversations.list), storing the id and showing the name.

  test('C1 GET /surfaces returns sanitized configs with hasAppToken/hasBotToken booleans', async () => {
    await __fixture.putSlack(__fixture.orgA, {
      botUserId: 'U-c1',
      appToken: 'xapp-c1',
      botToken: 'xoxb-c1',
    });
    const slack = await __fixture.getSlack(__fixture.orgA);
    // The row's existence IS the connection: no target, no enable flag to project.
    expect(slack).toMatchObject({
      surface: 'slack',
      botUserId: 'U-c1',
      hasAppToken: true,
      hasBotToken: true,
    });
    // The UI needs a stable, non-empty config id for edit and disconnect actions.
    expect(slack?.id).toBeTruthy();
    expect(slack?.id).toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.stringify(await __fixture.listSurfaces(__fixture.orgA));
    expect(body).not.toContain('xapp-c1');
    expect(body).not.toContain('xoxb-c1');
  });

  test('GET /surfaces projects tenant-scoped socket and durable intake health', async () => {
    const config = await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantB, {
      surface: 'slack',
      botUserId: 'U-runtime',
    });
    const receipt = await __fixture.admin.db.transaction((tx) =>
      acceptSurfaceInboundEventTx(tx, {
        tenantId: __fixture.tenantB,
        configId: config.id,
        surface: 'slack',
        deliveryKey: `event:runtime-${randomUUID()}`,
        envelopeType: 'events_api',
        eventType: 'message',
        channel: 'C_RUNTIME',
      }),
    );
    const jobRows = await __fixture.admin.db
      .insert(jobs)
      .values({
        tenantId: __fixture.tenantB,
        type: 'slack.inbound',
        payload: {},
        stream: 'sre:slack-inbound',
        status: 'dead',
      })
      .returning({ id: jobs.id });
    await __fixture.admin.db.transaction((tx) =>
      linkSurfaceInboundJobTx(tx, receipt.row.id, jobRows[0]!.id),
    );
    await updateSurfaceInboundState(__fixture.admin.db, receipt.row.id, {
      state: 'retrying',
      outcome: 'processing_failed',
      attemptCount: 50,
    });
    const terminalDispositionAt = new Date('2026-09-01T01:02:03.456Z');
    const terminalDispositionEventAt = new Date('2026-09-01T01:02:00.123Z');
    await __fixture.admin.db
      .update(surfaceInboundEvents)
      .set({
        terminalDisposition: 'suppressed_provider_control_notification',
        terminalDispositionAt,
        terminalDispositionEventAt,
      })
      .where(eq(surfaceInboundEvents.id, receipt.row.id));
    const now = new Date().toISOString();
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      status: vi.fn((_configId: string) => ({
        state: 'connected' as const,
        connectedAt: now,
        updatedAt: now,
      })),
    };

    const response = await __fixture
      .makeSurfaceApp(undefined, undefined, sockets)
      .request('/surfaces', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
      });
    const body = (await response.json()) as { surfaces: SanitizedSurface[] };

    expect(body.surfaces).toHaveLength(1);
    expect(body.surfaces[0]).toMatchObject({
      id: config.id,
      runtime: {
        socket: { state: 'connected' },
        inbound: {
          latest: {
            state: 'retrying',
            jobStatus: 'dead',
            attemptCount: 50,
            terminalDisposition: 'suppressed_provider_control_notification',
            terminalDispositionAt: terminalDispositionAt.toISOString(),
            terminalDispositionEventAt: terminalDispositionEventAt.toISOString(),
          },
          pendingCount: 0,
          failedLast24Hours: 1,
        },
      },
    });
  });

  test('C2 PUT writes both secrets; partial PUTs merge and never wipe', async () => {
    const appToken1 = __fixture.validAppToken('one');
    const appToken2 = __fixture.validAppToken('two');
    const r1 = await __fixture.putSlack(__fixture.orgA, {
      botUserId: 'U-c2',
      appToken: appToken1,
      botToken: 'xoxb-1',
    });
    expect(r1.status).toBe(200);
    expect(await __fixture.secrets.get(__fixture.tenantA, __fixture.slackAppTokenKey())).toBe(
      appToken1,
    );
    expect(await __fixture.secrets.get(__fixture.tenantA, surfaceBotTokenKey('slack'))).toBe(
      'xoxb-1',
    );

    // Second PUT with ONLY appToken leaves botToken intact.
    const r2 = await __fixture.putSlack(__fixture.orgA, { appToken: appToken2 });
    expect(r2.status).toBe(200);
    expect(await __fixture.secrets.get(__fixture.tenantA, __fixture.slackAppTokenKey())).toBe(
      appToken2,
    );
    expect(await __fixture.secrets.get(__fixture.tenantA, surfaceBotTokenKey('slack'))).toBe(
      'xoxb-1',
    ); // intact

    // PUT with ONLY botToken (no botUserId) must not wipe the previously-set botUserId (merge guard).
    const r3 = await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-3' });
    expect(r3.status).toBe(200);
    expect((await __fixture.getSlack(__fixture.orgA))?.botUserId).toBe('U-c2');
    expect(await __fixture.secrets.get(__fixture.tenantA, surfaceBotTokenKey('slack'))).toBe(
      'xoxb-3',
    );
  });

  test('C3 PUT for a non-slack surface is rejected (400)', async () => {
    const res = await __fixture.putSurface(__fixture.orgA, 'github', {});
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  test('C4 POST /slack/test validates the token via auth.test and persists the discovered botUserId', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-good' });
    const { fetch, calls } = __fixture.methodFetch({
      'auth.test': {
        body: { ok: true, user_id: 'U0BOT', bot_id: 'B0BOT', team_id: 'T0' },
      },
      'users.info': { body: { ok: true, user: { id: 'U0BOT' } } },
    });
    const res = await __fixture.makeSurfaceApp(fetch).request('/surfaces/slack/test', {
      method: 'POST',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, botUserId: 'U0BOT', team: 'T0' });
    // The probe hit Slack auth.test FIRST, exactly once, with the stored bot token as a bearer. adds
    // a second call behind it (the users.info scope probe, covered by its own tests below), so this pins
    // auth.test's own call rather than the total — which is no longer 1, by design.
    expect(calls.filter((c) => c.url.endsWith('/auth.test'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/bots.info'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith('/apps.connections.open'))).toHaveLength(1);
    expect(calls[0]!.url.endsWith('/auth.test')).toBe(true);
    expect(calls[0]!.headers.authorization).toBe('Bearer xoxb-good');
    // The discovered bot user id is persisted on the config row.
    expect((await __fixture.getSlack(__fixture.orgA))?.botUserId).toBe('U0BOT');
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantA, 'slack')).toMatchObject({
      botId: 'B0BOT',
      appId: __fixture.TEST_APP_ID,
    });
  });

  test('POST /slack/test rejects bot and app tokens from different Slack apps without changing identity', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-test-identity' });
    const before = await getSurfaceConfig(__fixture.app.db, __fixture.tenantA, 'slack');
    const { fetch, calls } = __fixture.methodFetch({
      'auth.test': {
        body: { ok: true, user_id: 'UOTHER', bot_id: 'BOTHER', team_id: 'TOTHER' },
      },
      'bots.info': { body: { ok: true, bot: { app_id: 'AOTHERAPP' } } },
    });

    const res = await __fixture.makeSurfaceApp(fetch).request('/surfaces/slack/test', {
      method: 'POST',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });

    expect(res.status).toBe(400);
    expect(calls.some((call) => call.url.endsWith('/apps.connections.open'))).toBe(false);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantA, 'slack')).toMatchObject({
      botUserId: before!.botUserId,
      teamId: before!.teamId,
      appId: before!.appId,
    });
  });

  test('C5a POST /slack/test with no stored bot token is a 4xx, not a 500', async () => {
    // A saved config for B, but no bot token.
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantB, { surface: 'slack' });
    const { fetch, calls } = __fixture.fakeFetch({ ok: true, user_id: 'x' });
    const res = await __fixture.makeSurfaceApp(fetch).request('/surfaces/slack/test', {
      method: 'POST',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(calls).toHaveLength(0); // never calls Slack without a token
  });

  test('C5b POST /slack/test surfaces a Slack ok:false as a 4xx with the error, not a 500', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-bad' });
    // HTTP 200, but the Slack body reports ok:false.
    const { fetch } = __fixture.fakeFetch({ ok: false, error: 'invalid_auth' });
    const res = await __fixture.makeSurfaceApp(fetch).request('/surfaces/slack/test', {
      method: 'POST',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).not.toBe(true);
    expect(body.error).toContain('invalid_auth');
  });

  test('C5c POST /slack/test maps a network error to a 4xx, not a 500', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-neterr' });
    const throwing: FetchLike = async () => {
      throw new Error('network down');
    };
    const res = await __fixture.makeSurfaceApp(throwing).request('/surfaces/slack/test', {
      method: 'POST',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  // --- Required identity validation and optional attribution probe --------------------------------
  // bots.info requires users:read, so a missing required scope fails connection validation before any
  // write. users:read.email remains optional and cannot be detected: users.info succeeds without it and
  // merely omits profile.email.
  //
  // The optional users.info probe remains one-directional: success or transport failure cannot prove
  // users:read.email is present, so neither may produce a false "scopes OK" claim.

  test('PUT rejects bots.info missing_scope before config, secret, or socket writes', async () => {
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    const sockets: SlackSocketLifecycle = {
      replace: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const { fetch, calls } = __fixture.methodFetch({
      'auth.test': {
        body: { ok: true, user_id: 'UREQUIRED', bot_id: 'BREQUIRED', team_id: 'TREQUIRED' },
      },
      'bots.info': { body: { ok: false, error: 'missing_scope' } },
    });

    const res = await __fixture
      .makeSurfaceApp(fetch, undefined, sockets)
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
        body: JSON.stringify({
          botToken: 'xoxb-missing-users-read',
          appToken: __fixture.validAppToken('missing-users-read'),
        }),
      });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error?: string }).toMatchObject({ error: 'missing_scope' });
    expect(calls.some((call) => call.url.endsWith('/apps.connections.open'))).toBe(false);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantB, 'slack')).toBeUndefined();
    expect(await __fixture.secrets.get(__fixture.tenantB, surfaceBotTokenKey('slack'))).toBeNull();
    expect(await __fixture.secrets.get(__fixture.tenantB, __fixture.slackAppTokenKey())).toBeNull();
    expect(sockets.replace).not.toHaveBeenCalled();
  });

  test('scope probe: a users.info that succeeds adds no warning and never claims scopes are OK', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-220-ok' });
    const { fetch, calls } = __fixture.methodFetch({
      'auth.test': { body: { ok: true, user_id: 'U0OK220', team_id: 'T0' } },
      // An empty profile is what a BOT user normally returns, with or without users:read.email. That is
      // precisely why a success can only ever prove users:read, and can never vouch for the email scope.
      'users.info': { body: { ok: true, user: { id: 'U0OK220', profile: {} } } },
    });
    const res = await __fixture.makeSurfaceApp(fetch).request('/surfaces/slack/test', {
      method: 'POST',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; warning?: string };
    expect(body.ok).toBe(true);
    expect(body.warning).toBeUndefined();
    // Silence is the ONLY thing a passing probe earns. Any affirmative word about scopes here would be a
    // claim the probe cannot support, so the success response says nothing about scopes at all.
    expect(JSON.stringify(body)).not.toMatch(/users:read/);
    // ...and the silence is meaningful only because the probe actually RAN.
    expect(__fixture.usersInfoProbe(calls)).toBeDefined();
  });

  test('scope probe: an unreachable users.info stays silent (no invented warning)', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-220-down' });
    const { fetch, calls } = __fixture.methodFetch({
      'auth.test': { body: { ok: true, user_id: 'U0DOWN220', team_id: 'T0' } },
      'users.info': { throws: 'network down' }, // also stands in for an AbortSignal timeout
    });
    const res = await __fixture.makeSurfaceApp(fetch).request('/surfaces/slack/test', {
      method: 'POST',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    // auth.test already proved the token, so the connection is good and the probe is advisory: a Slack we
    // could not reach says NOTHING about scopes. Fail direction is silence — an invented warning would
    // send the operator to fix a non-problem, and a failed connect would be a lie about a working token.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; botUserId?: string; warning?: string };
    expect(body.ok).toBe(true);
    expect(body.botUserId).toBe('U0DOWN220');
    expect(body.warning).toBeUndefined();
    expect(__fixture.usersInfoProbe(calls)).toBeDefined(); // it tried, then swallowed
  });

  test('scope probe: a failed auth.test keeps its 400 and never probes users.info', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-220-badauth' });
    const { fetch, calls } = __fixture.methodFetch({
      'auth.test': { body: { ok: false, error: 'invalid_auth' } },
      'users.info': { body: { ok: true, user: { profile: {} } } }, // routed, and must stay UNCALLED
    });
    const res = await __fixture.makeSurfaceApp(fetch).request('/surfaces/slack/test', {
      method: 'POST',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    // The scope probe changes nothing here: a bad token is the whole story.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok?: boolean; error?: string; warning?: string };
    expect(body.ok).not.toBe(true);
    expect(body.error).toContain('invalid_auth');
    expect(body.warning).toBeUndefined();
    // A rejected token fails users.info too, so probing could only stack a bogus scope warning on top of
    // the real problem — and burn a Slack call to do it.
    expect(__fixture.usersInfoProbe(calls)).toBeUndefined();
  });

  test('POST /slack/test rejects bots.info missing_scope without replacing persisted identity', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-required-saved' });
    const before = await getSurfaceConfig(__fixture.app.db, __fixture.tenantA, 'slack');
    const { fetch, calls } = __fixture.methodFetch({
      'auth.test': {
        body: {
          ok: true,
          user_id: 'UNEWREQUIRED',
          bot_id: 'BNEWREQUIRED',
          team_id: 'TNEWREQUIRED',
        },
      },
      'bots.info': { body: { ok: false, error: 'missing_scope' } },
    });
    const res = await __fixture.makeSurfaceApp(fetch).request('/surfaces/slack/test', {
      method: 'POST',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error?: string }).toMatchObject({ error: 'missing_scope' });
    expect(calls.some((call) => call.url.endsWith('/apps.connections.open'))).toBe(false);
    expect(await getSurfaceConfig(__fixture.app.db, __fixture.tenantA, 'slack')).toMatchObject({
      botUserId: before!.botUserId,
      botId: before!.botId,
      teamId: before!.teamId,
      appId: before!.appId,
    });
  });

  test('C6 DELETE /slack removes the config and both secrets', async () => {
    await __fixture.putSlack(__fixture.orgA, { appToken: 'xapp-c6', botToken: 'xoxb-c6' });
    const del = await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(del.status).toBe(200);
    expect(await __fixture.getSlack(__fixture.orgA)).toBeUndefined();
    expect(await __fixture.secrets.get(__fixture.tenantA, __fixture.slackAppTokenKey())).toBeNull();
    expect(await __fixture.secrets.get(__fixture.tenantA, surfaceBotTokenKey('slack'))).toBeNull();
  });

  // The config row goes LAST. Every step before it is idempotent, so a failed secret delete leaves the
  // surface still visible and the whole DELETE re-runnable. Deleting the config row first left the tenant
  // "disconnected" in the UI while tenant_secrets still held the AES-encrypted bot token — a decryptable
  // token behind a connection nobody can see, and no way to retry the delete.
  test('C20 a failing secret delete leaves the config row PRESENT so the disconnect can be retried', async () => {
    await __fixture.putSlack(__fixture.orgA, { appToken: 'xapp-c20', botToken: 'xoxb-c20' });
    const brokenSecrets: SecretStore = {
      ...__fixture.secrets,
      delete: () => Promise.reject(new Error('secret store down')),
    };
    const h = new Hono();
    h.route(
      '/surfaces',
      surfaceRoutes({
        auth: __fixture.auth,
        db: __fixture.app.db,
        secrets: brokenSecrets,
        fetch: globalThis.fetch as unknown as FetchLike,
      }),
    );
    const del = await h.request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(del.status).toBe(500);

    // Still connected, and the token is still ours to delete on the retry.
    expect(await __fixture.getSlack(__fixture.orgA)).toBeDefined();
    expect(await __fixture.secrets.get(__fixture.tenantA, surfaceBotTokenKey('slack'))).toBe(
      'xoxb-c20',
    );

    // The retry (with a working store) completes the disconnect.
    const retry = await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(retry.status).toBe(200);
    expect(await __fixture.getSlack(__fixture.orgA)).toBeUndefined();
    expect(await __fixture.secrets.get(__fixture.tenantA, surfaceBotTokenKey('slack'))).toBeNull();
  });

  test('C7 GET /slack/channels lists the subscribed channels', async () => {
    await subscribeChannel(__fixture.app.db, {
      tenantId: __fixture.tenantA,
      surface: 'slack',
      channel: 'C-7a',
    });
    await subscribeChannel(__fixture.app.db, {
      tenantId: __fixture.tenantA,
      surface: 'slack',
      channel: 'C-7b',
      enabled: false,
    });
    const res = await __fixture.makeSurfaceApp().request('/surfaces/slack/channels', {
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: Array<{ channel: string; enabled: boolean }> };
    const byChannel = new Map(body.channels.map((c) => [c.channel, c.enabled]));
    expect(byChannel.get('C-7a')).toBe(true);
    expect(byChannel.get('C-7b')).toBe(false);
  });

  test('C8 PUT /slack/channels/:channel is idempotent and toggles enabled', async () => {
    const ch = 'C00000C8X'; // a real Slack conversation id: the route rejects anything else
    const p1 = await __fixture.makeSurfaceApp().request(`/surfaces/slack/channels/${ch}`, {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({ enabled: true }),
    });
    expect(p1.status).toBe(200);
    const p2 = await __fixture.makeSurfaceApp().request(`/surfaces/slack/channels/${ch}`, {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({ enabled: true }),
    });
    expect(p2.status).toBe(200);
    // Idempotent: exactly one row, still enabled.
    let rows = await listSubscribedChannels(__fixture.app.db, __fixture.tenantA, 'slack');
    expect(rows.filter((r) => r.channel === ch)).toHaveLength(1);
    expect(await isChannelSubscribed(__fixture.app.db, __fixture.tenantA, 'slack', ch)).toBe(true);
    // Toggle off.
    const p3 = await __fixture.makeSurfaceApp().request(`/surfaces/slack/channels/${ch}`, {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({ enabled: false }),
    });
    expect(p3.status).toBe(200);
    expect(await isChannelSubscribed(__fixture.app.db, __fixture.tenantA, 'slack', ch)).toBe(false);
    rows = await listSubscribedChannels(__fixture.app.db, __fixture.tenantA, 'slack');
    expect(rows.filter((r) => r.channel === ch)).toHaveLength(1); // still one row, not two
  });
});
