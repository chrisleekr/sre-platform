import { seedMembership } from '@sre/db/test-support';
import { ConnectorRegistry, stubConnector } from '@sre/connectors';
import {
  connectorConfigs,
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
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { connectorRoutes } from '../connectors';
import type { AuthDeps } from '../auth';
import { makeTestAuth } from './auth-test-support';
import { registerTestConnector } from './connector-registry';

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL!;

  const APP_URL = process.env.APP_DATABASE_URL!;

  const ISSUER = 'https://argocd-lifecycle.test/';

  const AUDIENCE = 'sre-api';

  const KID = 'argocd-lifecycle';

  const ENCRYPTION_KEY = Buffer.alloc(32, 41).toString('base64');

  let admin: DbHandle;

  let app: DbHandle;

  let secrets: SecretStore;

  let privateKey: CryptoKey;

  let keys: ReturnType<typeof createLocalJWKSet>;

  let auth: AuthDeps;

  let subject: string;

  let tenantId: string;

  function registry(): ConnectorRegistry {
    const result = new ConnectorRegistry();
    registerTestConnector(result, 'argocd', (config) => stubConnector('argocd', config));
    return result;
  }

  function connectorApp(connectorRegistry: ConnectorRegistry = registry()): Hono {
    const api = new Hono();
    api.route(
      '/connectors',
      connectorRoutes({
        auth,
        db: app.db,
        secrets,
        registry: connectorRegistry,
      }),
    );
    return api;
  }

  async function headers(): Promise<{ authorization: string; 'content-type': string }> {
    const token = await new SignJWT({ sub: subject })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  }

  function projectSettings(
    baseUrl = 'https://argocd.internal.example',
    extra: Record<string, unknown> = {},
  ) {
    return {
      baseUrl,
      accessRole: 'sre-platform-a1b2c3d4',
      applicationsInAnyNamespace: false,
      projects: [{ project: 'payments', applications: [{ name: 'checkout' }] }],
      ...extra,
    };
  }

  function projectCredentials(token: string) {
    return [{ project: 'payments', token }];
  }

  function storedCredential(token: string): string {
    return JSON.stringify({ version: 1, tokens: projectCredentials(token) });
  }

  async function activeArgoCdId(): Promise<string> {
    const [connector] = await withTenant(app.db, tenantId, (tx) =>
      tx
        .select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(and(eq(connectorConfigs.type, 'argocd'), isNull(connectorConfigs.deletedAt)))
        .limit(1),
    );
    if (!connector) throw new Error('expected active Argo CD data source');
    return connector.id;
  }

  beforeAll(async () => {
    expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    secrets = makeSecretStore(app.db, ENCRYPTION_KEY);

    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);

    subject = `argocd-${randomUUID()}`;
    tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'ArgoCD acceptance' });
    await seedMembership(admin.db, { issuer: ISSUER, subject }, tenantId, 'admin');
    auth = await makeTestAuth({
      adminDb: admin.db,
      appDb: app.db,
      issuer: ISSUER,
      audience: AUDIENCE,
      keys,
      bindings: [{ tenantId, subject }],
    });
  }, 30_000);

  beforeEach(async () => {
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(tenantSecrets).where(eq(tenantSecrets.tenantId, tenantId));
  });

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
      await admin.db.delete(tenantSecrets).where(eq(tenantSecrets.tenantId, tenantId));
      await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
      await admin.db
        .delete(tenantIdentityBindings)
        .where(eq(tenantIdentityBindings.tenantId, tenantId));
      await admin.db.delete(users).where(and(eq(users.issuer, ISSUER), eq(users.subject, subject)));
      await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
      await admin.close();
    }
    if (app) await app.close();
  });

  return {
    ADMIN_URL,
    APP_URL,
    ISSUER,
    AUDIENCE,
    KID,
    ENCRYPTION_KEY,
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
    get keys() {
      return keys;
    },
    set keys(value: typeof keys) {
      keys = value;
    },
    get subject() {
      return subject;
    },
    set subject(value: typeof subject) {
      subject = value;
    },
    get tenantId() {
      return tenantId;
    },
    set tenantId(value: typeof tenantId) {
      tenantId = value;
    },
    registry,
    connectorApp,
    headers,
    projectSettings,
    projectCredentials,
    storedCredential,
    activeArgoCdId,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
