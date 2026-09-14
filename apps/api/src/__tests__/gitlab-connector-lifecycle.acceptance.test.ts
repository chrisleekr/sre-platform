import { seedMembership } from '@sre/db/test-support';
import type { HostLookup } from '@sre/connectors';
import { ConnectorRegistry, makeGitLabConnector } from '@sre/connectors';
import * as dbExports from '@sre/db';
import {
  connectorConfigs,
  connectorCredentialKey,
  deployments,
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  tenantSecrets,
  tenants,
  users,
  withTenant,
  type Db,
  type DbHandle,
  type NewDeploy,
  type SecretStore,
} from '@sre/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { connectorRoutes } from '../connectors';
import type { AuthDeps } from '../auth';
import { makeTestAuth } from './auth-test-support';
import { registerTestConnector } from './connector-registry';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const ISSUER = 'https://test.auth0.local/';
const AUDIENCE = 'sre-api';
const KID = 'gitlab-lifecycle-test';
const KEY = Buffer.alloc(32, 27).toString('base64');
const publicLookup: HostLookup = async () => ['93.184.216.34'];

let admin: DbHandle;
let app: DbHandle;
let secrets: SecretStore;
let privateKey: CryptoKey;
let authKeys: ReturnType<typeof createLocalJWKSet>;
let auth: AuthDeps;
let subjectA: string;
let tenantA: string;
let subjectB: string;
let tenantB: string;

function sign(subject: string): Promise<string> {
  return new SignJWT({ sub: subject })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function headers(subject = subjectA): Promise<{
  authorization: string;
  'content-type': string;
}> {
  return {
    authorization: `Bearer ${await sign(subject)}`,
    'content-type': 'application/json',
  };
}

function registry(fetchImpl: typeof fetch): ConnectorRegistry {
  const connectors = new ConnectorRegistry();
  registerTestConnector(connectors, 'gitlab', (config) =>
    makeGitLabConnector(config, fetchImpl, publicLookup),
  );
  return connectors;
}

function connectorApp(fetchImpl: typeof fetch, secretStore: SecretStore = secrets): Hono {
  const api = new Hono();
  api.route(
    '/connectors',
    connectorRoutes({
      auth,
      db: app.db,
      secrets: secretStore,
      registry: registry(fetchImpl),
    }),
  );
  return api;
}

async function seedGitLabConfig(settings: Record<string, unknown> = {}): Promise<string> {
  const [connector] = await withTenant(app.db, tenantA, (tx) =>
    tx
      .insert(connectorConfigs)
      .values({
        tenantId: tenantA,
        name: 'GitLab',
        type: 'gitlab',
        settings: { baseUrl: 'https://gitlab.example.com', projectId: 42, ...settings },
        enabled: false,
      })
      .returning({ id: connectorConfigs.id }),
  );
  await secrets.put(tenantA, connectorCredentialKey(connector!.id), 'glpat-original-token');
  return connector!.id;
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  secrets = makeSecretStore(app.db, KEY);

  const keyPair = await generateKeyPair('RS256', { extractable: true });
  privateKey = keyPair.privateKey;
  const publicKey = await exportJWK(keyPair.publicKey);
  publicKey.kid = KID;
  publicKey.alg = 'RS256';
  publicKey.use = 'sig';
  authKeys = createLocalJWKSet({ keys: [publicKey] } as JSONWebKeySet);

  subjectA = `gitlab-a-${randomUUID()}`;
  tenantA = randomUUID();
  subjectB = `gitlab-b-${randomUUID()}`;
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'GitLab acceptance A' },
    { id: tenantB, name: 'GitLab acceptance B' },
  ]);
  await seedMembership(admin.db, { issuer: ISSUER, subject: subjectA }, tenantA, 'admin');
  await seedMembership(admin.db, { issuer: ISSUER, subject: subjectB }, tenantB, 'admin');
  auth = await makeTestAuth({
    adminDb: admin.db,
    appDb: app.db,
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: authKeys,
    bindings: [
      { tenantId: tenantA, subject: subjectA },
      { tenantId: tenantB, subject: subjectB },
    ],
  });
}, 30_000);

beforeEach(async () => {
  await admin.db.delete(deployments).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
  await admin.db.delete(connectorConfigs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
  await admin.db.delete(tenantSecrets).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(deployments).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(connectorConfigs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenantSecrets).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenantIdentityBindings).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db
      .delete(users)
      .where(and(eq(users.issuer, ISSUER), sql`${users.subject} in (${subjectA}, ${subjectB})`));
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('GitLab connector lifecycle acceptance', () => {
  test('rejects unsafe instance settings before storing configuration or credentials', async () => {
    const api = connectorApp(fetch);
    const response = await api.request('/connectors/gitlab', {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({
        settings: { baseUrl: 'http://gitlab.internal', projectId: 42 },
        credential: 'glpat-must-not-be-stored',
      }),
    });

    const rows = await withTenant(app.db, tenantA, (tx) =>
      tx.select().from(connectorConfigs).where(eq(connectorConfigs.type, 'gitlab')),
    );
    expect({
      status: response.status,
      configCount: rows.length,
      credential: await secrets.get(tenantA, connectorCredentialKey('gitlab')),
    }).toEqual({ status: 400, configCount: 0, credential: null });
  });

  test('stores a valid connector as a disabled draft and returns secret-free health evidence', async () => {
    const api = connectorApp(fetch);
    const saved = await api.request('/connectors/gitlab', {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({
        settings: {
          baseUrl: 'https://gitlab.example.com',
          projectId: 42,
          service: 'checkout',
          ignoredSecretLikeField: 'must-not-survive',
        },
        credential: 'glpat-encrypted-only',
      }),
    });
    expect(saved.status).toBe(200);

    const listed = await api.request('/connectors', { headers: await headers() });
    const body = (await listed.json()) as { connectors: Array<Record<string, unknown>> };
    expect(body.connectors).toEqual([
      {
        id: expect.any(String),
        name: 'GitLab',
        type: 'gitlab',
        capabilities: {
          availability: 'ready',
          configuration: 'tenant',
          instances: 'multiple',
          investigation: 'tools',
          polling: 'snapshots',
          events: 'authenticated',
          topology: 'inventory',
        },
        settings: {
          baseUrl: 'https://gitlab.example.com',
          projectId: 42,
          service: 'checkout',
        },
        enabled: false,
        credentialConfigured: true,
        verification: {
          lastAttemptAt: null,
          lastSuccessAt: null,
          failureCategory: null,
        },
        polling: {
          lastAttemptAt: null,
          lastSuccessAt: null,
          snapshotCount: 0,
          errorCount: 0,
          failureCategory: null,
        },
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('glpat-encrypted-only');

    const otherTenant = await api.request('/connectors', { headers: await headers(subjectB) });
    expect(((await otherTenant.json()) as { connectors: unknown[] }).connectors).toEqual([]);
  });

  test('preserves an omitted credential and rejects a blank replacement', async () => {
    const api = connectorApp(fetch);
    const connectorId = await seedGitLabConfig({ service: 'checkout' });

    const edited = await api.request('/connectors/gitlab', {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({
        settings: {
          baseUrl: 'https://gitlab.example.com',
          projectId: 42,
          service: 'payments',
        },
        enabled: false,
      }),
    });
    expect(edited.status).toBe(200);
    expect(await secrets.get(tenantA, connectorCredentialKey(connectorId))).toBe(
      'glpat-original-token',
    );

    const blank = await api.request('/connectors/gitlab', {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({
        settings: {
          baseUrl: 'https://gitlab.example.com',
          projectId: 42,
          service: 'payments',
        },
        credential: '   ',
      }),
    });
    expect({
      status: blank.status,
      credential: await secrets.get(tenantA, connectorCredentialKey(connectorId)),
    }).toEqual({ status: 400, credential: 'glpat-original-token' });
  });

  test('enables only after identity, project, and deployment reads all succeed', async () => {
    await seedGitLabConfig();
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      const status = url.endsWith('/user') ? 200 : url.includes('/deployments') ? 403 : 200;
      return new Response('{}', {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const api = connectorApp(fetchImpl);

    const response = await api.request('/connectors/gitlab/test', {
      method: 'POST',
      headers: await headers(),
    });
    const result = (await response.json()) as Record<string, unknown>;
    const listed = await api.request('/connectors', { headers: await headers() });
    const connector = ((await listed.json()) as { connectors: Array<Record<string, unknown>> })
      .connectors[0];

    expect(calls.some((url) => url.includes('/projects/42/deployments'))).toBe(true);
    expect(result).toMatchObject({
      status: 'unhealthy',
      enabled: false,
      checks: { canReadProject: true, canReadDeployments: false },
    });
    expect(connector).toMatchObject({
      enabled: false,
      credentialConfigured: true,
      verification: {
        lastAttemptAt: expect.any(String),
        lastSuccessAt: null,
        failureCategory: 'permission_denied',
      },
    });
    expect(JSON.stringify({ result, connector })).not.toContain('glpat-original-token');
  });

  test('disconnect is secret-first, retryable on secret failure, successful, and idempotent', async () => {
    const connectorId = await seedGitLabConfig();
    const deleteCalls: string[] = [];
    const failingSecrets: SecretStore = {
      ...secrets,
      delete: async () => {
        deleteCalls.push('secret');
        throw new Error('secret backend unavailable');
      },
    };
    const failingApi = connectorApp(fetch, failingSecrets);

    const failed = await failingApi.request('/connectors/gitlab', {
      method: 'DELETE',
      headers: await headers(),
    });
    const retained = await withTenant(app.db, tenantA, (tx) =>
      tx.select().from(connectorConfigs).where(eq(connectorConfigs.type, 'gitlab')),
    );
    expect({
      status: failed.status,
      deleteCalls,
      configCount: retained.length,
      credential: await secrets.get(tenantA, connectorCredentialKey(connectorId)),
    }).toEqual({
      status: 503,
      deleteCalls: ['secret'],
      configCount: 1,
      credential: 'glpat-original-token',
    });

    const api = connectorApp(fetch);
    const disconnected = await api.request('/connectors/gitlab', {
      method: 'DELETE',
      headers: await headers(),
    });
    const repeated = await api.request('/connectors/gitlab', {
      method: 'DELETE',
      headers: await headers(),
    });
    const remaining = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select()
        .from(connectorConfigs)
        .where(and(eq(connectorConfigs.type, 'gitlab'), isNull(connectorConfigs.deletedAt))),
    );
    expect({
      disconnected: disconnected.status,
      repeated: repeated.status,
      configCount: remaining.length,
      credential: await secrets.get(tenantA, connectorCredentialKey(connectorId)),
    }).toEqual({ disconnected: 200, repeated: 200, configCount: 0, credential: null });
  });
});

describe('GitLab deployment ingestion acceptance', () => {
  test('paginates the Deployments API and preserves provider investigation fields', async () => {
    const calls: string[] = [];
    const firstPage = [
      {
        id: 9001,
        iid: 11,
        ref: 'main',
        sha: '0123456789abcdef0123456789abcdef01234567',
        status: 'success',
        created_at: '2026-08-21T01:00:00Z',
        updated_at: '2026-08-21T01:02:00Z',
        user: { id: 7, username: 'deploy-bot', name: 'Deploy Bot' },
        environment: { id: 50, name: 'production', external_url: 'https://app.example.com' },
      },
    ];
    const secondPage = [
      {
        id: 8999,
        iid: 10,
        ref: 'release',
        sha: 'fedcba9876543210fedcba9876543210fedcba98',
        status: 'failed',
        created_at: '2026-08-21T00:30:00Z',
        updated_at: '2026-08-21T00:31:00Z',
        user: { id: 8, username: 'release-user', name: 'Release User' },
        environment: { id: 51, name: 'staging', external_url: 'https://staging.example.com' },
      },
    ];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      const pageTwo = new URL(url).searchParams.get('page') === '2';
      const headers = new Headers({ 'content-type': 'application/json' });
      if (!pageTwo) {
        headers.set(
          'link',
          '<https://gitlab.example.com/api/v4/projects/42/deployments?per_page=100&page=2>; rel="next"',
        );
      }
      return new Response(JSON.stringify(pageTwo ? secondPage : firstPage), {
        status: 200,
        headers,
      });
    }) as typeof fetch;
    const connector = makeGitLabConnector(
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Acceptance GitLab',
        tenantId: tenantA,
        type: 'gitlab',
        settings: {
          baseUrl: 'https://gitlab.example.com',
          projectId: 42,
          service: 'checkout',
        },
        getCredential: async () => 'glpat-read-only',
      },
      fetchImpl,
      publicLookup,
    );

    const snapshots = await connector.snapshot();

    expect(calls).toHaveLength(2);
    expect(calls.every((url) => url.startsWith('https://gitlab.example.com/api/v4/'))).toBe(true);
    expect(calls.every((url) => url.includes('/projects/42/deployments'))).toBe(true);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      source: 'gitlab',
      entityId: '9001',
      metadata: {
        providerId: '9001',
        projectId: '42',
        environment: 'production',
        actor: 'deploy-bot',
        sha: '0123456789abcdef0123456789abcdef01234567',
        status: 'success',
        deployedAt: '2026-08-21T01:02:00Z',
        providerCreatedAt: '2026-08-21T01:00:00Z',
        providerUpdatedAt: '2026-08-21T01:02:00Z',
      },
    });
  });

  test('keys deployments by provider event and advances the cursor only with persistence', async () => {
    type PersistConnectorDeployments = (
      db: Db,
      tenantId: string,
      connectorType: string,
      rows: NewDeploy[],
      cursor: Record<string, unknown>,
    ) => Promise<void>;
    const persistConnectorDeployments = (
      dbExports as typeof dbExports & {
        persistConnectorDeployments?: PersistConnectorDeployments;
      }
    ).persistConnectorDeployments;
    expect(persistConnectorDeployments).toBeTypeOf('function');
    if (!persistConnectorDeployments) return;

    await seedGitLabConfig();
    const firstCursor = { updatedAfter: '2026-08-21T01:02:00Z' };
    const rows = [
      {
        source: 'gitlab',
        providerId: '9001',
        repo: '42',
        environment: 'production',
        actor: 'deploy-bot',
        ref: 'main',
        sha: 'same-full-commit',
        service: 'checkout',
        status: 'running',
        url: 'https://gitlab.example.com/project/deployments/9001',
        deployedAt: new Date('2026-08-21T01:02:00Z'),
      },
      {
        source: 'gitlab',
        providerId: '9002',
        repo: '43',
        environment: 'staging',
        actor: 'release-user',
        ref: 'release',
        sha: 'same-full-commit',
        service: 'checkout',
        status: 'success',
        url: 'https://gitlab.example.com/project/deployments/9002',
        deployedAt: new Date('2026-08-21T01:03:00Z'),
      },
    ] as unknown as NewDeploy[];

    await persistConnectorDeployments(app.db, tenantA, 'gitlab', rows, firstCursor);
    await persistConnectorDeployments(
      app.db,
      tenantA,
      'gitlab',
      [{ ...rows[0]!, status: 'success' }],
      { updatedAfter: '2026-08-21T01:04:00Z' },
    );

    const persisted = await withTenant(app.db, tenantA, (tx) =>
      tx.execute<{
        providerId: string;
        repo: string;
        environment: string;
        status: string;
      }>(sql`
        select provider_id as "providerId", repo, environment, status
        from deployments
        order by provider_id
      `),
    );
    const cursorBeforeFailure = await withTenant(app.db, tenantA, (tx) =>
      tx.execute<{ pollCursor: Record<string, unknown> }>(sql`
        select poll_cursor as "pollCursor"
        from connector_configs
        where type = 'gitlab'
      `),
    );

    await expect(
      persistConnectorDeployments(
        app.db,
        tenantA,
        'gitlab',
        [{ ...rows[0]!, providerId: '9003', sha: null } as unknown as NewDeploy],
        { updatedAfter: '2026-08-21T02:00:00Z' },
      ),
    ).rejects.toThrow();
    const cursorAfterFailure = await withTenant(app.db, tenantA, (tx) =>
      tx.execute<{ pollCursor: Record<string, unknown> }>(sql`
        select poll_cursor as "pollCursor"
        from connector_configs
        where type = 'gitlab'
      `),
    );

    expect([...persisted]).toEqual([
      { providerId: '9001', repo: '42', environment: 'production', status: 'success' },
      { providerId: '9002', repo: '43', environment: 'staging', status: 'success' },
    ]);
    expect(cursorBeforeFailure[0]?.pollCursor).toEqual({
      updatedAfter: '2026-08-21T01:04:00Z',
    });
    expect(cursorAfterFailure[0]?.pollCursor).toEqual(cursorBeforeFailure[0]?.pollCursor);
  });
});
