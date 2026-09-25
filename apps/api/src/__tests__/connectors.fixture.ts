import { seedMembership } from '@sre/db/test-support';
import {
  ConnectorRegistry,
  makeGitLabConnector,
  makeKubernetesConnector,
  stubConnector,
  type GitHubInstallationSummary,
  type GitHubRepositorySummary,
} from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  githubEvents,
  githubManifestSessions,
  githubRepositories,
  gitlabEvents,
  gitlabProjects,
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  tenantSecrets,
  tenants,
  users,
  withTenant,
  type DbHandle,
  type SecretStore,
} from '@sre/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import { makeApp } from '../app';
import type { AuthDeps } from '../auth';
import { connectorRoutes } from '../connectors';
import { makeTestAuth } from './auth-test-support';
import { registerTestConnector } from './connector-registry';

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  const ISSUER = 'https://test.auth0.local/';

  const AUDIENCE = 'sre-api';

  const KID = 'test-key';

  const KEY = Buffer.alloc(32, 9).toString('base64');

  const GITHUB_WEBHOOK_SECRET = 'github-webhook-secret-test';

  let admin: DbHandle;

  let app: DbHandle;

  let api: ReturnType<typeof makeApp>;

  let secrets: SecretStore;

  let privateKey: CryptoKey;

  let authKeys: ReturnType<typeof createLocalJWKSet>;

  let auth: AuthDeps;

  let orgA: string;

  let tenantA: string;

  let orgB: string;

  let tenantB: string;

  function sign(org: string, _perms?: string[]): Promise<string> {
    // The old `org` argument is now the token subject; the fixture creates its provider binding.
    return new SignJWT({ sub: org })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  function bearer(token: string): { authorization: string; 'content-type': string } {
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  }

  async function activeConnector(type: string): Promise<typeof connectorConfigs.$inferSelect> {
    const rows = await withTenant(app.db, tenantA, (tx) =>
      tx
        .select()
        .from(connectorConfigs)
        .where(and(eq(connectorConfigs.type, type), isNull(connectorConfigs.deletedAt)))
        .limit(1),
    );
    if (!rows[0]) throw new Error(`expected active ${type} data source`);
    return rows[0];
  }

  async function activeCredential(type: string): Promise<string | null> {
    const connector = await activeConnector(type);
    return secrets.get(tenantA, connectorCredentialKey(connector.id));
  }

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    secrets = makeSecretStore(app.db, KEY);

    const kp = await generateKeyPair('RS256', { extractable: true });
    privateKey = kp.privateKey;
    const jwk = await exportJWK(kp.publicKey);
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
    authKeys = keys;

    orgA = `org_${randomUUID().slice(0, 8)}`;
    tenantA = randomUUID();
    orgB = `org_${randomUUID().slice(0, 8)}`;
    tenantB = randomUUID();
    await admin.db.insert(tenants).values([
      { id: tenantA, name: 'A' },
      { id: tenantB, name: 'B' },
    ]);
    await seedMembership(admin.db, { issuer: ISSUER, subject: orgA }, tenantA, 'admin');
    await seedMembership(admin.db, { issuer: ISSUER, subject: orgB }, tenantB, 'admin');
    auth = await makeTestAuth({
      adminDb: admin.db,
      appDb: app.db,
      issuer: ISSUER,
      audience: AUDIENCE,
      keys,
      bindings: [
        { tenantId: tenantA, subject: orgA },
        { tenantId: tenantB, subject: orgB },
      ],
    });
    api = makeApp({
      auth,
      readinessDb: app.db,
      appDb: app.db,
      secrets,
      cache: { get: async () => [], set: async () => {} },
      settings: { list: async () => [], set: async () => 1 },
    });
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(gitlabEvents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(gitlabProjects).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(connectorConfigs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(tenantSecrets).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db
        .delete(tenantIdentityBindings)
        .where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(users).where(sql`issuer = ${ISSUER} and subject in (${orgA}, ${orgB})`);
      await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
      await admin.close();
    }
    if (app) await app.close();
  });

  /** A fake apiserver: maps /api, .../pods, .../secrets to fixed status codes (or throws for the
   *  unreachable case), so the probe path is exercised without a network or a live cluster. An empty
   *  bearer token (no saved credential) is rejected with 401 on every path, mirroring how a real
   *  apiserver treats an unauthenticated request. */
  function fakeApiserver(
    codes: { api: number; pods: number; secrets: number } | 'throw',
  ): typeof fetch {
    return (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      if (codes === 'throw') throw new Error('connection refused');
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (authorization === 'Bearer ') return new Response('{}', { status: 401 });
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      const { pathname } = new URL(url);
      let status: number;
      if (pathname === '/api') status = codes.api;
      else if (pathname.endsWith('/secrets')) status = codes.secrets;
      else if (pathname.endsWith('/pods')) status = codes.pods;
      else status = 404;
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
  }

  /** Registers kubernetes (bound to the injected fetch) and a datadog stub, for the test-connection route. */
  function testRegistry(fetchImpl: typeof fetch): ConnectorRegistry {
    const r = new ConnectorRegistry();
    registerTestConnector(r, 'kubernetes', (config) =>
      makeKubernetesConnector(config, fetchImpl, async () => ['93.184.216.34']),
    );
    registerTestConnector(r, 'gitlab', (config) =>
      makeGitLabConnector(config, fetchImpl, async () => ['93.184.216.34']),
    );
    registerTestConnector(r, 'datadog', (config) => stubConnector('datadog', config));
    return r;
  }

  /** Mounts the connector router with an injected fetch so the test route probes the fake apiserver. */
  function makeConnApp(
    fetchImpl: typeof fetch = fetch,
    discoverGitLabProjects?: Parameters<typeof connectorRoutes>[0]['discoverGitLabProjects'],
    secretStore: SecretStore = secrets,
    integrations?: {
      discoverGroup?: Parameters<typeof connectorRoutes>[0]['discoverGitLabGroup'];
      discoverInstallations?: (
        settings: Record<string, unknown>,
        credential: string,
      ) => Promise<GitHubInstallationSummary[]>;
      discoverRepositories?: (
        settings: Record<string, unknown>,
        credential: string,
      ) => Promise<GitHubRepositorySummary[]>;
      convertManifest?: Parameters<typeof connectorRoutes>[0]['convertGitHubAppManifest'];
      registry?: ConnectorRegistry;
      log?: Parameters<typeof connectorRoutes>[0]['log'];
      githubSmee?: Parameters<typeof connectorRoutes>[0]['githubSmee'];
      gitlabSmee?: Parameters<typeof connectorRoutes>[0]['gitlabSmee'];
      alertmanagerSmee?: Parameters<typeof connectorRoutes>[0]['alertmanagerSmee'];
      cache?: Parameters<typeof connectorRoutes>[0]['cache'];
      statusCakeFetch?: typeof fetch;
    },
  ): Hono {
    const h = new Hono();
    h.route(
      '/connectors',
      connectorRoutes({
        auth,
        db: app.db,
        secrets: secretStore,
        registry: integrations?.registry ?? testRegistry(fetchImpl),
        discoverGitLabProjects,
        discoverGitLabGroup: integrations?.discoverGroup,
        discoverGitHubInstallations: integrations?.discoverInstallations,
        discoverGitHubRepositories: integrations?.discoverRepositories,
        convertGitHubAppManifest: integrations?.convertManifest,
        log: integrations?.log,
        githubSmee: integrations?.githubSmee,
        gitlabSmee: integrations?.gitlabSmee,
        alertmanagerSmee: integrations?.alertmanagerSmee,
        cache: integrations?.cache,
        statusCakeFetch: integrations?.statusCakeFetch,
      }),
    );
    return h;
  }

  function githubRegistry(result: {
    status: 'healthy' | 'unhealthy';
    reachable: boolean;
    authorized: boolean;
    warnings: string[];
    checks?: Record<string, boolean>;
    failureCategory?: 'permission_denied' | 'rate_limited' | 'provider_unavailable' | 'unreachable';
    durationMs?: number;
    rateLimitRemaining?: number;
    rateLimitResetAt?: string;
  }): ConnectorRegistry {
    const registry = new ConnectorRegistry();
    registerTestConnector(registry, 'github', (config) => ({
      ...stubConnector('github', config),
      probe: async () => result,
    }));
    return registry;
  }

  async function clearGitHub(): Promise<void> {
    await admin.db.delete(githubEvents).where(eq(githubEvents.tenantId, tenantA));
    await admin.db.delete(githubRepositories).where(eq(githubRepositories.tenantId, tenantA));
    await admin.db
      .delete(githubManifestSessions)
      .where(eq(githubManifestSessions.tenantId, tenantA));
    const connectors = await admin.db
      .select({ id: connectorConfigs.id })
      .from(connectorConfigs)
      .where(and(eq(connectorConfigs.tenantId, tenantA), eq(connectorConfigs.type, 'github')));
    for (const connector of connectors) {
      await admin.db
        .delete(tenantSecrets)
        .where(
          and(
            eq(tenantSecrets.tenantId, tenantA),
            eq(tenantSecrets.name, connectorCredentialKey(connector.id)),
          ),
        );
    }
    await admin.db
      .delete(connectorConfigs)
      .where(and(eq(connectorConfigs.tenantId, tenantA), eq(connectorConfigs.type, 'github')));
  }

  const K8S_SETTINGS = {
    accessId: 'a1b2c3d4',
    apiUrl: 'https://k8s.example.com:6443',
    namespace: 'prod',
  };

  async function saveK8s(
    org: string,
    body: { settings: Record<string, unknown>; credential?: string },
  ): Promise<void> {
    const res = await api.request('/connectors/kubernetes', {
      method: 'PUT',
      headers: bearer(await sign(org, ['admin'])),
      body: JSON.stringify({ ...body, enabled: false }),
    });
    expect(res.status).toBe(200);
  }

  async function connectorEnabled(org: string, type: string): Promise<boolean | undefined> {
    const res = await api.request('/connectors', {
      headers: { authorization: `Bearer ${await sign(org, ['responder'])}` },
    });
    const rows = ((await res.json()) as { connectors: Array<{ type: string; enabled: boolean }> })
      .connectors;
    return rows.find((r) => r.type === type)?.enabled;
  }

  async function k8sEnabled(org: string): Promise<boolean | undefined> {
    return connectorEnabled(org, 'kubernetes');
  }

  async function saveDatadog(org: string): Promise<void> {
    const res = await api.request('/connectors/datadog', {
      method: 'PUT',
      headers: bearer(await sign(org, ['admin'])),
      body: JSON.stringify({
        settings: { site: 'datadoghq.com' },
        credential: JSON.stringify({ apiKey: 'dd-api-key', appKey: 'dd-app-key' }),
      }),
    });
    expect(res.status).toBe(200);
  }

  return {
    ADMIN_URL,
    APP_URL,
    ISSUER,
    AUDIENCE,
    KID,
    KEY,
    GITHUB_WEBHOOK_SECRET,
    get admin() {
      return admin;
    },
    set admin(value: typeof admin) {
      admin = value;
    },
    get app() {
      return app;
    },
    set app(value: typeof app) {
      app = value;
    },
    get api() {
      return api;
    },
    set api(value: typeof api) {
      api = value;
    },
    get secrets() {
      return secrets;
    },
    set secrets(value: typeof secrets) {
      secrets = value;
    },
    get privateKey() {
      return privateKey;
    },
    set privateKey(value: typeof privateKey) {
      privateKey = value;
    },
    get authKeys() {
      return authKeys;
    },
    set authKeys(value: typeof authKeys) {
      authKeys = value;
    },
    get orgA() {
      return orgA;
    },
    set orgA(value: typeof orgA) {
      orgA = value;
    },
    get tenantA() {
      return tenantA;
    },
    set tenantA(value: typeof tenantA) {
      tenantA = value;
    },
    get orgB() {
      return orgB;
    },
    set orgB(value: typeof orgB) {
      orgB = value;
    },
    get tenantB() {
      return tenantB;
    },
    set tenantB(value: typeof tenantB) {
      tenantB = value;
    },
    sign,
    bearer,
    activeConnector,
    activeCredential,
    fakeApiserver,
    testRegistry,
    makeConnApp,
    githubRegistry,
    clearGitHub,
    K8S_SETTINGS,
    saveK8s,
    connectorEnabled,
    k8sEnabled,
    saveDatadog,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
