import { seedMembership } from '@sre/db/test-support';
import { ConnectorRegistry, makeArgoCdConnector } from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  tenantSecrets,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { connectorRoutes } from '../connectors';
import { registerTestConnector } from './connector-registry';
import { makeTestAuth } from './auth-test-support';

const baseUrl = process.env.ARGOCD_LIVE_BASE_URL;
const providerToken = process.env.ARGOCD_LIVE_TOKEN;
const application = process.env.ARGOCD_LIVE_APPLICATION;
const project = process.env.ARGOCD_LIVE_PROJECT ?? 'default';
const caCert = process.env.ARGOCD_LIVE_CA;
const configured = Boolean(baseUrl && providerToken && application && caCert);
const ISSUER = 'https://argocd-live.test/';
const AUDIENCE = 'sre-api';
const KID = 'argocd-live';

describe.skipIf(!configured)('ArgoCD disposable lifecycle proof', () => {
  let admin: DbHandle;
  let app: DbHandle;
  let api: Hono;
  let tenantId: string;
  let subject: string;
  let sign: () => Promise<string>;

  beforeAll(async () => {
    expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
    admin = makeDb(process.env.DATABASE_URL!);
    app = makeDb(process.env.APP_DATABASE_URL!);
    const secrets = makeSecretStore(app.db, Buffer.alloc(32, 55).toString('base64'));
    const pair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
    sign = () =>
      new SignJWT({ sub: subject })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(pair.privateKey);
    tenantId = randomUUID();
    subject = `argocd-live-${randomUUID()}`;
    await admin.db.insert(tenants).values({ id: tenantId, name: 'ArgoCD live proof' });
    // Connector configuration changes are reserved to an owner or administrator, and this proof
    // saves, verifies and disconnects, so a default `member` membership would make every write 403.
    await seedMembership(admin.db, { issuer: ISSUER, subject }, tenantId, 'admin');
    const registry = new ConnectorRegistry();
    registerTestConnector(registry, 'argocd', (config) => makeArgoCdConnector(config));
    api = new Hono();
    api.route(
      '/connectors',
      connectorRoutes({
        auth: await makeTestAuth({
          adminDb: admin.db,
          appDb: app.db,
          issuer: ISSUER,
          audience: AUDIENCE,
          keys,
          bindings: [{ tenantId, subject }],
        }),
        db: app.db,
        secrets,
        registry,
      }),
    );
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
      await admin.db.delete(tenantSecrets).where(eq(tenantSecrets.tenantId, tenantId));
      await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
      await admin.db
        .delete(tenantIdentityBindings)
        .where(eq(tenantIdentityBindings.tenantId, tenantId));
      await admin.db.delete(users).where(eq(users.issuer, ISSUER));
      await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
      await admin.close();
    }
    if (app) await app.close();
  });

  test('saves, verifies, reconnects without token projection, and disconnects idempotently', async () => {
    const headers = {
      authorization: `Bearer ${await sign()}`,
      'content-type': 'application/json',
    };
    const settings = {
      baseUrl,
      applicationsInAnyNamespace: false,
      projects: [{ project, applications: [{ name: application }] }],
      caCert,
    };
    expect(
      (
        await api.request('/connectors/argocd', {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            settings,
            credentials: [{ project, token: providerToken }],
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.request('/connectors/argocd/test', {
          method: 'POST',
          headers,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.request('/connectors/argocd', {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            settings: { ...settings, labelSelector: 'sre-platform-proof=true' },
          }),
        })
      ).status,
    ).toBe(200);
    const verified = await api.request('/connectors/argocd/test', { method: 'POST', headers });
    expect(verified.status).toBe(200);
    const verifiedBody = await verified.json();
    expect(verifiedBody, JSON.stringify(verifiedBody)).toMatchObject({
      status: 'healthy',
      enabled: true,
    });
    const listed = await api.request('/connectors', { headers });
    const listedBody = await listed.text();
    expect(listedBody).not.toContain(providerToken);
    expect(listedBody).not.toContain(caCert);
    expect(JSON.parse(listedBody)).toEqual({
      connectors: expect.arrayContaining([
        expect.objectContaining({
          type: 'argocd',
          settings: expect.objectContaining({ caConfigured: true }),
        }),
      ]),
    });
    expect((await api.request('/connectors/argocd', { method: 'DELETE', headers })).status).toBe(
      200,
    );
    expect((await api.request('/connectors/argocd', { method: 'DELETE', headers })).status).toBe(
      200,
    );
    expect(
      await makeSecretStore(app.db, Buffer.alloc(32, 55).toString('base64')).get(
        tenantId,
        connectorCredentialKey('argocd'),
      ),
    ).toBeNull();
  }, 60_000);
});
