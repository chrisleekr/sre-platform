import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { adminActions, identityProviders, makeDb, users, type DbHandle } from '@sre/db';
import type { AuthDeps } from '../../auth';
import { adminProviderRoutes } from '../providers';
import type { AdminRoutesDeps, AdminVariables } from '../contracts';

const marker = randomUUID();
const providerId = randomUUID();
const tenantProviderId = randomUUID();
const actorUserId = randomUUID();
const issuer = `https://admin-scim-${marker}.invalid`;
let db: DbHandle;
let api: Hono<{ Variables: AdminVariables }>;

function mutation(path: string, method: string, value: unknown) {
  return api.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(users).values({ id: actorUserId, issuer, subject: 'admin' });
  await db.db.insert(identityProviders).values([
    {
      id: providerId,
      displayName: 'Installation SCIM provider',
      issuer,
      jwksUri: `${issuer}/jwks`,
      authorizationEndpoint: `${issuer}/authorize`,
      browserClientId: 'admin-scim-client',
      kind: 'oidc',
      scope: 'installation',
      status: 'active',
    },
    {
      id: tenantProviderId,
      displayName: 'Tenant SCIM provider',
      issuer: `${issuer}/tenant`,
      jwksUri: `${issuer}/tenant/jwks`,
      authorizationEndpoint: `${issuer}/tenant/authorize`,
      browserClientId: 'tenant-scim-client',
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
    },
  ]);
  const auth = {
    verifiers: {
      byIssuer: async () => undefined,
      forFounding: async () => undefined,
      invalidate() {},
    },
    db: db.db,
    adminDb: db.db,
    settings: { get: async () => 86_400 },
    revoke: { publish: async () => undefined },
  } satisfies AuthDeps;
  api = new Hono<{ Variables: AdminVariables }>();
  api.use('*', async (c, next) => {
    c.set('user', {
      userId: actorUserId,
      issuer,
      subject: 'admin',
      providerId,
      issuedAt: Date.now() / 1_000,
      expiresAt: Date.now() / 1_000 + 3_600,
    });
    await next();
  });
  api.route(
    '/admin/providers',
    adminProviderRoutes({
      auth,
      appDb: db.db,
      controlDb: db.db,
      settings: null as unknown as AdminRoutesDeps['settings'],
    }),
  );
});

afterAll(async () => {
  if (!db) return;
  await db.db.delete(adminActions).where(eq(adminActions.actorUserId, actorUserId));
  await db.db
    .delete(identityProviders)
    .where(inArray(identityProviders.id, [providerId, tenantProviderId]));
  await db.db.delete(users).where(eq(users.id, actorUserId));
  await db.close();
});

test('platform administrator manages installation SCIM without receiving a stored hash', async () => {
  const enabled = await mutation(`/admin/providers/${providerId}/scim/credential`, 'POST', {
    enabled: true,
    requireProvisioned: true,
    identityAttribute: 'externalId',
    reason: 'Enable directory provisioning',
  });
  expect(enabled.status).toBe(200);
  expect(enabled.headers.get('cache-control')).toBe('no-store');
  const result = (await enabled.json()) as { token: string };
  expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const listed = await api.request('/admin/providers');
  const text = await listed.text();
  expect(text).not.toContain(result.token);
  expect(text).not.toContain('scimTokenHash');
  expect(text).toContain('"scimEnabled":true');
  const [action] = await db.db
    .select()
    .from(adminActions)
    .where(eq(adminActions.actorUserId, actorUserId));
  expect(action).toMatchObject({ action: 'provider.scim.rotate', targetId: providerId });
  expect(
    (
      await mutation(`/admin/providers/${providerId}/scim`, 'PUT', {
        enabled: false,
        requireProvisioned: false,
        identityAttribute: 'externalId',
        reason: 'Disable directory provisioning',
      })
    ).status,
  ).toBe(200);
});

test('platform administration cannot mutate a workspace-owned provider', async () => {
  expect(
    (
      await mutation(`/admin/providers/${tenantProviderId}/scim/credential`, 'POST', {
        enabled: true,
        requireProvisioned: false,
        identityAttribute: 'externalId',
      })
    ).status,
  ).toBe(404);
});

test('SCIM cannot be enabled for an inactive provider', async () => {
  await db.db
    .update(identityProviders)
    .set({ status: 'disabled' })
    .where(eq(identityProviders.id, providerId));
  try {
    expect(
      (
        await mutation(`/admin/providers/${providerId}/scim/credential`, 'POST', {
          enabled: true,
          requireProvisioned: false,
          identityAttribute: 'externalId',
        })
      ).status,
    ).toBe(409);
  } finally {
    await db.db
      .update(identityProviders)
      .set({ status: 'active' })
      .where(eq(identityProviders.id, providerId));
  }
});
