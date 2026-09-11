import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  connectorConfigs,
  connectorCredentialKey,
  deployments,
  githubEvents,
  githubRepositories,
  makeDb,
  makeSecretStore,
  tenantSecrets,
  tenants,
  withTenant,
  type DbHandle,
} from '@sre/db';
import { githubCredentialBundle } from '@sre/connectors';
import { githubWebhookRoutes } from '../github-webhook';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const KEY = Buffer.alloc(32, 7).toString('base64');
const WEBHOOK_SECRET = 'github-webhook-test-secret';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let connectorId: string;
let webhookKey: string;
let api: Hono;

function signature(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function deliver(event: string, payload: Record<string, unknown>, deliveryId = randomUUID()) {
  const body = JSON.stringify(payload);
  return api.request(`/webhooks/github/${webhookKey}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature(body),
    },
    body,
  });
}

async function selectInstallation(): Promise<void> {
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(connectorConfigs)
      .set({
        settings: {
          appId: '123',
          installationId: '7001',
          accountLogin: 'acme',
          repositorySelection: 'all',
        },
      })
      .where(eq(connectorConfigs.id, connectorId)),
  );
}

const repository = {
  id: 91,
  name: 'checkout',
  full_name: 'acme/checkout',
  owner: { login: 'acme' },
  private: true,
  archived: false,
  default_branch: 'main',
  html_url: 'https://github.com/acme/checkout',
  pushed_at: '2026-08-23T01:00:00Z',
};

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  connectorId = randomUUID();
  webhookKey = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'GitHub webhook tenant' });
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(connectorConfigs).values({
      id: connectorId,
      tenantId,
      type: 'github',
      webhookKey,
      settings: { appId: '123' },
      enabled: false,
    }),
  );
  const secrets = makeSecretStore(app.db, KEY);
  await secrets.put(
    tenantId,
    connectorCredentialKey(connectorId),
    githubCredentialBundle('test-private-key', WEBHOOK_SECRET),
  );
  api = new Hono();
  api.route(
    '/webhooks/github',
    githubWebhookRoutes({
      adminDb: admin.db,
      appDb: app.db,
      secrets,
      log: { info: vi.fn(), error: vi.fn() },
    }),
  );
});

beforeEach(async () => {
  await withTenant(app.db, tenantId, async (tx) => {
    await tx.delete(deployments);
    await tx.delete(githubEvents);
    await tx.delete(githubRepositories);
    await tx
      .update(connectorConfigs)
      .set({
        settings: { appId: '123' },
        enabled: false,
        eventAttemptedAt: null,
        eventSucceededAt: null,
        eventCount: 0,
        eventFailureCategory: null,
      })
      .where(eq(connectorConfigs.id, connectorId));
  });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(deployments).where(eq(deployments.tenantId, tenantId));
    await admin.db.delete(githubEvents).where(eq(githubEvents.tenantId, tenantId));
    await admin.db.delete(githubRepositories).where(eq(githubRepositories.tenantId, tenantId));
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(tenantSecrets).where(eq(tenantSecrets.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

describe('GitHub webhook ingress', () => {
  test('rejects a chunked body as soon as it crosses the route byte limit', async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode('x'.repeat(1024 * 1024 + 1));
    let sent = 0;
    const response = await api.request(
      new Request(`http://localhost/webhooks/github/${webhookKey}`, {
        method: 'POST',
        headers: {
          'x-github-event': 'push',
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': 'sha256=untrusted',
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

  test('does not bind an unconfigured connector from a non-created installation event', async () => {
    const response = await deliver('installation', {
      action: 'deleted',
      installation: { id: 7002, account: { login: 'other' }, repository_selection: 'all' },
      sender: { login: 'octocat' },
    });
    expect(response.status).toBe(409);

    const [connector] = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(connectorConfigs).where(eq(connectorConfigs.id, connectorId)),
    );
    expect(connector?.settings).toEqual({ appId: '123' });
  });

  test('binds a new installation and catalogs its repositories from the signed event', async () => {
    const response = await deliver('installation', {
      action: 'created',
      installation: {
        id: 7001,
        account: { login: 'acme' },
        repository_selection: 'all',
      },
      repositories: [repository],
      sender: { login: 'octocat' },
    });
    expect(response.status).toBe(202);

    const connector = await withTenant(
      app.db,
      tenantId,
      async (tx) =>
        (await tx.select().from(connectorConfigs).where(eq(connectorConfigs.id, connectorId)))[0],
    );
    expect(connector?.settings).toMatchObject({
      appId: '123',
      installationId: '7001',
      accountLogin: 'acme',
      repositorySelection: 'all',
    });
    expect(connector?.eventCount).toBe(1);
    const repos = await withTenant(app.db, tenantId, (tx) => tx.select().from(githubRepositories));
    expect(repos).toMatchObject([{ fullName: 'acme/checkout', installationId: '7001' }]);
  });

  test('ignores lifecycle events from another installation without changing the selection', async () => {
    await selectInstallation();
    const response = await deliver('installation', {
      action: 'deleted',
      installation: { id: 7002, account: { login: 'other' }, repository_selection: 'all' },
      sender: { login: 'octocat' },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, ignored: true });

    const [connector] = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(connectorConfigs).where(eq(connectorConfigs.id, connectorId)),
    );
    expect(connector?.settings).toMatchObject({ installationId: '7001', accountLogin: 'acme' });
  });

  test('persists a push once when GitHub redelivers the same delivery ID', async () => {
    await selectInstallation();
    const deliveryId = randomUUID();
    const payload = {
      installation: { id: 7001 },
      repository,
      ref: 'refs/heads/main',
      before: 'before-sha',
      after: 'after-sha',
      commits: [{ id: 'after-sha' }],
      head_commit: {
        id: 'after-sha',
        message: 'fix checkout timeout\n\nDetails',
        timestamp: '2026-08-23T02:00:00Z',
      },
      sender: { login: 'octocat' },
    };
    expect((await deliver('push', payload, deliveryId)).status).toBe(202);
    const duplicate = await deliver('push', payload, deliveryId);
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ accepted: true, duplicate: true });

    const events = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(githubEvents).where(eq(githubEvents.deliveryId, deliveryId)),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'push',
      repositoryFullName: 'acme/checkout',
      ref: 'refs/heads/main',
      sha: 'after-sha',
      summary: { commitCount: 1 },
    });
  });

  test('persists deployment status evidence for the deployment timeline', async () => {
    await selectInstallation();
    const response = await deliver('deployment_status', {
      installation: { id: 7001 },
      repository,
      deployment: {
        id: 501,
        sha: 'deploy-sha',
        ref: 'main',
        environment: 'production',
        transient_environment: false,
        created_at: '2026-08-23T03:00:00Z',
      },
      deployment_status: {
        id: 502,
        state: 'success',
        environment: 'production',
        environment_url: 'https://checkout.example.com',
        updated_at: '2026-08-23T03:05:00Z',
      },
      sender: { login: 'deployer' },
    });
    expect(response.status).toBe(202);
    const rows = await withTenant(app.db, tenantId, (tx) =>
      tx
        .select()
        .from(deployments)
        .where(sql`source = 'github' and provider_id = '501'`),
    );
    expect(rows).toMatchObject([
      {
        repo: 'acme/checkout',
        sha: 'deploy-sha',
        environment: 'production',
        status: 'success',
        actor: 'deployer',
      },
    ]);
  });

  test('removes an uninstalled App installation from the active repository catalog', async () => {
    await selectInstallation();
    expect(
      (
        await deliver('installation', {
          action: 'created',
          installation: {
            id: 7001,
            account: { login: 'acme' },
            repository_selection: 'all',
          },
          repositories: [repository],
          sender: { login: 'octocat' },
        })
      ).status,
    ).toBe(202);
    const response = await deliver('installation', {
      action: 'deleted',
      installation: {
        id: 7001,
        account: { login: 'acme' },
        repository_selection: 'all',
      },
      repositories: [repository],
      sender: { login: 'octocat' },
    });
    expect(response.status).toBe(202);

    const [connector] = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(connectorConfigs).where(eq(connectorConfigs.id, connectorId)),
    );
    const [catalogEntry] = await withTenant(app.db, tenantId, (tx) =>
      tx
        .select()
        .from(githubRepositories)
        .where(eq(githubRepositories.repositoryId, String(repository.id))),
    );
    expect(connector?.enabled).toBe(false);
    expect(catalogEntry?.removedAt).toBeInstanceOf(Date);
  });

  test('rejects an invalid signature and records the failure category without storing the body', async () => {
    const payload = JSON.stringify({ installation: { id: 7001 }, repository });
    const response = await api.request(`/webhooks/github/${webhookKey}`, {
      method: 'POST',
      headers: {
        'x-github-event': 'push',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': signature(payload, 'wrong-secret'),
      },
      body: payload,
    });
    expect(response.status).toBe(401);
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
    expect(connector?.failure).toBe('signature_mismatch');
  });

  test('routes same-type instances by opaque key and verifies each instance secret independently', async () => {
    const secondaryId = randomUUID();
    const secondaryWebhookKey = randomUUID();
    const secondarySecret = 'github-secondary-webhook-secret';
    const deliveryId = randomUUID();
    const secrets = makeSecretStore(app.db, KEY);
    await withTenant(app.db, tenantId, (tx) =>
      tx.insert(connectorConfigs).values({
        id: secondaryId,
        tenantId,
        name: 'Secondary GitHub',
        type: 'github',
        webhookKey: secondaryWebhookKey,
        settings: { appId: '456', installationId: '8001' },
        enabled: true,
      }),
    );
    await secrets.put(
      tenantId,
      connectorCredentialKey(secondaryId),
      githubCredentialBundle('secondary-private-key', secondarySecret),
    );
    const payload = JSON.stringify({
      installation: { id: 8001 },
      repository: {
        ...repository,
        id: 92,
        name: 'secondary',
        full_name: 'acme/secondary',
        html_url: 'https://github.com/acme/secondary',
      },
      ref: 'refs/heads/main',
      after: 'secondary-sha',
      commits: [],
      sender: { login: 'octocat' },
    });
    try {
      const accepted = await api.request(`/webhooks/github/${secondaryWebhookKey}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': deliveryId,
          'x-hub-signature-256': signature(payload, secondarySecret),
        },
        body: payload,
      });
      expect(accepted.status).toBe(202);

      const wrongInstance = await api.request(`/webhooks/github/${webhookKey}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': signature(payload, secondarySecret),
        },
        body: payload,
      });
      expect(wrongInstance.status).toBe(401);

      const events = await withTenant(app.db, tenantId, (tx) =>
        tx.select().from(githubEvents).where(eq(githubEvents.deliveryId, deliveryId)),
      );
      expect(events).toMatchObject([
        { connectorId: secondaryId, repositoryFullName: 'acme/secondary' },
      ]);
      const counts = await withTenant(app.db, tenantId, (tx) =>
        tx
          .select({ id: connectorConfigs.id, count: connectorConfigs.eventCount })
          .from(connectorConfigs),
      );
      expect(counts).toEqual(
        expect.arrayContaining([
          { id: connectorId, count: 0 },
          { id: secondaryId, count: 1 },
        ]),
      );
    } finally {
      await withTenant(app.db, tenantId, async (tx) => {
        await tx.delete(githubEvents).where(eq(githubEvents.connectorId, secondaryId));
        await tx.delete(githubRepositories).where(eq(githubRepositories.connectorId, secondaryId));
        await tx.delete(deployments).where(eq(deployments.connectorId, secondaryId));
        await tx.delete(connectorConfigs).where(eq(connectorConfigs.id, secondaryId));
      });
      await secrets.delete(tenantId, connectorCredentialKey(secondaryId));
    }
  });
});
