import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, tenants, inboundChannels, type DbHandle } from '../index';
import {
  subscribeChannel,
  isChannelSubscribed,
  listSubscribedChannels,
  disableInboundChannels,
  type SubscribeChannel,
} from '../inbound-repo';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(inboundChannels).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('inbound channel subscription repo + RLS', () => {
  test('isChannelSubscribed: true for enabled, false for unsubscribed, false for disabled [C3]', async () => {
    await subscribeChannel(app.db, { tenantId: tenantA, surface: 'slack', channel: 'C-sub' });
    await subscribeChannel(app.db, {
      tenantId: tenantA,
      surface: 'slack',
      channel: 'C-dis',
      enabled: false,
    });

    expect(await isChannelSubscribed(app.db, tenantA, 'slack', 'C-sub')).toBe(true);
    expect(await isChannelSubscribed(app.db, tenantA, 'slack', 'C-none')).toBe(false);
    expect(await isChannelSubscribed(app.db, tenantA, 'slack', 'C-dis')).toBe(false);
  });

  test('subscribeChannel is idempotent on (tenant, surface, channel); latest enabled wins [C4]', async () => {
    await subscribeChannel(app.db, {
      tenantId: tenantA,
      surface: 'slack',
      channel: 'C-idem',
      enabled: true,
    });
    await subscribeChannel(app.db, {
      tenantId: tenantA,
      surface: 'slack',
      channel: 'C-idem',
      enabled: false,
    });

    const rows = await listSubscribedChannels(app.db, tenantA, 'slack');
    const forChannel = rows.filter((r) => r.channel === 'C-idem');
    expect(forChannel).toHaveLength(1); // idempotent upsert: one row, not two
    expect(forChannel[0]!.enabled).toBe(false); // the later enabled value won
    // and the effective subscription reflects the disabled state
    expect(await isChannelSubscribed(app.db, tenantA, 'slack', 'C-idem')).toBe(false);
  });

  // the operator picks a channel from Slack's conversations.list, so the row stores the channel
  // ID (what Slack events carry) AND the human-readable name (what the dashboard shows). Re-subscribing
  // a channel the operator previously turned off must revive the SAME row, never a duplicate.
  test('re-subscribing a disabled channel revives the same row and stores the display name', async () => {
    const channel = 'C07EWAS8132';
    const channelName = '#homelab-notification';
    const sub = (enabled: boolean): SubscribeChannel => ({
      tenantId: tenantA,
      surface: 'slack',
      channel,
      channelName,
      enabled,
    });

    await subscribeChannel(app.db, sub(true));
    await subscribeChannel(app.db, sub(false)); // operator turns it off
    await subscribeChannel(app.db, sub(true)); // ...and later turns it back on

    const rows = (await listSubscribedChannels(app.db, tenantA, 'slack')).filter(
      (r) => r.channel === channel,
    );
    expect(rows).toHaveLength(1); // idempotent upsert: revived, not duplicated
    expect(rows[0]!.enabled).toBe(true);
    expect(await isChannelSubscribed(app.db, tenantA, 'slack', channel)).toBe(true);
    // The display name rides along so the dashboard can render "#homelab-notification", not "C07EWAS8132".
    expect(rows[0]!.channelName).toBe(channelName);
  });

  // The dashboard's toggle sends `ch.name ?? undefined`, so a row whose name we never learned toggles
  // WITHOUT one. An omitted name must keep the stored one, never null it out — otherwise flipping a
  // channel off and on would erase the only channel_id -> name mapping we hold.
  test('an omitted channelName keeps the stored name while enabled still flips', async () => {
    const channel = 'C0KEEPNAME';
    await subscribeChannel(app.db, {
      tenantId: tenantA,
      surface: 'slack',
      channel,
      channelName: '#keepme',
      enabled: true,
    });
    // Toggle off with NO name (the dashboard's flip() path when the row carries none).
    await subscribeChannel(app.db, {
      tenantId: tenantA,
      surface: 'slack',
      channel,
      enabled: false,
    });

    const rows = (await listSubscribedChannels(app.db, tenantA, 'slack')).filter(
      (r) => r.channel === channel,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(false); // the toggle took effect
    expect(rows[0]!.channelName).toBe('#keepme'); // ...and the name survived
  });

  // Disconnecting Slack must disarm the inbound gate: a subscribed channel is the only thing that
  // admits a message, so re-connecting the same workspace would otherwise re-arm every channel silently.
  // Soft: the row (and its name) survives, so history still renders "#name" rather than a bare "C07…".
  test('disableInboundChannels turns every subscription off without deleting the rows', async () => {
    await subscribeChannel(app.db, {
      tenantId: tenantA,
      surface: 'slack',
      channel: 'C0DISARM1',
      channelName: '#disarm-1',
      enabled: true,
    });
    await subscribeChannel(app.db, {
      tenantId: tenantA,
      surface: 'slack',
      channel: 'C0DISARM2',
      channelName: '#disarm-2',
      enabled: true,
    });

    await disableInboundChannels(app.db, tenantA, 'slack');

    const rows = (await listSubscribedChannels(app.db, tenantA, 'slack')).filter((r) =>
      r.channel.startsWith('C0DISARM'),
    );
    expect(rows).toHaveLength(2); // kept, not deleted
    expect(rows.every((r) => r.enabled === false)).toBe(true);
    expect(rows.map((r) => r.channelName).sort()).toEqual(['#disarm-1', '#disarm-2']);
    expect(await isChannelSubscribed(app.db, tenantA, 'slack', 'C0DISARM1')).toBe(false);
  });

  test('a tenant cannot see another tenant’s subscribed channels (RLS) [C6]', async () => {
    await subscribeChannel(app.db, { tenantId: tenantA, surface: 'slack', channel: 'C-a-only' });

    const bRows = await listSubscribedChannels(app.db, tenantB, 'slack');
    expect(bRows.some((r) => r.channel === 'C-a-only')).toBe(false); // A's channel is invisible to B
    expect(await isChannelSubscribed(app.db, tenantB, 'slack', 'C-a-only')).toBe(false);
  });
});
