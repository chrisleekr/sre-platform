import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  identityProviders,
  makeDb,
  makeSecretStore,
  memberships,
  platformAdminInvitations,
  platformOperators,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { makeApp } from '../app';
import { makeRevokePublisher } from '../auth/revoke';
import type { Redis } from 'ioredis';
import * as authModule from '../auth';
import {
  authMiddleware,
  requirePlatformAdmin,
  requireTenant,
  requireUser,
  type AuthDeps,
  type AuthVariables,
} from '../auth';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const ISSUER = `https://access-${randomUUID()}.provider.invalid/`;
const AUDIENCE = 'sre-api';
const KID = 'auth-access-key';
const PROVIDER_ID = randomUUID();
const ACTIVE_TENANT_ID = randomUUID();
const SUSPENDED_TENANT_ID = randomUUID();
const SECRET_KEY = Buffer.alloc(32, 8).toString('base64');

let admin: DbHandle;
let app: DbHandle;
let privateKey: CryptoKey;
let auth: AuthDeps;
let maxLifetimeSec = 86_400;
const publish = vi.fn<(message: { userId: string; tenantId?: string }) => Promise<void>>();

async function sign(
  subject: string,
  options: {
    issuer?: string;
    organizationId?: string;
    email?: string;
    issuedAt?: number;
    expiresAt?: number;
  } = {},
): Promise<string> {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: subject,
    organization_id: options.organizationId,
    email: options.email,
    email_verified: options.email ? true : undefined,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(options.expiresAt ?? issuedAt + 300)
    .sign(privateKey);
}

function routes(authDeps = auth) {
  const api = new Hono<{ Variables: AuthVariables }>();
  api.get('/identity', requireUser(authDeps), (c) =>
    c.json({ user: c.get('user'), tenant: c.get('tenant') ?? null }),
  );
  api.get('/tenant', requireUser(authDeps), requireTenant(), (c) => c.json(c.get('tenant')));
  api.get('/admin', requireUser(authDeps), requirePlatformAdmin(authDeps), (c) =>
    c.json({ user: c.get('user') }),
  );
  api.get('/legacy', authMiddleware(authDeps), (c) => c.json(c.get('tenant')));
  return api;
}

const settings = {
  get: async () => maxLifetimeSec,
  list: async () => [],
  set: async (_key: string, value: unknown) => Number(value),
};

function application(authDeps = auth) {
  return makeApp({
    auth: { ...authDeps, settings },
    readinessDb: app.db,
    appDb: app.db,
    adminDb: admin.db,
    secrets: makeSecretStore(app.db, SECRET_KEY),
    cache: { get: async () => [], set: async () => {} },
    settings: { list: settings.list, set: settings.set },
  });
}

async function insertUser(
  subject: string,
  values: Partial<typeof users.$inferInsert>,
): Promise<string> {
  const [row] = await admin.db
    .insert(users)
    .values({ issuer: ISSUER, subject, ...values })
    .returning({ id: users.id });
  return row!.id;
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);

  await admin.db.insert(identityProviders).values({
    id: PROVIDER_ID,
    displayName: 'Auth access test',
    issuer: ISSUER,
    jwksUri: `${ISSUER}.well-known/jwks.json`,
    audience: AUDIENCE,
    kind: 'oidc',
    scope: 'installation',
    supportsSignup: false,
    emailClaim: 'email',
    subjectClaim: 'sub',
    tenantClaim: 'organization_id',
    status: 'active',
  });
  await admin.db.insert(tenants).values([
    { id: ACTIVE_TENANT_ID, name: 'Auth active', slug: `auth-active-${randomUUID()}` },
    {
      id: SUSPENDED_TENANT_ID,
      name: 'Auth suspended',
      slug: `auth-suspended-${randomUUID()}`,
      status: 'suspended',
    },
  ]);
  await admin.db.insert(tenantIdentityBindings).values([
    { tenantId: ACTIVE_TENANT_ID, providerId: PROVIDER_ID, claimValue: 'active' },
    { tenantId: SUSPENDED_TENANT_ID, providerId: PROVIDER_ID, claimValue: 'suspended' },
    { tenantId: ACTIVE_TENANT_ID, providerId: PROVIDER_ID, claimValue: null },
  ]);

  auth = {
    verifiers: {
      byIssuer: async (issuer) =>
        issuer === ISSUER
          ? {
              providerId: PROVIDER_ID,
              issuer: ISSUER,
              audience: AUDIENCE,
              keys,
              emailClaim: 'email',
              subjectClaim: 'sub',
              tenantClaim: 'organization_id',
              scope: 'installation',
            }
          : undefined,
      forFounding: async () => undefined,
      invalidate() {},
    },
    db: app.db,
    adminDb: admin.db,
    settings: { get: async () => maxLifetimeSec },
    revoke: { publish },
  };
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db
      .delete(platformOperators)
      .where(sql`user_id in (select id from users where issuer = ${ISSUER})`);
    await admin.db
      .delete(platformAdminInvitations)
      .where(eq(platformAdminInvitations.issuer, ISSUER));
    await admin.db
      .delete(memberships)
      .where(sql`tenant_id in (${ACTIVE_TENANT_ID}, ${SUSPENDED_TENANT_ID})`);
    await admin.db
      .delete(tenantIdentityBindings)
      .where(eq(tenantIdentityBindings.providerId, PROVIDER_ID));
    await admin.db.delete(users).where(eq(users.issuer, ISSUER));
    await admin.db.delete(identityProviders).where(eq(identityProviders.id, PROVIDER_ID));
    await admin.db.delete(tenants).where(sql`id in (${ACTIVE_TENANT_ID}, ${SUSPENDED_TENANT_ID})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('identity, tenant, and platform administrator gates', () => {
  test('unknown issuers and overlong credentials fail before identity work', async () => {
    const api = routes();
    const unknown = await api.request('/identity', {
      headers: {
        authorization: `Bearer ${await sign('unknown', { issuer: 'https://unknown.invalid/' })}`,
      },
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: 'invalid token' });

    maxLifetimeSec = 600;
    const issuedAt = Math.floor(Date.now() / 1000);
    const overlong = await api.request('/identity', {
      headers: {
        authorization: `Bearer ${await sign('overlong', { issuedAt, expiresAt: issuedAt + 601 })}`,
      },
    });
    expect(overlong.status).toBe(401);
    expect(await overlong.json()).toEqual({
      error: 'token lifetime exceeds the platform maximum of 600 seconds',
    });
    maxLifetimeSec = 86_400;
    expect(
      await admin.db.select({ id: users.id }).from(users).where(eq(users.subject, 'overlong')),
    ).toHaveLength(0);
  });

  test('an unaffiliated identity reaches identity-only routes but not tenant routes', async () => {
    const api = routes();
    const authorization = `Bearer ${await sign('unaffiliated')}`;
    const identity = await api.request('/identity', { headers: { authorization } });
    expect(identity.status).toBe(200);
    expect(await identity.json()).toMatchObject({
      user: { issuer: ISSUER, subject: 'unaffiliated', providerId: PROVIDER_ID },
      tenant: null,
    });

    const tenant = await api.request('/tenant', { headers: { authorization } });
    expect(tenant.status).toBe(403);
    expect(await tenant.json()).toMatchObject({ state: 'unaffiliated' });
  });

  test('provider scope, not tenant-claim presence, controls binding selection', async () => {
    const base = await auth.verifiers.byIssuer(ISSUER);
    expect(base).toBeDefined();
    const verifier = (overrides: Partial<NonNullable<typeof base>>): AuthDeps => ({
      ...auth,
      verifiers: {
        ...auth.verifiers,
        byIssuer: async (issuer) => (issuer === ISSUER ? { ...base!, ...overrides } : undefined),
      },
    });

    const tenantScoped = await routes(
      verifier({ scope: 'tenant', tenantClaim: 'organization_id' }),
    ).request('/tenant', {
      headers: {
        authorization: `Bearer ${await sign('tenant-scope-user', {
          organizationId: 'suspended',
        })}`,
      },
    });
    expect(tenantScoped.status).toBe(200);
    expect(await tenantScoped.json()).toMatchObject({ tenantId: ACTIVE_TENANT_ID });

    const installationWithoutClaimName = await routes(
      verifier({ scope: 'installation', tenantClaim: null }),
    ).request('/identity', {
      headers: {
        authorization: `Bearer ${await sign('installation-misconfigured', {
          organizationId: 'active',
        })}`,
      },
    });
    expect(installationWithoutClaimName.status).toBe(200);
    expect(await installationWithoutClaimName.json()).toMatchObject({ tenant: null });

    const installationWithoutClaimValue = await routes(
      verifier({ scope: 'installation', tenantClaim: 'organization_id' }),
    ).request('/identity', {
      headers: {
        authorization: `Bearer ${await sign('installation-empty-claim', {
          organizationId: '   ',
        })}`,
      },
    });
    expect(installationWithoutClaimValue.status).toBe(200);
    expect(await installationWithoutClaimValue.json()).toMatchObject({ tenant: null });
  });

  test('rejects far-future issued-at values and credentials whose issue time is not before expiry', async () => {
    const now = Math.floor(Date.now() / 1_000);
    const api = routes();
    const farFuture = await api.request('/identity', {
      headers: {
        authorization: `Bearer ${await sign('future-issued', {
          issuedAt: now + 120,
          expiresAt: now + 300,
        })}`,
      },
    });
    expect(farFuture.status).toBe(401);
    expect(await farFuture.json()).toEqual({ error: 'invalid token' });

    const invalidOrder = await api.request('/identity', {
      headers: {
        authorization: `Bearer ${await sign('invalid-order', {
          issuedAt: now + 20,
          expiresAt: now + 10,
        })}`,
      },
    });
    expect(invalidOrder.status).toBe(401);
    expect(await invalidOrder.json()).toEqual({ error: 'invalid token' });
    expect(
      await admin.db
        .select({ id: users.id })
        .from(users)
        .where(sql`${users.subject} in ('future-issued', 'invalid-order')`),
    ).toHaveLength(0);
  });

  test('requires the base JWT subject even when a configured subject claim is present', async () => {
    const base = await auth.verifiers.byIssuer(ISSUER);
    expect(base).toBeDefined();
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({
      custom_subject: 'custom-subject-without-sub',
      organization_id: 'active',
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(privateKey);
    const response = await routes({
      ...auth,
      verifiers: {
        ...auth.verifiers,
        byIssuer: async (issuer) =>
          issuer === ISSUER ? { ...base!, subjectClaim: 'custom_subject' } : undefined,
      },
    }).request('/identity', { headers: { authorization: `Bearer ${token}` } });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'token missing iss or sub' });
    expect(
      await admin.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.subject, 'custom-subject-without-sub')),
    ).toHaveLength(0);
  });

  test('uses a configured subject claim after requiring the base JWT subject', async () => {
    const base = await auth.verifiers.byIssuer(ISSUER);
    expect(base).toBeDefined();
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({
      custom_subject: 'configured-subject',
      organization_id: 'active',
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('base-subject')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(privateKey);
    const response = await routes({
      ...auth,
      verifiers: {
        ...auth.verifiers,
        byIssuer: async (issuer) =>
          issuer === ISSUER ? { ...base!, subjectClaim: 'custom_subject' } : undefined,
      },
    }).request('/identity', { headers: { authorization: `Bearer ${token}` } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { subject: 'configured-subject' } });
    expect(
      await admin.db
        .select({ subject: users.subject })
        .from(users)
        .where(sql`${users.subject} in ('base-subject', 'configured-subject')`),
    ).toEqual([{ subject: 'configured-subject' }]);
  });

  test('disabled, deleted, and revoked users fail before a binding can create membership', async () => {
    const disabledId = await insertUser('disabled-user', { status: 'disabled' });
    const deletedId = await insertUser('deleted-user', { status: 'deleted' });
    const issuedAt = Math.floor(Date.now() / 1000);
    const revokedId = await insertUser('revoked-user', {
      notBefore: new Date((issuedAt + 30) * 1_000),
    });
    const api = routes();

    const disabled = await api.request('/tenant', {
      headers: {
        authorization: `Bearer ${await sign('disabled-user', { organizationId: 'active' })}`,
      },
    });
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toEqual({ error: 'account disabled', state: 'disabled' });
    const deleted = await api.request('/tenant', {
      headers: {
        authorization: `Bearer ${await sign('deleted-user', { organizationId: 'active' })}`,
      },
    });
    expect(deleted.status).toBe(401);
    expect(await deleted.json()).toEqual({ error: 'invalid token' });
    const revoked = await api.request('/tenant', {
      headers: {
        authorization: `Bearer ${await sign('revoked-user', { organizationId: 'active', issuedAt })}`,
      },
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: 'signed out, sign in again' });
    expect(
      await admin.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(sql`user_id in (${disabledId}, ${deletedId}, ${revokedId})`),
    ).toHaveLength(0);
  });

  test('a suspended binding never exposes tenant context', async () => {
    const api = routes();
    const response = await api.request('/tenant', {
      headers: {
        authorization: `Bearer ${await sign('suspended-user', { organizationId: 'suspended' })}`,
      },
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({ state: 'suspended' });
    expect(body).not.toHaveProperty('tenantId');
  });

  test('administrator invitation acceptance grants identity-only access in the same request', async () => {
    const email = `admin-${randomUUID()}@example.invalid`;
    await admin.db.insert(platformAdminInvitations).values({ issuer: ISSUER, email });
    const api = routes();
    const response = await api.request('/admin', {
      headers: { authorization: `Bearer ${await sign('invited-admin', { email })}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: Record<string, unknown> };
    expect(body).toMatchObject({ user: { subject: 'invited-admin' } });
    expect(body.user).not.toHaveProperty('isPlatformAdmin');
    const [user] = await admin.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.issuer, ISSUER), eq(users.subject, 'invited-admin')));
    expect(
      await admin.db
        .select({ userId: platformOperators.userId })
        .from(platformOperators)
        .where(eq(platformOperators.userId, user!.id)),
    ).toEqual([{ userId: user!.id }]);
    expect(
      await admin.db
        .select({ acceptedAt: platformAdminInvitations.acceptedAt })
        .from(platformAdminInvitations)
        .where(
          and(
            eq(platformAdminInvitations.issuer, ISSUER),
            eq(platformAdminInvitations.email, email),
          ),
        ),
    ).toEqual([{ acceptedAt: expect.any(Date) }]);
  });

  test('the legacy composition still requires a resolved tenant and the old operator gate is gone', async () => {
    const api = routes();
    const response = await api.request('/legacy', {
      headers: {
        authorization: `Bearer ${await sign('legacy-user', { organizationId: 'active' })}`,
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenantId: ACTIVE_TENANT_ID });
    expect(requirePlatformAdmin).toBeTypeOf('function');
    expect(authModule).not.toHaveProperty('requireOperator');
  });
});

describe('sign out everywhere', () => {
  test('revokes a currently accepted token whose issue time is inside the future-skew tolerance', async () => {
    const api = application();
    const issuedAt = Math.floor(Date.now() / 1_000) + 30;
    const token = await sign('future-skew-sign-out', {
      organizationId: 'active',
      issuedAt,
      expiresAt: issuedAt + 300,
    });
    const response = await api.request('/me/sign-out-everywhere', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const [row] = await admin.db
      .select({ notBefore: users.notBefore })
      .from(users)
      .where(eq(users.subject, 'future-skew-sign-out'));
    expect(row?.notBefore?.getTime()).toBeGreaterThanOrEqual((issuedAt + 1) * 1_000);
    expect(
      (
        await api.request('/me', {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
  });

  test('persists not_before before best-effort publication', async () => {
    let durableBeforePublish = false;
    publish.mockImplementationOnce(async ({ userId }) => {
      const [row] = await admin.db
        .select({ notBefore: users.notBefore })
        .from(users)
        .where(eq(users.id, userId));
      durableBeforePublish = row?.notBefore instanceof Date;
    });
    const api = application();
    const response = await api.request('/me/sign-out-everywhere', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await sign('sign-out-user', { organizationId: 'active' })}`,
      },
    });

    expect(response.status).toBe(200);
    expect(durableBeforePublish).toBe(true);
    expect(publish).toHaveBeenCalledWith({ userId: expect.any(String) });
  });

  test('returns success after the durable write when live publication fails', async () => {
    const failingRedis = {
      publish: vi.fn().mockRejectedValue(new Error('Valkey unavailable')),
    } as unknown as Redis;
    const api = application({ ...auth, revoke: makeRevokePublisher(failingRedis) });
    const response = await api.request('/me/sign-out-everywhere', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await sign('sign-out-publish-failure', {
          organizationId: 'active',
        })}`,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const [row] = await admin.db
      .select({ notBefore: users.notBefore })
      .from(users)
      .where(eq(users.subject, 'sign-out-publish-failure'));
    expect(row?.notBefore).toBeInstanceOf(Date);
  });
});
