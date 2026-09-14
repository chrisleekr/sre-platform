import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { Redis } from 'ioredis';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  identityProviderDomains,
  identityProviders,
  jobs,
  makeDb,
  memberships,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { makeFoundingQueue } from '@sre/queue';
import type { AuthDeps, AuthVariables } from '../../auth';
import { authDiscoveryRoutes } from '../auth-discover';
import { memberRoutes } from '../members';
import { tenantSettingsRoutes } from '../tenant-settings';
import { permissivePublicMetering } from './public-discovery-metering';

const marker = randomUUID();
const tenantId = randomUUID();
const providerId = randomUUID();
const foreignTenantId = randomUUID();
const invalidProviderIds = {
  installation: randomUUID(),
  foreign: randomUUID(),
  local: randomUUID(),
  missingClient: randomUUID(),
};
const issuer = `https://settings-${marker}.invalid`;
const audience = 'sre-api';
const slug = `settings-${marker}`;
const identities = {
  owner: { id: randomUUID(), subject: 'owner' },
  admin: { id: randomUUID(), subject: 'admin' },
  member: { id: randomUUID(), subject: 'member' },
};
let admin: DbHandle;
let appDb: DbHandle;
let redis: Redis;
let privateKey: CryptoKey;
let api: Hono<{ Variables: AuthVariables }>;
const publish = vi.fn(async () => undefined);
const invalidate = vi.fn();

function sign(subject: string) {
  return new SignJWT({ sub: subject, email: `${subject}@example.test`, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'workspace-settings' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  appDb = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { db: 13, maxRetriesPerRequest: null });
  const keyPair = await generateKeyPair('RS256', { extractable: true });
  privateKey = keyPair.privateKey;
  const jwk = await exportJWK(keyPair.publicKey);
  jwk.kid = 'workspace-settings';
  jwk.alg = 'RS256';
  const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
  await admin.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Primary directory',
    issuer,
    jwksUri: `${issuer}/jwks`,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    browserClientId: 'primary-client',
    audience,
    kind: 'oidc',
    scope: 'tenant',
    status: 'active',
  });
  await admin.db.insert(identityProviders).values([
    {
      id: invalidProviderIds.installation,
      displayName: 'Installation directory',
      issuer: `https://installation-${marker}.invalid`,
      jwksUri: `https://installation-${marker}.invalid/jwks`,
      browserClientId: 'installation-client',
      kind: 'oidc',
      scope: 'installation',
      status: 'disabled',
    },
    {
      id: invalidProviderIds.foreign,
      displayName: 'Foreign directory',
      issuer: `https://foreign-${marker}.invalid`,
      jwksUri: `https://foreign-${marker}.invalid/jwks`,
      browserClientId: 'foreign-client',
      kind: 'oidc',
      scope: 'tenant',
      status: 'disabled',
    },
    {
      id: invalidProviderIds.local,
      displayName: 'Local method',
      issuer: `urn:local:${marker}`,
      jwksUri: `urn:local-jwks:${marker}`,
      browserClientId: 'local-client',
      kind: 'local',
      scope: 'tenant',
      status: 'disabled',
    },
    {
      id: invalidProviderIds.missingClient,
      displayName: 'Incomplete directory',
      issuer: `https://incomplete-${marker}.invalid`,
      jwksUri: `https://incomplete-${marker}.invalid/jwks`,
      browserClientId: null,
      kind: 'oidc',
      scope: 'tenant',
      status: 'disabled',
    },
  ]);
  await admin.db.insert(tenants).values([
    { id: tenantId, name: 'Settings workspace', slug },
    { id: foreignTenantId, name: 'Foreign workspace', slug: `foreign-${marker}` },
  ]);
  await admin.db.insert(identityProviderDomains).values({
    providerId,
    domain: 'example.test',
    status: 'verified',
  });
  await admin.db.insert(tenantIdentityBindings).values({ tenantId, providerId, claimValue: null });
  await admin.db.insert(tenantIdentityBindings).values({
    tenantId: foreignTenantId,
    providerId: invalidProviderIds.foreign,
    claimValue: null,
  });
  await admin.db.insert(users).values(
    Object.values(identities).map((identity) => ({
      id: identity.id,
      issuer,
      subject: identity.subject,
      email: `${identity.subject}@example.test`,
    })),
  );
  await admin.db.insert(memberships).values([
    { tenantId, userId: identities.owner.id, role: 'owner' },
    { tenantId, userId: identities.admin.id, role: 'admin' },
    { tenantId, userId: identities.member.id, role: 'member' },
  ]);
  const auth: AuthDeps = {
    verifiers: {
      byIssuer: async (value) =>
        value === issuer
          ? {
              providerId,
              issuer,
              audience,
              keys,
              emailClaim: 'email',
              subjectClaim: 'sub',
              tenantClaim: null,
              scope: 'tenant',
            }
          : undefined,
      forFounding: async () => undefined,
      invalidate,
    },
    db: appDb.db,
    adminDb: admin.db,
    settings: { get: async () => 86_400 },
    revoke: { publish },
  };
  const queue = makeFoundingQueue(admin.db, redis);
  api = new Hono<{ Variables: AuthVariables }>();
  api.route('/', memberRoutes({ auth, db: admin.db }));
  api.route(
    '/',
    tenantSettingsRoutes({
      auth,
      db: admin.db,
      queue,
      discover: async (value) => ({
        issuer: value,
        authorizationEndpoint: `${value}/authorize`,
        tokenEndpoint: `${value}/token`,
        jwksUri: `${value}/jwks`,
      }),
      checkDomain: async () => ({ status: 'pending' }),
    }),
  );
  api.route('/', authDiscoveryRoutes({ db: admin.db, ...permissivePublicMetering }));
}, 30_000);

afterAll(async () => {
  if (!admin) return;
  await admin.db.delete(jobs).where(sql`${jobs.payload}->>'tenantId' = ${tenantId}`);
  await admin.db.delete(tenants).where(inArray(tenants.id, [tenantId, foreignTenantId]));
  await admin.db.delete(users).where(
    inArray(
      users.id,
      Object.values(identities).map(({ id }) => id),
    ),
  );
  await admin.db
    .delete(identityProviders)
    .where(inArray(identityProviders.id, [providerId, ...Object.values(invalidProviderIds)]));
  await admin.db
    .delete(identityProviders)
    .where(eq(identityProviders.issuer, `https://second-${marker}.invalid`));
  await redis.del('sre:founding', 'sre:founding:dead');
  redis.disconnect();
  await Promise.all([admin.close(), appDb.close()]);
});

function request(path: string, token: string, method = 'GET', body?: unknown) {
  return api.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('workspace settings API', () => {
  test('enforces roles, immutable address, method safety, domains, and delayed deletion', async () => {
    const owner = await sign(identities.owner.subject);
    const adminToken = await sign(identities.admin.subject);
    const member = await sign(identities.member.subject);
    expect((await request('/tenant/settings', member)).status).toBe(200);
    expect((await request('/tenant/settings', member, 'PUT', { name: 'Forbidden' })).status).toBe(
      403,
    );
    expect(
      (await request('/tenant/settings', adminToken, 'PUT', { name: 'Renamed workspace' })).status,
    ).toBe(200);
    expect(
      (await request('/tenant/settings', owner, 'PUT', { name: 'Ignored', slug: 'changed' }))
        .status,
    ).toBe(422);
    expect(
      await admin.db
        .select({ name: tenants.name, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, tenantId)),
    ).toEqual([{ name: 'Renamed workspace', slug }]);
    expect(await (await request('/tenant/settings', owner)).json()).toMatchObject({
      methods: [{ id: providerId, backchannelLogout: false }],
    });
    expect(
      (
        await request(`/tenant/providers/${providerId}/backchannel-logout`, member, 'PUT', {
          enabled: true,
          typRequired: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/tenant/providers/${providerId}/backchannel-logout`, owner, 'PUT', {
          enabled: true,
          typRequired: true,
        })
      ).status,
    ).toBe(200);
    expect(
      await admin.db
        .select({
          backchannelLogout: identityProviders.backchannelLogout,
          typRequired: identityProviders.backchannelLogoutTypRequired,
        })
        .from(identityProviders)
        .where(eq(identityProviders.id, providerId)),
    ).toEqual([{ backchannelLogout: true, typRequired: true }]);
    expect(invalidate).toHaveBeenCalled();

    const secondIssuer = `https://second-${marker}.invalid`;
    const created = await request('/tenant/providers', owner, 'POST', {
      displayName: 'Second directory',
      issuer: secondIssuer,
      clientId: 'second-client',
      apiAudience: 'second-api',
      subjectClaim: 'sub',
      authorizationScopes: ['read:workspace', 'offline_access'],
      authorizationAudience: 'second-api',
      sortOrder: 10,
      domain: 'second.example.test',
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      method: { id: string; status: string };
      domain: { id: string; status: string };
    };
    expect(createdBody.method.status).toBe('pending_verification');
    expect(createdBody.method).toMatchObject({
      authorizationScopes: ['read:workspace', 'offline_access'],
      authorizationAudience: 'second-api',
    });
    expect(createdBody.domain.status).toBe('pending');
    expect(
      (
        await request('/tenant/providers/order', owner, 'PUT', {
          providerIds: [createdBody.method.id, providerId],
        })
      ).status,
    ).toBe(200);
    expect(
      await admin.db
        .select({
          providerId: tenantIdentityBindings.providerId,
          sortOrder: tenantIdentityBindings.sortOrder,
        })
        .from(tenantIdentityBindings)
        .where(eq(tenantIdentityBindings.tenantId, tenantId))
        .orderBy(tenantIdentityBindings.sortOrder),
    ).toEqual([
      { providerId: createdBody.method.id, sortOrder: 0 },
      { providerId, sortOrder: 10 },
    ]);
    expect(
      (
        await request('/tenant/providers/order', owner, 'PUT', {
          providerIds: [providerId],
        })
      ).status,
    ).toBe(409);
    const publicMethods = await api.request(`/workspaces/${slug}/sign-in-methods`);
    expect(((await publicMethods.json()) as { methods: unknown[] }).methods).toHaveLength(1);
    expect((await request(`/tenant/providers/${providerId}/disable`, owner, 'POST')).status).toBe(
      409,
    );

    await admin.db
      .update(identityProviderDomains)
      .set({ status: 'verified' })
      .where(eq(identityProviderDomains.id, createdBody.domain.id));
    await admin.db
      .update(identityProviders)
      .set({ status: 'active' })
      .where(eq(identityProviders.id, createdBody.method.id));
    const ownMethod = await request(`/tenant/providers/${providerId}/disable`, owner, 'POST');
    expect(ownMethod.status).toBe(409);
    expect(await ownMethod.json()).toMatchObject({ code: 'current_method' });
    const inUse = await request(`/tenant/providers/${providerId}`, owner, 'DELETE');
    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toMatchObject({ code: 'method_in_use', count: 3 });
    expect(
      (await request(`/tenant/providers/${createdBody.method.id}/disable`, owner, 'POST')).status,
    ).toBe(200);
    expect(
      (await request(`/tenant/providers/${createdBody.method.id}/enable`, owner, 'POST')).status,
    ).toBe(200);
    publish.mockClear();
    expect(
      (await request('/tenant/settings/require-directory', owner, 'PUT', { enabled: true })).status,
    ).toBe(200);
    expect(publish).toHaveBeenCalledTimes(3);
    publish.mockClear();

    expect((await request('/tenant/delete', owner, 'POST', { confirmSlug: 'wrong' })).status).toBe(
      422,
    );
    const deletion = await request('/tenant/delete', owner, 'POST', { confirmSlug: slug });
    expect(deletion.status).toBe(200);
    const [scheduled] = await admin.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.type, 'tenant.purge'),
          eq(jobs.tenantId, '00000000-0000-0000-0000-000000000000'),
          sql`${jobs.payload}->>'tenantId' = ${tenantId}`,
        ),
      );
    expect(scheduled).toMatchObject({
      status: 'queued',
      streamId: null,
      idempotencyKey: `tenant.purge:${tenantId}`,
    });
    expect(scheduled!.availableAt.getTime() - Date.now()).toBeGreaterThan(13 * 86_400_000);
    expect(publish).toHaveBeenCalledTimes(3);
    const blocked = await request('/tenant/settings', owner);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ state: 'deleting' });
    const deletionDetails = await request('/tenant/deletion', owner);
    expect(deletionDetails.status).toBe(200);
    expect(await deletionDetails.json()).toMatchObject({
      workspaces: [{ slug, role: 'owner', deleteAfter: expect.any(String) }],
    });

    const cancelled = await request('/tenant/cancel-deletion', owner, 'POST', {
      confirmSlug: slug,
    });
    expect(cancelled.status).toBe(200);
    expect(
      await admin.db
        .select({ status: tenants.status, deleteAfter: tenants.deleteAfter })
        .from(tenants)
        .where(eq(tenants.id, tenantId)),
    ).toEqual([{ status: 'active', deleteAfter: null }]);
    expect(
      await admin.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, scheduled!.id)),
    ).toEqual([{ status: 'done' }]);

    expect(
      (await request('/tenant/settings/require-directory', owner, 'PUT', { enabled: false }))
        .status,
    ).toBe(200);
    await admin.db
      .update(identityProviders)
      .set({ scope: 'installation' })
      .where(eq(identityProviders.id, providerId));
    const installationMutation = await request(`/tenant/providers/${providerId}`, owner, 'PUT', {
      displayName: 'Not allowed',
      sortOrder: 10,
    });
    expect(installationMutation.status).toBe(409);
    expect(await installationMutation.json()).toMatchObject({ code: 'invalid_state' });
    await admin.db
      .update(identityProviders)
      .set({ scope: 'tenant' })
      .where(eq(identityProviders.id, providerId));
  });

  test('rejects logout settings for methods outside the owned OIDC browser client', async () => {
    await admin.db.insert(tenantIdentityBindings).values(
      (['installation', 'local', 'missingClient'] as const).map((kind, sortOrder) => ({
        tenantId,
        providerId: invalidProviderIds[kind],
        claimValue: `${kind}-${marker}`,
        sortOrder: 100 + sortOrder,
      })),
    );
    const owner = await sign(identities.owner.subject);
    invalidate.mockClear();
    const attempts = [
      [invalidProviderIds.installation, 409],
      [invalidProviderIds.foreign, 404],
      [invalidProviderIds.local, 409],
      [invalidProviderIds.missingClient, 409],
    ] as const;

    for (const [id, status] of attempts) {
      expect(
        (
          await request(`/tenant/providers/${id}/backchannel-logout`, owner, 'PUT', {
            enabled: true,
            typRequired: true,
          })
        ).status,
      ).toBe(status);
    }
    expect(invalidate).not.toHaveBeenCalled();
    expect(
      await admin.db
        .select({
          id: identityProviders.id,
          enabled: identityProviders.backchannelLogout,
          typRequired: identityProviders.backchannelLogoutTypRequired,
        })
        .from(identityProviders)
        .where(inArray(identityProviders.id, Object.values(invalidProviderIds))),
    ).toEqual(
      expect.arrayContaining(
        Object.values(invalidProviderIds).map((id) => ({ id, enabled: false, typRequired: false })),
      ),
    );
  });
});
