import { describe, expect, test } from 'vitest';

import { isChannelSubscribed, surfaceBotTokenKey, upsertSurfaceConfig } from '@sre/db';

import type { FetchLike } from '@sre/surfaces';

import { createFixture } from './surface-config.fixture';

const __fixture = createFixture();

describe('surface config CRUD', () => {
  // --- GET /surfaces/slack/available-channels ------------------------------------------------
  // Slack events carry channel IDs (C07…), but the UI invites typing a #name, and isChannelSubscribed
  // compares strings exactly — so every inbound alert is acked 200 and silently dropped. The operator
  // must PICK from the channels the bot can see (conversations.list), storing the id and showing the name.

  const CONVERSATIONS_LIST = 'https://slack.com/api/conversations.list';

  interface AvailableChannel {
    id: string;
    name: string;
  }

  test('C9 a tenant cannot see or mutate another tenant’s surface (RLS)', async () => {
    // Start B clean, then A creates its surface.
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    await __fixture.putSlack(__fixture.orgA, { botUserId: 'U-c9-a', botToken: 'xoxb-a-rls' });

    // B sees none of A's surfaces.
    expect(await __fixture.listSurfaces(__fixture.orgB)).toHaveLength(0);

    // B's DELETE only affects B: A's surface + secret are untouched.
    const delB = await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    expect(delB.status).toBe(200);
    expect((await __fixture.getSlack(__fixture.orgA))?.botUserId).toBe('U-c9-a');
    expect(await __fixture.secrets.get(__fixture.tenantA, surfaceBotTokenKey('slack'))).toBe(
      'xoxb-a-rls',
    );

    // B's channel PUT only touches B: A's channel list does not gain B's channel.
    const putB = await __fixture.makeSurfaceApp().request('/surfaces/slack/channels/C0BONLY1', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgB)),
      body: JSON.stringify({ enabled: true }),
    });
    expect(putB.status).toBe(200);
    const aChannels = await __fixture.makeSurfaceApp().request('/surfaces/slack/channels', {
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    const aCh = ((await aChannels.json()) as { channels: Array<{ channel: string }> }).channels;
    expect(aCh.some((c) => c.channel === 'C0BONLY1')).toBe(false);
    expect(
      await isChannelSubscribed(__fixture.app.db, __fixture.tenantB, 'slack', 'C0BONLY1'),
    ).toBe(true);
  });

  test('C11 GET /slack/available-channels returns the channels Slack can see (id + name)', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-c11' });
    const { fetch, calls } = __fixture.fakeFetch({
      ok: true,
      channels: [
        { id: 'C07EWAS8132', name: 'homelab-notification' },
        { id: 'C0999OPS', name: 'ops' },
      ],
    });
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: AvailableChannel[] };
    expect(body.channels).toHaveLength(2);
    expect(body.channels[0]).toMatchObject({ id: 'C07EWAS8132', name: 'homelab-notification' });

    // It asked Slack, with the stored bot token as a bearer (never on the URL).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.split('?')[0]).toBe(CONVERSATIONS_LIST);
    expect(calls[0]!.headers.authorization).toBe('Bearer xoxb-c11');
    expect(calls[0]!.url).not.toContain('xoxb-c11');
  });

  test('C12 a Slack ok:false missing_scope answers 4xx naming the required channels:read scope', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-c12' });
    // Slack answers HTTP 200 with ok:false — branching on the status alone would report success.
    const { fetch } = __fixture.fakeFetch({ ok: false, error: 'missing_scope' });
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500); // an operator-fixable app config, never a 500
    const body = (await res.json()) as { error?: string; channels?: unknown[] };
    expect(body.channels).toBeUndefined(); // not an empty list masquerading as "no channels"
    expect(body.error ?? '').toContain('channels:read'); // names the scope the operator must add
  });

  // Verified against the live workspace: Slack's `needed` for conversations.list lists all four
  // conversation scopes, not the two our types= subset implies. Echoing Slack's own answer beats any
  // list we hardcode — a guess could send the operator to add scopes that still leave the call failing.
  test('C12b missing_scope reports the scopes Slack itself named, and what the token has', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-c12b' });
    const { fetch } = __fixture.fakeFetch({
      ok: false,
      error: 'missing_scope',
      needed: 'channels:read,groups:read,mpim:read,im:read',
      provided: 'chat:write,incoming-webhook',
    });
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? '').toContain('channels:read,groups:read,mpim:read,im:read');
    expect(body.error ?? '').toContain('chat:write,incoming-webhook'); // what it has, so the gap is obvious
  });

  // T2 characterization: a Slack ok:false that is NEITHER ratelimited NOR missing_scope is the generic
  // third arm of slackAvailableChannels — surfaced verbatim as "Slack rejected the request: <err>" with a
  // 400 (operator-fixable app state, never a 500). Locked before the Slack-helper extraction so the refactor
  // cannot silently change the status or drop the reason.
  test('a generic Slack ok:false refusal is a 400 naming the error, not a 500', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-generic' });
    const { fetch } = __fixture.fakeFetch({ ok: false, error: 'internal_error' });
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; channels?: unknown };
    expect(body.channels).toBeUndefined();
    expect(body.error ?? '').toContain('Slack rejected the request: internal_error');
  });

  // a broken 200 (body fails to parse) must be an operator-facing 400, not a 500. The shared
  // slackApiGet parses best-effort and returns an undefined body, which `!body?.ok` treats as not-ok, so
  // the route surfaces the generic conversations_list_failed reason rather than throwing inside res.json().
  test('a 200 with an unparseable body is a 400 (conversations_list_failed), not a 500', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-brokenbody' });
    const brokenFetch: FetchLike = async (url, init) => {
      void url;
      void init;
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('unexpected token < in JSON');
        },
      };
    };
    const res = await __fixture
      .makeSurfaceApp(brokenFetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; channels?: unknown };
    expect(body.channels).toBeUndefined();
    expect(body.error ?? '').toContain('conversations_list_failed');
  });

  test('C13 available-channels requires auth and never returns the bot token', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-c13-secret' });
    const { fetch, calls } = __fixture.fakeFetch({
      ok: true,
      channels: [{ id: 'C1', name: 'general' }],
    });

    const anon = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels');
    expect(anon.status).toBe(401);
    expect(calls).toHaveLength(0); // never calls Slack for an unauthenticated caller

    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(JSON.stringify(await res.json())).not.toContain('xoxb-c13-secret');
  });

  // conversations.list paginates on next_cursor. Every other test feeds ONE page, so the cursor loop body
  // ran exactly once and a misnamed `cursor` param (endless spin) or a misread `next_cursor` (page 2
  // silently dropped) would pass unnoticed.
  test('C14 available-channels follows next_cursor: page 2 carries the cursor and both pages concatenate', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-c14' });
    const { fetch, calls } = __fixture.queuedFetch([
      {
        ok: true,
        channels: [{ id: 'C0PAGE1', name: 'page-one' }],
        response_metadata: { next_cursor: 'CUR2' },
      },
      { ok: true, channels: [{ id: 'C0PAGE2', name: 'page-two' }] }, // no cursor: the last page
    ]);
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: AvailableChannel[] };
    expect(body.channels.map((c) => c.id)).toEqual(['C0PAGE1', 'C0PAGE2']); // both pages, in order

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).not.toContain('cursor=');
    expect(calls[1]!.url).toContain('cursor=CUR2'); // the 2nd request carries Slack's cursor
  });

  test('C15 available-channels stops at the page cap instead of spinning on a repeated cursor', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-c15' });
    // A pathological Slack that returns the SAME cursor forever: uncapped, the handler never returns.
    const { fetch, calls } = __fixture.fakeFetch({
      ok: true,
      channels: [{ id: 'C0LOOP', name: 'loop' }],
      response_metadata: { next_cursor: 'SAME' },
    });
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBe(200); // returns what it read rather than hanging
    expect(calls.length).toBeLessThanOrEqual(50); // the page cap bounds the loop
    expect(calls.length).toBeGreaterThan(1);
  });

  test('C16 a Slack 429 answers 4xx naming retry-after, not an opaque "HTTP 429"', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-c16' });
    const { fetch } = __fixture.fakeFetch({}, false, 429);
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? '').toContain('rate-limited');
    expect(body.error ?? '').toContain('retry-after');
  });

  test('C17 available-channels with no stored bot token is a 4xx and never calls Slack', async () => {
    // Mirrors the sibling assertion on /slack/test: no token is a caller-fixable condition, never a 500.
    await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
    });
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantB, { surface: 'slack' });
    const { fetch, calls } = __fixture.fakeFetch({
      ok: true,
      channels: [{ id: 'C1', name: 'general' }],
    });
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
      });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(calls).toHaveLength(0); // never calls Slack without a token
  });

  // --- truncation signal + per-tenant cache ---------------------------------------------------
  // conversations.list is Tier-2 rate-limited and the page cap silently drops whatever sat past page 50.
  // The operator must be TOLD the list is partial, and repeated dashboard loads must not re-hammer Slack.

  test('hitting the page cap reports truncated:true (the picker is missing channels)', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-204-c2' });
    // A Slack that always hands back another cursor: the loop stops at the cap with channels unread.
    const { fetch } = __fixture.fakeFetch({
      ok: true,
      channels: [{ id: 'C0LOOP204', name: 'loop' }],
      response_metadata: { next_cursor: 'SAME' },
    });
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: AvailableChannel[]; truncated?: boolean };
    expect(body.channels.length).toBeGreaterThan(0); // still serves what it read
    expect(body.truncated).toBe(true);
  });

  test('pagination that completes normally reports truncated:false', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-204-c3' });
    const { fetch } = __fixture.queuedFetch([
      {
        ok: true,
        channels: [{ id: 'C0P1', name: 'p1' }],
        response_metadata: { next_cursor: 'CUR2' },
      },
      { ok: true, channels: [{ id: 'C0P2', name: 'p2' }] }, // no cursor: exhausted
    ]);
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    const body = (await res.json()) as { channels: AvailableChannel[]; truncated?: boolean };
    expect(body.channels.map((c) => c.id)).toEqual(['C0P1', 'C0P2']);
    expect(body.truncated).toBe(false);
  });

  // Slack answers HTTP 200 with `ok:false, error:'ratelimited'` on some rate-limit paths, which today
  // falls through to the generic "Slack rejected the request: ratelimited" — the operator cannot tell
  // that from a scope/permission refusal, and there is nothing to act on. Map it like the HTTP-429 path.
  test('a body-level ok:false ratelimited is reported as a rate limit, not a generic refusal', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-204-c4' });
    const { fetch } = __fixture.fakeFetch({ ok: false, error: 'ratelimited' });
    const res = await __fixture
      .makeSurfaceApp(fetch)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    // The same RATE_LIMIT_MESSAGE the HTTP-429 path returns: one rate limit, one thing to tell the operator.
    expect(body.error ?? '').toContain('rate-limited');
    expect(body.error ?? '').not.toContain('Slack rejected the request: ratelimited');
  });

  test('a second call within the TTL is served from the cache: Slack is called once', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-204-c1' });
    const cache = __fixture.fakeChannelsCache();
    const { fetch, calls } = __fixture.fakeFetch({
      ok: true,
      channels: [{ id: 'C0CACHE', name: 'cached' }],
    });

    const first = await __fixture
      .makeSurfaceApp(fetch, cache)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(first.status).toBe(200);
    const second = await __fixture
      .makeSurfaceApp(fetch, cache)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(second.status).toBe(200);

    expect(calls).toHaveLength(1); // the second read never reached Slack
    const body = (await second.json()) as { channels: AvailableChannel[]; truncated?: boolean };
    expect(body.channels).toEqual([{ id: 'C0CACHE', name: 'cached' }]);
    expect(body.truncated).toBe(false); // the cached entry carries the truncation flag too
  });

  test('the cache is per-tenant: tenant A’s channels are never served to tenant B', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-204-c6a' });
    await __fixture.putSlack(__fixture.orgB, { botToken: 'xoxb-204-c6b' });
    const cache = __fixture.fakeChannelsCache();
    const { fetch, calls } = __fixture.queuedFetch([
      { ok: true, channels: [{ id: 'C0AONLY', name: 'a-only' }] },
      { ok: true, channels: [{ id: 'C0BONLY204', name: 'b-only' }] },
    ]);

    const a = await __fixture
      .makeSurfaceApp(fetch, cache)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    const b = await __fixture
      .makeSurfaceApp(fetch, cache)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgB)),
      });
    const aBody = (await a.json()) as { channels: AvailableChannel[] };
    const bBody = (await b.json()) as { channels: AvailableChannel[] };

    expect(aBody.channels.map((c) => c.id)).toEqual(['C0AONLY']);
    // B must NOT read A's cached list — a cross-tenant leak of the workspace's channel names.
    expect(bBody.channels.map((c) => c.id)).toEqual(['C0BONLY204']);
    expect(calls).toHaveLength(2); // each tenant hit Slack with its own token
    expect(calls[1]!.headers.authorization).toBe('Bearer xoxb-204-c6b');
  });

  test('a Slack failure is never cached and never becomes an empty channel list', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-204-c7' });
    const cache = __fixture.fakeChannelsCache();
    const failing = __fixture.fakeFetch({}, false, 429);
    const failed = await __fixture
      .makeSurfaceApp(failing.fetch, cache)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(failed.status).toBe(400);
    expect(((await failed.json()) as { channels?: unknown }).channels).toBeUndefined();
    expect(cache.sets).toHaveLength(0); // a failure must never be cached (nor an empty list)

    // The very next call, once Slack recovers, serves the real list rather than a cached "no channels".
    const ok = __fixture.fakeFetch({ ok: true, channels: [{ id: 'C0BACK', name: 'back' }] });
    const res = await __fixture
      .makeSurfaceApp(ok.fetch, cache)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    const body = (await res.json()) as { channels: AvailableChannel[] };
    expect(body.channels.map((c) => c.id)).toEqual(['C0BACK']);
  });

  // A cache is an optimisation. It must never be able to fail the request it exists to speed up: a Valkey
  // outage on READ is a miss (go to Slack), and on WRITE is nothing at all (the operator already waited
  // for the Slack read — throwing it away and blaming Slack for a Valkey fault is the worst of both).
  test('a cache READ fault is a miss: the route still serves the live Slack list (200)', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-204-getfault' });
    const cache = __fixture.fakeChannelsCache({ get: true });
    const { fetch, calls } = __fixture.fakeFetch({
      ok: true,
      channels: [{ id: 'C0LIVE', name: 'live' }],
    });
    const res = await __fixture
      .makeSurfaceApp(fetch, cache)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { channels: AvailableChannel[] }).channels).toEqual([
      { id: 'C0LIVE', name: 'live' },
    ]);
    expect(calls).toHaveLength(1);
  });

  test('a cache WRITE fault never discards a successful Slack read (200, not 400)', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-204-setfault' });
    const cache = __fixture.fakeChannelsCache({ set: true });
    const { fetch } = __fixture.fakeFetch({ ok: true, channels: [{ id: 'C0KEEP', name: 'keep' }] });
    const res = await __fixture
      .makeSurfaceApp(fetch, cache)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(res.status).toBe(200); // NOT a 400 blaming Slack for a Valkey fault
    const body = (await res.json()) as { channels: AvailableChannel[]; truncated: boolean };
    expect(body.channels).toEqual([{ id: 'C0KEEP', name: 'keep' }]);
    expect(body.truncated).toBe(false);
  });
});
