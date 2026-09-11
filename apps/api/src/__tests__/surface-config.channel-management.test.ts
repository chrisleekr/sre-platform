import { describe, expect, test } from 'vitest';

import { isChannelSubscribed, listSubscribedChannels, subscribeChannel } from '@sre/db';

import { createFixture } from './surface-config.fixture';

const __fixture = createFixture();

describe('surface config CRUD', () => {
  // --- GET /surfaces/slack/available-channels ------------------------------------------------
  // Slack events carry channel IDs (C07…), but the UI invites typing a #name, and isChannelSubscribed
  // compares strings exactly — so every inbound alert is acked 200 and silently dropped. The operator
  // must PICK from the channels the bot can see (conversations.list), storing the id and showing the name.

  interface AvailableChannel {
    id: string;
    name: string;
  }

  // The list is DERIVED from the bot token, so the cache is keyed on the token. If a repointed tenant
  // could read the OLD workspace's list, the operator would pick a channel id that matches no inbound
  // event — the silently-dead inbound this pick-list was built to prevent. Keying on the token also
  // beats invalidate-on-write, which cannot be made correct: a GET holding the old token can finish (up to
  // 50 pages x 15s) and write the stale list back AFTER any delete.
  test('after a token change the GET does NOT serve the previous token’s cached list', async () => {
    const cache = __fixture.fakeChannelsCache();
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-204-old' });

    // Warm the cache under the OLD token.
    const old = __fixture.fakeFetch({
      ok: true,
      channels: [{ id: 'C0OLDWS', name: 'old-workspace' }],
    });
    const first = await __fixture
      .makeSurfaceApp(old.fetch, cache)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    expect(((await first.json()) as { channels: AvailableChannel[] }).channels).toEqual([
      { id: 'C0OLDWS', name: 'old-workspace' },
    ]);

    // Repoint the tenant at a different workspace.
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-204-new' });

    const fresh = __fixture.fakeFetch({
      ok: true,
      channels: [{ id: 'C0NEWWS', name: 'new-workspace' }],
    });
    const res = await __fixture
      .makeSurfaceApp(fresh.fetch, cache)
      .request('/surfaces/slack/available-channels', {
        headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
      });
    const body = (await res.json()) as { channels: AvailableChannel[] };
    // The NEW workspace's channels, read live with the new token — never the old cached list.
    expect(body.channels).toEqual([{ id: 'C0NEWWS', name: 'new-workspace' }]);
    expect(fresh.calls).toHaveLength(1);
    expect(fresh.calls[0]!.headers.authorization).toBe('Bearer xoxb-204-new');
  });

  // a subscribed channel is the ONLY inbound gate, so a row holding a typed "#name" (which no
  // inbound event can ever carry) silently drops every message in that channel. Reject it at the boundary.
  test('C18 PUT /slack/channels/:channel rejects anything that is not a Slack channel ID', async () => {
    for (const bad of ['%23ops', 'ops', 'Deploys', 'C-lower']) {
      const res = await __fixture.makeSurfaceApp().request(`/surfaces/slack/channels/${bad}`, {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error ?? '').toContain('Slack channel ID'); // actionable, not just "invalid"
    }
    // ...and a real ID still passes.
    const ok = await __fixture.makeSurfaceApp().request('/surfaces/slack/channels/C07EWAS8132', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({ enabled: true, name: '#homelab-notification' }),
    });
    expect(ok.status).toBe(200);
  });

  // Disconnect must disarm the inbound gate: re-connecting the same workspace would otherwise instantly
  // re-arm every previously subscribed channel, with no operator action and no UI hint. Soft-disable, not
  // delete — the row is the only channel_id -> name mapping, and history would render a bare "C07…".
  test('C19 DELETE /slack disables every inbound channel but keeps the rows (and their names)', async () => {
    await __fixture.putSlack(__fixture.orgA, { botToken: 'xoxb-c19', appToken: 'xapp-c19' });
    await subscribeChannel(__fixture.app.db, {
      tenantId: __fixture.tenantA,
      surface: 'slack',
      channel: 'C0DISC19',
      channelName: '#disconnect-me',
      enabled: true,
    });
    expect(
      await isChannelSubscribed(__fixture.app.db, __fixture.tenantA, 'slack', 'C0DISC19'),
    ).toBe(true);

    const del = await __fixture.makeSurfaceApp().request('/surfaces/slack', {
      method: 'DELETE',
      headers: __fixture.authH(await __fixture.sign(__fixture.orgA)),
    });
    expect(del.status).toBe(200);

    // The gate is disarmed...
    expect(
      await isChannelSubscribed(__fixture.app.db, __fixture.tenantA, 'slack', 'C0DISC19'),
    ).toBe(false);
    // ...but the row (and the name history renders) survives.
    const row = (await listSubscribedChannels(__fixture.app.db, __fixture.tenantA, 'slack')).find(
      (r) => r.channel === 'C0DISC19',
    );
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(false);
    expect(row!.channelName).toBe('#disconnect-me');
  });
});
