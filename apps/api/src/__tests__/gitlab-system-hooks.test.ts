import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  connectorConfigs,
  connectorCredentialKey,
  gitlabEvents,
  gitlabProjects,
  makeDb,
  makeSecretStore,
  tenantSecrets,
  tenants,
  withTenant,
  type DbHandle,
} from '@sre/db';
import { gitLabCredentialBundle } from '@sre/connectors';
import { gitLabWebhookRoutes } from '../gitlab-webhook';

const key = Buffer.alloc(32, 7);
const signingToken = `whsec_${key.toString('base64')}`;
const tenantId = randomUUID();
const connectorId = randomUUID();
const webhookKey = randomUUID();
const settings = {
  baseUrl: 'https://gitlab.example.com',
  groupId: 7,
  groupPath: 'platform',
  eventStrategy: 'system',
  eventTransport: 'direct',
};
let admin: DbHandle;
let app: DbHandle;
let api: Hono;
let secrets: ReturnType<typeof makeSecretStore>;
const log = { info: vi.fn(), error: vi.fn() };
const groupFetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  expect(String(input)).toBe('https://gitlab.example.com/api/v4/groups/7');
  expect(init?.headers).toMatchObject({ 'PRIVATE-TOKEN': 'read-api-fixture' });
  expect(init?.redirect).toBe('error');
  return Response.json({ id: 7, full_path: 'platform' });
});

function deliver(
  payload: Record<string, unknown>,
  options: { id?: string; valid?: boolean; timestamp?: number } = {},
) {
  const id = options.id ?? randomUUID();
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const raw = JSON.stringify(payload);
  const signature = createHmac('sha256', options.valid === false ? Buffer.alloc(32, 8) : key)
    .update(`${id}.${timestamp}.${raw}`)
    .digest('base64');
  return api.request(`/webhooks/gitlab/${webhookKey}`, {
    method: 'POST',
    headers: {
      'x-gitlab-event': 'System Hook',
      'x-gitlab-instance': settings.baseUrl,
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': `v1,${signature}`,
      'content-type': 'application/json',
    },
    body: raw,
  });
}

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'System hook isolation test' });
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(connectorConfigs).values({
      id: connectorId,
      tenantId,
      type: 'gitlab',
      webhookKey,
      settings,
      enabled: true,
    }),
  );
  secrets = makeSecretStore(app.db, Buffer.alloc(32, 9).toString('base64'));
  await secrets.put(
    tenantId,
    connectorCredentialKey(connectorId),
    gitLabCredentialBundle('read-api-fixture', { webhookSigningToken: signingToken }),
  );
  api = new Hono().route(
    '/webhooks/gitlab',
    gitLabWebhookRoutes({
      adminDb: admin.db,
      appDb: app.db,
      secrets,
      log,
      fetch: Object.assign(groupFetch, { preconnect: () => undefined }),
      lookup: async () => ['93.184.216.34'],
    }),
  );
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(gitlabEvents).where(eq(gitlabEvents.tenantId, tenantId));
    await admin.db.delete(gitlabProjects).where(eq(gitlabProjects.tenantId, tenantId));
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(tenantSecrets).where(eq(tenantSecrets.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  await app?.close();
});

test('authenticates before discarding instance-wide user data', async () => {
  const payload = { event_name: 'user_create', email: 'do-not-store@example.com' };
  expect((await deliver(payload, { valid: false })).status).toBe(401);
  expect((await deliver(payload, { timestamp: 1 })).status).toBe(401);
  const [before] = await withTenant(app.db, tenantId, (tx) => tx.select().from(connectorConfigs));
  const id = randomUUID();
  expect(await (await deliver(payload, { id })).json()).toEqual({ accepted: true, ignored: true });
  const [after] = await withTenant(app.db, tenantId, (tx) => tx.select().from(connectorConfigs));
  expect(after?.eventSucceededAt).toEqual(before?.eventSucceededAt);
  expect(after?.eventCount).toEqual(before?.eventCount);
  expect(
    await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(gitlabEvents).where(eq(gitlabEvents.deliveryId, id)),
    ),
  ).toEqual([]);
  expect(JSON.stringify(log.info.mock.calls)).not.toContain(payload.email);
});

test.each(['renamed', 'wrong-id', 'deleted', 'unreachable'] as const)(
  'does not admit instance-wide evidence when the configured group is %s',
  async (state) => {
    if (state === 'unreachable') groupFetch.mockRejectedValueOnce(new Error('network failed'));
    else
      groupFetch.mockResolvedValueOnce(
        state === 'deleted'
          ? new Response('', { status: 404 })
          : Response.json({
              id: state === 'wrong-id' ? 8 : 7,
              full_path: state === 'renamed' ? 'renamed-platform' : 'platform',
            }),
      );
    const [before] = await withTenant(app.db, tenantId, (tx) => tx.select().from(connectorConfigs));
    const id = randomUUID();
    const response = await deliver(
      {
        event_name: 'project_create',
        project_id: 9001,
        name: 'private-project',
        path_with_namespace: 'platform/private-project',
      },
      { id },
    );
    expect(response.status).toBe(state === 'deleted' || state === 'unreachable' ? 503 : 403);
    const [after] = await withTenant(app.db, tenantId, (tx) => tx.select().from(connectorConfigs));
    expect(after?.eventCount).toBe(before?.eventCount);
    expect(after?.eventSucceededAt).toEqual(before?.eventSucceededAt);
    expect(
      await withTenant(app.db, tenantId, (tx) =>
        tx.select().from(gitlabEvents).where(eq(gitlabEvents.deliveryId, id)),
      ),
    ).toEqual([]);
    expect(
      await withTenant(app.db, tenantId, (tx) =>
        tx.select().from(gitlabProjects).where(eq(gitlabProjects.projectId, '9001')),
      ),
    ).toEqual([]);
  },
);

test.each(['other/repo', 'platform-other/repo', 'platform/../private', undefined])(
  'ignores an unrelated or unidentified project: %s',
  async (path) => {
    const id = randomUUID();
    const response = await deliver(
      { event_name: 'push', project_id: 42, project: { path_with_namespace: path }, after: 'abc' },
      { id },
    );
    expect(await response.json()).toEqual({ accepted: true, ignored: true });
    expect(
      await withTenant(app.db, tenantId, (tx) =>
        tx.select().from(gitlabEvents).where(eq(gitlabEvents.deliveryId, id)),
      ),
    ).toEqual([]);
  },
);

test('records a signed system push exactly once without inventing a commit count', async () => {
  const id = randomUUID();
  const payload = {
    event_name: 'push',
    project_id: 42,
    project: {
      id: 42,
      name: 'service',
      path_with_namespace: 'platform/sub/service',
      web_url: 'https://gitlab.example.com/platform/sub/service',
    },
    after: 'abc123',
    ref: 'refs/heads/main',
  };
  expect((await deliver(payload, { id })).status).toBe(202);
  expect(await (await deliver(payload, { id })).json()).toEqual({
    accepted: true,
    duplicate: true,
  });
  const events = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(gitlabEvents).where(eq(gitlabEvents.deliveryId, id)),
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eventType: 'push',
    sha: 'abc123',
    summary: { delivery: 'system_hook' },
  });
  expect(events[0]?.summary).not.toHaveProperty('commitCount');
  expect(
    await withTenant(app.db, randomUUID(), (tx) =>
      tx.select().from(gitlabEvents).where(eq(gitlabEvents.deliveryId, id)),
    ),
  ).toEqual([]);
});

test('creates, renames, transfers out and restores only the in-scope project identity', async () => {
  const payload = {
    event_name: 'project_create',
    project_id: 55,
    name: 'new-service',
    path_with_namespace: 'platform/new-service',
    owner_email: 'private@example.com',
  };
  expect((await deliver(payload)).status).toBe(202);
  const projects = () =>
    withTenant(app.db, tenantId, (tx) =>
      tx.select().from(gitlabProjects).where(eq(gitlabProjects.projectId, '55')),
    );
  expect((await projects())[0]).toMatchObject({
    fullPath: 'platform/new-service',
    webUrl: 'https://gitlab.example.com/platform/new-service',
  });
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(gitlabProjects)
      .set({ archived: true, defaultBranch: 'main' })
      .where(eq(gitlabProjects.projectId, '55')),
  );
  expect(
    (
      await deliver({
        ...payload,
        event_name: 'project_rename',
        path_with_namespace: 'platform/renamed',
        old_path_with_namespace: payload.path_with_namespace,
      })
    ).status,
  ).toBe(202);
  expect((await projects())[0]).toMatchObject({
    fullPath: 'platform/renamed',
    archived: true,
    defaultBranch: 'main',
  });
  const id = randomUUID();
  expect(
    (
      await deliver(
        {
          ...payload,
          event_name: 'project_transfer',
          path_with_namespace: 'private/new-service',
          old_path_with_namespace: 'platform/renamed',
        },
        { id },
      )
    ).status,
  ).toBe(202);
  expect((await projects())[0]?.removedAt).toBeInstanceOf(Date);
  const [event] = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(gitlabEvents).where(eq(gitlabEvents.deliveryId, id)),
  );
  expect(event).toMatchObject({ action: 'project_transfer', projectFullPath: 'platform/renamed' });
  expect(JSON.stringify(event)).not.toContain('private/');
  expect(JSON.stringify(event)).not.toContain(payload.owner_email);
  expect(
    (
      await deliver({
        ...payload,
        event_name: 'project_transfer',
        old_path_with_namespace: 'private/new-service',
      })
    ).status,
  ).toBe(202);
  expect((await projects())[0]?.removedAt).toBeNull();
  expect((await deliver({ ...payload, event_name: 'project_destroy' })).status).toBe(202);
  expect((await projects())[0]?.removedAt).toBeInstanceOf(Date);
});

test('does not enable system ingestion for a legacy manual connector', async () => {
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(connectorConfigs)
      .set({ settings: { ...settings, eventStrategy: undefined } })
      .where(eq(connectorConfigs.id, connectorId)),
  );
  try {
    expect(
      await (
        await deliver({
          event_name: 'project_create',
          project_id: 99,
          path_with_namespace: 'platform/not-opted-in',
        })
      ).json(),
    ).toEqual({ accepted: true, ignored: true });
  } finally {
    await withTenant(app.db, tenantId, (tx) =>
      tx.update(connectorConfigs).set({ settings }).where(eq(connectorConfigs.id, connectorId)),
    );
  }
});

test('fences a delivery when configuration changes while credentials are loading', async () => {
  const get = secrets.get.bind(secrets);
  const spy = vi.spyOn(secrets, 'get').mockImplementationOnce(async (tenant, name) => {
    const credential = await get(tenant, name);
    await withTenant(app.db, tenantId, (tx) =>
      tx
        .update(connectorConfigs)
        .set({ lifecycleVersion: sql`${connectorConfigs.lifecycleVersion} + 1` })
        .where(eq(connectorConfigs.id, connectorId)),
    );
    return credential;
  });
  const id = randomUUID();
  try {
    expect(
      (
        await deliver(
          {
            event_name: 'project_create',
            project_id: 66,
            name: 'stale',
            path_with_namespace: 'platform/stale',
          },
          { id },
        )
      ).status,
    ).toBe(409);
    expect(
      await withTenant(app.db, tenantId, (tx) =>
        tx
          .select()
          .from(gitlabEvents)
          .where(and(eq(gitlabEvents.connectorId, connectorId), eq(gitlabEvents.deliveryId, id))),
      ),
    ).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});
