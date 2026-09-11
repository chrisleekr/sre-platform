import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  connectorConfigs,
  connectorCredentialKey,
  deployments,
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

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const KEY = Buffer.alloc(32, 9).toString('base64');
const WEBHOOK_SECRET = 'gitlab-webhook-test-secret';
const SIGNING_TOKEN = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let connectorId: string;
let webhookKey: string;
let api: Hono;

function deliver(event: string, payload: Record<string, unknown>, deliveryId = randomUUID()) {
  return api.request(`/webhooks/gitlab/${webhookKey}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitlab-event': event,
      'x-gitlab-token': WEBHOOK_SECRET,
      'x-gitlab-instance': 'https://gitlab.example.com',
      'idempotency-key': deliveryId,
    },
    body: JSON.stringify(payload),
  });
}

function signingHeaders(payload: string, token = SIGNING_TOKEN) {
  const messageId = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v1,${createHmac('sha256', Buffer.from(token.slice('whsec_'.length), 'base64'))
    .update(`${messageId}.${timestamp}.${payload}`)
    .digest('base64')}`;
  return {
    'content-type': 'application/json',
    'x-gitlab-event': 'Push Hook',
    'x-gitlab-instance': 'https://gitlab.example.com',
    'webhook-id': messageId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signature,
  };
}

const project = {
  id: 42,
  name: 'checkout',
  path_with_namespace: 'platform/services/checkout',
  web_url: 'https://gitlab.example.com/platform/services/checkout',
  default_branch: 'main',
  visibility: 'private',
  archived: false,
};

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  connectorId = randomUUID();
  webhookKey = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'GitLab webhook tenant' });
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(connectorConfigs).values({
      id: connectorId,
      tenantId,
      type: 'gitlab',
      webhookKey,
      settings: {
        baseUrl: 'https://gitlab.example.com',
        groupId: 7,
        groupPath: 'platform',
        eventTransport: 'direct',
      },
      enabled: true,
    }),
  );
  const secrets = makeSecretStore(app.db, KEY);
  await secrets.put(
    tenantId,
    connectorCredentialKey(connectorId),
    gitLabCredentialBundle('glpat-test', { webhookSecret: WEBHOOK_SECRET }),
  );
  api = new Hono();
  api.route(
    '/webhooks/gitlab',
    gitLabWebhookRoutes({
      adminDb: admin.db,
      appDb: app.db,
      secrets,
      log: { info: vi.fn(), error: vi.fn() },
    }),
  );
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(deployments).where(eq(deployments.tenantId, tenantId));
    await admin.db.delete(gitlabEvents).where(eq(gitlabEvents.tenantId, tenantId));
    await admin.db.delete(gitlabProjects).where(eq(gitlabProjects.tenantId, tenantId));
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(tenantSecrets).where(eq(tenantSecrets.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

describe('GitLab group webhook ingress', () => {
  test('rejects a chunked body as soon as it crosses the route byte limit', async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode('x'.repeat(1024 * 1024 + 1));
    let sent = 0;
    const response = await api.request(
      new Request(`http://localhost/webhooks/gitlab/${webhookKey}`, {
        method: 'POST',
        headers: {
          'x-gitlab-event': 'Push Hook',
          'idempotency-key': randomUUID(),
          'x-gitlab-token': WEBHOOK_SECRET,
        },
        body: new ReadableStream({
          pull(controller) {
            if (sent++ < 2) controller.enqueue(chunk);
            else controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    expect(response.status).toBe(413);
  });

  test('persists one allowlisted push event and updates the project catalog across retries', async () => {
    const deliveryId = randomUUID();
    const payload = {
      object_kind: 'push',
      event_name: 'push',
      project,
      ref: 'refs/heads/main',
      before: 'before-sha',
      after: 'after-sha',
      total_commits_count: 3,
      user_username: 'octocat',
      event_time: '2026-08-24T01:00:00Z',
      secret_variable: 'must-not-persist',
    };
    expect((await deliver('Push Hook', payload, deliveryId)).status).toBe(202);
    const duplicate = await deliver('Push Hook', payload, deliveryId);
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ accepted: true, duplicate: true });

    const events = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(gitlabEvents).where(eq(gitlabEvents.deliveryId, deliveryId)),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'push',
      projectFullPath: 'platform/services/checkout',
      actor: 'octocat',
      ref: 'refs/heads/main',
      sha: 'after-sha',
      summary: { commitCount: 3 },
    });
    expect(JSON.stringify(events[0])).not.toContain('must-not-persist');
    const projects = await withTenant(app.db, tenantId, (tx) => tx.select().from(gitlabProjects));
    expect(projects).toMatchObject([
      { groupId: '7', projectId: '42', fullPath: 'platform/services/checkout' },
    ]);
  });

  test('persists deployment evidence for the shared deployment timeline', async () => {
    const response = await deliver('Deployment Hook', {
      object_kind: 'deployment',
      status: 'success',
      status_changed_at: '2026-08-24T02:05:00Z',
      deployment_id: 501,
      deployable_url: 'https://gitlab.example.com/platform/services/checkout/-/jobs/99',
      environment: 'production',
      environment_external_url: 'https://checkout.example.com',
      project,
      short_sha: 'abc123ef',
      user: { username: 'deployer', email: 'must-not-persist@example.com' },
    });
    expect(response.status).toBe(202);
    const rows = await withTenant(app.db, tenantId, (tx) =>
      tx
        .select()
        .from(deployments)
        .where(sql`source = 'gitlab' and provider_id = '501'`),
    );
    expect(rows).toMatchObject([
      {
        repo: 'platform/services/checkout',
        sha: 'abc123ef',
        environment: 'production',
        status: 'success',
        actor: 'deployer',
      },
    ]);
  });

  test('rejects a bad secret and a valid event outside the configured group', async () => {
    const badSecret = await api.request(`/webhooks/gitlab/${webhookKey}`, {
      method: 'POST',
      headers: {
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-token': 'wrong-secret',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ project }),
    });
    expect(badSecret.status).toBe(401);

    const outside = await deliver('Push Hook', {
      project: { ...project, path_with_namespace: 'another-group/private' },
      ref: 'refs/heads/main',
      after: 'outside-sha',
    });
    expect(outside.status).toBe(403);
    const connector = await withTenant(
      app.db,
      tenantId,
      async (tx) =>
        (
          await tx
            .select({ failure: connectorConfigs.eventFailureCategory })
            .from(connectorConfigs)
            .where(eq(connectorConfigs.id, connectorId))
        )[0],
    );
    expect(connector?.failure).toBe('group_mismatch');
  });

  test('verifies the GitLab 19 signing token and rejects stale signed deliveries', async () => {
    const secrets = makeSecretStore(app.db, KEY);
    await secrets.put(
      tenantId,
      connectorCredentialKey(connectorId),
      gitLabCredentialBundle('glpat-test', { webhookSigningToken: SIGNING_TOKEN }),
    );
    const payload = JSON.stringify({
      object_kind: 'push',
      event_name: 'push',
      project,
      ref: 'refs/heads/main',
      after: 'signed-sha',
    });
    const send = (timestamp: number) => {
      const messageId = randomUUID();
      const signature = `v1,${createHmac(
        'sha256',
        Buffer.from(SIGNING_TOKEN.slice('whsec_'.length), 'base64'),
      )
        .update(`${messageId}.${timestamp}.${payload}`)
        .digest('base64')}`;
      return api.request(`/webhooks/gitlab/${webhookKey}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gitlab-event': 'Push Hook',
          'x-gitlab-instance': 'https://gitlab.example.com',
          'webhook-id': messageId,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signature,
        },
        body: payload,
      });
    };

    try {
      expect((await send(Math.floor(Date.now() / 1000))).status).toBe(202);
      expect((await send(Math.floor(Date.now() / 1000) - 301)).status).toBe(401);
    } finally {
      await secrets.put(
        tenantId,
        connectorCredentialKey(connectorId),
        gitLabCredentialBundle('glpat-test', { webhookSecret: WEBHOOK_SECRET }),
      );
    }
  });

  test('accepts both credentials during legacy-to-HMAC migration without unsafe fallback', async () => {
    const secrets = makeSecretStore(app.db, KEY);
    await secrets.put(
      tenantId,
      connectorCredentialKey(connectorId),
      gitLabCredentialBundle('glpat-test', {
        webhookSecret: WEBHOOK_SECRET,
        webhookSigningToken: SIGNING_TOKEN,
      }),
    );
    const payload = {
      object_kind: 'push',
      event_name: 'push',
      project,
      ref: 'refs/heads/main',
      after: 'migration-sha',
    };
    const raw = JSON.stringify(payload);

    try {
      expect((await deliver('Push Hook', payload)).status).toBe(202);
      expect(
        (
          await api.request(`/webhooks/gitlab/${webhookKey}`, {
            method: 'POST',
            headers: signingHeaders(raw),
            body: raw,
          })
        ).status,
      ).toBe(202);
      expect(
        (
          await api.request(`/webhooks/gitlab/${webhookKey}`, {
            method: 'POST',
            headers: {
              ...signingHeaders(raw, `whsec_${Buffer.alloc(32, 8).toString('base64')}`),
              'x-gitlab-token': WEBHOOK_SECRET,
            },
            body: raw,
          })
        ).status,
      ).toBe(401);
    } finally {
      await secrets.put(
        tenantId,
        connectorCredentialKey(connectorId),
        gitLabCredentialBundle('glpat-test', { webhookSecret: WEBHOOK_SECRET }),
      );
    }
  });

  test('routes same-type instances by opaque key and verifies each signing token independently', async () => {
    const secondaryId = randomUUID();
    const secondaryWebhookKey = randomUUID();
    const secondarySigningToken = `whsec_${Buffer.alloc(32, 11).toString('base64')}`;
    const secrets = makeSecretStore(app.db, KEY);
    const [primaryBefore] = await withTenant(app.db, tenantId, (tx) =>
      tx
        .select({ eventCount: connectorConfigs.eventCount })
        .from(connectorConfigs)
        .where(eq(connectorConfigs.id, connectorId)),
    );
    await withTenant(app.db, tenantId, (tx) =>
      tx.insert(connectorConfigs).values({
        id: secondaryId,
        tenantId,
        name: 'Security GitLab',
        type: 'gitlab',
        webhookKey: secondaryWebhookKey,
        settings: {
          baseUrl: 'https://gitlab.example.com',
          groupId: 8,
          groupPath: 'security',
          eventTransport: 'direct',
        },
        enabled: true,
      }),
    );
    await secrets.put(
      tenantId,
      connectorCredentialKey(secondaryId),
      gitLabCredentialBundle('glpat-secondary', {
        webhookSigningToken: secondarySigningToken,
      }),
    );
    const payload = JSON.stringify({
      object_kind: 'push',
      event_name: 'push',
      project: {
        ...project,
        id: 84,
        name: 'agent',
        path_with_namespace: 'security/agent',
        web_url: 'https://gitlab.example.com/security/agent',
      },
      ref: 'refs/heads/main',
      after: 'security-sha',
    });
    const headers = signingHeaders(payload, secondarySigningToken);
    try {
      const accepted = await api.request(`/webhooks/gitlab/${secondaryWebhookKey}`, {
        method: 'POST',
        headers,
        body: payload,
      });
      expect(accepted.status).toBe(202);

      const wrongInstance = await api.request(`/webhooks/gitlab/${webhookKey}`, {
        method: 'POST',
        headers: signingHeaders(payload, secondarySigningToken),
        body: payload,
      });
      expect(wrongInstance.status).toBe(401);

      const events = await withTenant(app.db, tenantId, (tx) =>
        tx.select().from(gitlabEvents).where(eq(gitlabEvents.deliveryId, headers['webhook-id'])),
      );
      expect(events).toMatchObject([
        { connectorId: secondaryId, projectFullPath: 'security/agent' },
      ]);
      const counts = await withTenant(app.db, tenantId, (tx) =>
        tx
          .select({ id: connectorConfigs.id, count: connectorConfigs.eventCount })
          .from(connectorConfigs)
          .where(sql`id in (${connectorId}, ${secondaryId})`),
      );
      expect(counts).toEqual(
        expect.arrayContaining([
          { id: connectorId, count: primaryBefore!.eventCount },
          { id: secondaryId, count: 1 },
        ]),
      );
    } finally {
      await withTenant(app.db, tenantId, async (tx) => {
        await tx.delete(gitlabEvents).where(eq(gitlabEvents.connectorId, secondaryId));
        await tx.delete(gitlabProjects).where(eq(gitlabProjects.connectorId, secondaryId));
        await tx.delete(deployments).where(eq(deployments.connectorId, secondaryId));
        await tx.delete(connectorConfigs).where(eq(connectorConfigs.id, secondaryId));
      });
      await secrets.delete(tenantId, connectorCredentialKey(secondaryId));
    }
  });
});
