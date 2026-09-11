import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  directoryAccounts,
  identityProviders,
  makeDb,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import type { AuthDeps, AuthVariables } from '../../auth';
import { scimRoutes } from '../../scim/routes';
import { tenantSettingsRoutes } from '../tenant-settings';

const marker = randomUUID();
const tenantId = randomUUID();
const providerId = randomUUID();
const foreignProviderId = randomUUID();
const userId = randomUUID();
const issuer = `https://tenant-scim-${marker}.invalid`;
let db: DbHandle;
let api: Hono<{ Variables: AuthVariables }>;

function body(path: string, method: string, value: unknown) {
  return api.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(identityProviders).values([
    {
      id: providerId,
      displayName: 'Tenant SCIM provider',
      issuer,
      jwksUri: `${issuer}/jwks`,
      authorizationEndpoint: `${issuer}/authorize`,
      browserClientId: 'tenant-scim-client',
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
    },
    {
      id: foreignProviderId,
      displayName: 'Foreign SCIM provider',
      issuer: `${issuer}/foreign`,
      jwksUri: `${issuer}/foreign/jwks`,
      authorizationEndpoint: `${issuer}/foreign/authorize`,
      browserClientId: 'foreign-scim-client',
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
    },
  ]);
  await db.db.insert(tenants).values({ id: tenantId, name: 'SCIM tenant', slug: `scim-${marker}` });
  await db.db.insert(tenantIdentityBindings).values({ tenantId, providerId, claimValue: null });
  await db.db
    .insert(users)
    .values({ id: userId, issuer, subject: 'owner', email: 'owner@example.test' });
  const auth: AuthDeps = {
    browserSession: async () => ({
      ok: true,
      user: {
        userId,
        issuer,
        subject: 'owner',
        email: 'owner@example.test',
        providerId,
        bindingClaimValue: null,
        issuedAt: Date.now() / 1_000,
        expiresAt: Date.now() / 1_000 + 3_600,
      },
      tenant: {
        tenantId,
        issuer,
        sub: 'owner',
        userId,
        issuedAt: Date.now() / 1_000,
        expiresAt: Date.now() / 1_000 + 3_600,
        role: 'owner',
        founderOnly: false,
      },
      scopes: [],
    }),
    verifiers: {
      byIssuer: async () => undefined,
      forFounding: async () => undefined,
      invalidate() {},
    },
    db: db.db,
    adminDb: db.db,
    settings: { get: async () => 86_400 },
    revoke: { publish: async () => undefined },
  };
  api = new Hono<{ Variables: AuthVariables }>();
  api.route('/', tenantSettingsRoutes({ auth, db: db.db }));
});

afterAll(async () => {
  if (!db) return;
  await db.db
    .delete(directoryAccounts)
    .where(inArray(directoryAccounts.providerId, [providerId, foreignProviderId]));
  await db.db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.db.delete(users).where(eq(users.id, userId));
  await db.db
    .delete(identityProviders)
    .where(inArray(identityProviders.id, [providerId, foreignProviderId]));
  await db.close();
});

test('owner enables, rotates, updates, lists, and disables SCIM without exposing its hash', async () => {
  const enabled = await body(`/tenant/providers/${providerId}/scim/credential`, 'POST', {
    enabled: true,
    requireProvisioned: true,
    identityAttribute: 'externalId',
  });
  expect(enabled.status).toBe(200);
  expect(enabled.headers.get('cache-control')).toBe('no-store');
  const first = (await enabled.json()) as { token: string; scim: { scimTokenExpiresAt: string } };
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(new Date(first.scim.scimTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
  const [stored] = await db.db
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.id, providerId));
  expect(stored!.scimTokenHash).toBe(createHash('sha256').update(first.token).digest('hex'));
  expect(JSON.stringify(stored)).not.toContain(first.token);

  const rotated = await body(`/tenant/providers/${providerId}/scim/credential`, 'POST', {
    enabled: true,
    requireProvisioned: false,
    identityAttribute: 'userName',
  });
  const second = (await rotated.json()) as { token: string };
  expect(second.token).not.toBe(first.token);
  const scimApi = new Hono().route('/', scimRoutes({ db: db.db, revoke: authNoop }));
  const oldCredential = await scimApi.request(
    `/scim/v2/providers/${providerId}/ServiceProviderConfig`,
    {
      headers: { authorization: `Bearer ${first.token}` },
    },
  );
  expect(oldCredential.status).toBe(401);
  const newCredential = await scimApi.request(
    `/scim/v2/providers/${providerId}/ServiceProviderConfig`,
    {
      headers: { authorization: `Bearer ${second.token}` },
    },
  );
  expect(newCredential.status).toBe(200);

  const settings = await api.request('/tenant/settings');
  const settingsText = await settings.text();
  expect(settingsText).not.toContain(first.token);
  expect(settingsText).not.toContain(second.token);
  expect(settingsText).not.toContain(hash(first.token));
  expect(settingsText).toContain('"scimIdentityAttribute":"userName"');

  expect(
    (
      await body(`/tenant/providers/${providerId}/scim`, 'PUT', {
        enabled: false,
        requireProvisioned: false,
        identityAttribute: 'userName',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await scimApi.request(`/scim/v2/providers/${providerId}/ServiceProviderConfig`, {
        headers: { authorization: `Bearer ${second.token}` },
      })
    ).status,
  ).toBe(401);
});

const authNoop = { publish: async () => undefined };

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

test('workspace endpoints reject foreign providers and list only current owned accounts', async () => {
  expect(
    (
      await body(`/tenant/providers/${foreignProviderId}/scim/credential`, 'POST', {
        enabled: true,
        requireProvisioned: false,
        identityAttribute: 'externalId',
      })
    ).status,
  ).toBe(404);
  await db.db.insert(directoryAccounts).values([
    {
      providerId,
      externalId: 'current',
      userName: 'current@example.test',
    },
    {
      providerId,
      externalId: 'deleted',
      userName: 'deleted@example.test',
      active: false,
      deletedAt: new Date(),
    },
    {
      providerId: foreignProviderId,
      externalId: 'foreign',
      userName: 'foreign@example.test',
    },
  ]);
  const response = await api.request(`/tenant/providers/${providerId}/scim/accounts`);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    total: 1,
    accounts: [{ externalId: 'current' }],
  });
});
