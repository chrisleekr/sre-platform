import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  inboundChannels,
  memberships,
  surfaceConfigs,
  tenantSecrets,
  type MembershipRole,
} from '@sre/db';
import type { FetchLike } from '@sre/surfaces';
import { createFixture } from './surface-config.fixture';

// Connecting or disconnecting the Slack workspace moves the tenant's inbound conversation surface
// and its Socket Mode runtime. A refused request must leave both untouched, so each case asserts the
// stored row and the socket-manager calls, not only the status code.

const fixture = createFixture();

/** A Socket Mode lifecycle double that records every call and starts nothing. `status` answers the
 *  runtime the surfaces listing reports, so a read is served without a live connection. */
function sockets() {
  const now = new Date().toISOString();
  return {
    replace: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    status: vi.fn((_configId: string) => ({
      state: 'connected' as const,
      connectedAt: now,
      updatedAt: now,
    })),
  };
}

function slackWorkspace(): { botUserId: string; teamId: string; appToken: string } {
  const label = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  return {
    botUserId: `U${label}`,
    teamId: `T${label}`,
    appToken: fixture.validAppToken(label),
  };
}

function slackFetch(workspace: ReturnType<typeof slackWorkspace>): FetchLike {
  return fixture.methodFetch({
    'auth.test': {
      body: {
        ok: true,
        user_id: workspace.botUserId,
        bot_id: `B${workspace.teamId}`,
        team_id: workspace.teamId,
      },
    },
    'users.info': { body: { ok: true, user: { id: workspace.botUserId } } },
  }).fetch;
}

async function setRole(role: MembershipRole): Promise<void> {
  await fixture.admin.db
    .update(memberships)
    .set({ role })
    .where(eq(memberships.tenantId, fixture.tenantA));
}

async function headers(): Promise<Record<string, string>> {
  return fixture.bearer(await fixture.sign(fixture.orgA));
}

function storedSurfaces() {
  return fixture.admin.db
    .select({ id: surfaceConfigs.id, surface: surfaceConfigs.surface })
    .from(surfaceConfigs)
    .where(eq(surfaceConfigs.tenantId, fixture.tenantA));
}

function slackChannelId(): string {
  return `C${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

function storedChannel(channel: string) {
  return fixture.admin.db
    .select({ enabled: inboundChannels.enabled, channelName: inboundChannels.channelName })
    .from(inboundChannels)
    .where(
      and(eq(inboundChannels.tenantId, fixture.tenantA), eq(inboundChannels.channel, channel)),
    );
}

/** Subscribes one inbound channel as an administrator, then drops back to member. */
async function seedChannel(channel: string, name: string): Promise<void> {
  await setRole('admin');
  const response = await fixture
    .makeSurfaceApp(undefined, undefined, sockets())
    .request(`/surfaces/slack/channels/${channel}`, {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({ enabled: true, name }),
    });
  expect(response.status).toBe(200);
  await setRole('member');
  expect(await storedChannel(channel)).toEqual([{ enabled: true, channelName: name }]);
}

/** Connects Slack as an administrator, then drops back to member. */
async function seedSlack(): Promise<{ id: string }> {
  await setRole('admin');
  const workspace = slackWorkspace();
  const response = await fixture
    .makeSurfaceApp(slackFetch(workspace), undefined, sockets())
    .request('/surfaces/slack', {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({ botToken: `xoxb-${workspace.teamId}`, appToken: workspace.appToken }),
    });
  expect(response.status).toBe(200);
  await setRole('member');
  const rows = await storedSurfaces();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

afterEach(async () => {
  await fixture.admin.db
    .delete(inboundChannels)
    .where(eq(inboundChannels.tenantId, fixture.tenantA));
  await fixture.admin.db.delete(surfaceConfigs).where(eq(surfaceConfigs.tenantId, fixture.tenantA));
  await fixture.admin.db.delete(tenantSecrets).where(eq(tenantSecrets.tenantId, fixture.tenantA));
  await setRole('member');
});

describe('surface configuration authorization boundary', () => {
  test('a member connecting Slack stores no configuration and starts no socket', async () => {
    await setRole('member');
    const workspace = slackWorkspace();
    const lifecycle = sockets();

    const response = await fixture
      .makeSurfaceApp(slackFetch(workspace), undefined, lifecycle)
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: await headers(),
        body: JSON.stringify({
          botToken: `xoxb-${workspace.teamId}`,
          appToken: workspace.appToken,
        }),
      });

    expect(response.status).toBe(403);
    expect(await storedSurfaces()).toEqual([]);
    expect(lifecycle.replace).not.toHaveBeenCalled();
  });

  test('a member disconnecting Slack leaves the connection and its socket in place', async () => {
    const seeded = await seedSlack();
    const lifecycle = sockets();

    const response = await fixture
      .makeSurfaceApp(undefined, undefined, lifecycle)
      .request('/surfaces/slack', { method: 'DELETE', headers: await headers() });

    expect(response.status).toBe(403);
    expect((await storedSurfaces()).map((row) => row.id)).toEqual([seeded.id]);
    expect(lifecycle.stop).not.toHaveBeenCalled();
  });

  // A subscribed channel is the only thing that admits an inbound signal, so pausing one is a
  // configuration change in the same class as disconnecting the workspace.
  test('a member pausing an inbound channel leaves the subscription untouched', async () => {
    const channel = slackChannelId();
    await seedChannel(channel, '#platform-alerts');

    const response = await fixture
      .makeSurfaceApp(undefined, undefined, sockets())
      .request(`/surfaces/slack/channels/${channel}`, {
        method: 'PUT',
        headers: await headers(),
        body: JSON.stringify({ enabled: false, name: '#renamed-by-a-member' }),
      });

    expect(response.status).toBe(403);
    // The route writes the flag and the name in one upsert, so an unchanged name proves the write
    // never ran at all, not merely that the flag survived.
    expect(await storedChannel(channel)).toEqual([
      { enabled: true, channelName: '#platform-alerts' },
    ]);
  });

  test('an administrator pausing an inbound channel stops it', async () => {
    const channel = slackChannelId();
    await seedChannel(channel, '#platform-alerts');
    await setRole('admin');

    const response = await fixture
      .makeSurfaceApp(undefined, undefined, sockets())
      .request(`/surfaces/slack/channels/${channel}`, {
        method: 'PUT',
        headers: await headers(),
        body: JSON.stringify({ enabled: false }),
      });

    expect(response.status).toBe(200);
    expect(await storedChannel(channel)).toEqual([
      { enabled: false, channelName: '#platform-alerts' },
    ]);
  });

  test('a member still reads the workspace surfaces', async () => {
    const seeded = await seedSlack();

    const response = await fixture
      .makeSurfaceApp(undefined, undefined, sockets())
      .request('/surfaces', { headers: await headers() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { surfaces: Array<{ id: string; surface: string }> };
    expect(body.surfaces.map((surface) => surface.id)).toEqual([seeded.id]);
    expect(body.surfaces.map((surface) => surface.surface)).toEqual(['slack']);
  });

  test('an administrator connecting Slack persists the configuration', async () => {
    await setRole('admin');
    const workspace = slackWorkspace();
    const lifecycle = sockets();

    const response = await fixture
      .makeSurfaceApp(slackFetch(workspace), undefined, lifecycle)
      .request('/surfaces/slack', {
        method: 'PUT',
        headers: await headers(),
        body: JSON.stringify({
          botToken: `xoxb-${workspace.teamId}`,
          appToken: workspace.appToken,
        }),
      });

    expect(response.status).toBe(200);
    const rows = await storedSurfaces();
    expect(rows.map((row) => row.surface)).toEqual(['slack']);
    expect(lifecycle.replace).toHaveBeenCalledTimes(1);
  });
});
