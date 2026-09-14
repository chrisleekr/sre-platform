import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, afterAll, expect } from 'vitest';
import { Redis } from 'ioredis';
import { PlatformSettings } from '@sre/platform-settings';
import {
  adminActions,
  identityProviders,
  impersonationSessions,
  makeDb,
  memberships,
  platformOperators,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { adminRoutes } from '..';
import { memberRoutes } from '../../onboarding/members';
import { meRoutes } from '../../onboarding/me';
import { makeTestAuth } from '../../__tests__/auth-test-support';
import type { AuthDeps } from '../../auth';
import { makeTestKeys, signTestIdentity } from './admin.acceptance.fixture';

export function ownershipFixture() {
  const tenantId = randomUUID(),
    otherTenantId = randomUUID(),
    actorId = randomUUID(),
    memberId = randomUUID(),
    peerId = randomUUID();
  const issuer = `https://ownership-api-${tenantId}.invalid`;
  let db: DbHandle, appDb: DbHandle, redis: Redis, api: Hono;
  let actorToken = '',
    memberToken = '',
    providerId = '';
  let auth: AuthDeps;
  beforeAll(async () => {
    expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
    db = makeDb(process.env.DATABASE_URL!);
    appDb = makeDb(process.env.APP_DATABASE_URL!);
    redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: 1 });
    await db.db.insert(tenants).values([
      { id: tenantId, name: 'Ownerless workspace', slug: `ownerless-${tenantId}` },
      { id: otherTenantId, name: 'Other workspace' },
    ]);
    await db.db.insert(users).values([
      { id: actorId, issuer, subject: 'operator', email: 'operator@example.test' },
      { id: memberId, issuer, subject: 'member', email: 'member@example.test' },
      { id: peerId, issuer, subject: 'peer', email: 'peer@example.test' },
    ]);
    await db.db.insert(memberships).values([
      { tenantId, userId: memberId, role: 'member' },
      { tenantId, userId: peerId, role: 'member' },
    ]);
    await db.db.insert(platformOperators).values({ userId: actorId });
    const keys = await makeTestKeys('ownership');
    auth = await makeTestAuth({
      adminDb: db.db,
      appDb: appDb.db,
      issuer,
      audience: 'sre-api',
      keys: keys.keys,
      bindings: [{ tenantId, subject: 'member' }],
    });
    const [provider] = await db.db
      .select({ id: identityProviders.id })
      .from(identityProviders)
      .where(eq(identityProviders.issuer, issuer));
    providerId = provider!.id;
    const sign = (subject: string) =>
      signTestIdentity({
        subject,
        issuer,
        audience: 'sre-api',
        privateKey: keys.privateKey,
        kid: 'ownership',
        issuedAt: Math.floor(Date.now() / 1000),
        email: `${subject}@example.test`,
        organisation: 'unused',
      });
    [actorToken, memberToken] = await Promise.all([sign('operator'), sign('member')]);
    api = new Hono();
    api.route(
      '/admin',
      adminRoutes({
        auth,
        appDb: appDb.db,
        controlDb: db.db,
        settings: new PlatformSettings(db.db, redis),
      }),
    );
    api.route('/', memberRoutes({ auth, db: appDb.db }));
    api.route('/', meRoutes({ auth, db: appDb.db }));
  });
  afterAll(async () => {
    if (!db) return;
    await db.db.delete(adminActions).where(eq(adminActions.actorUserId, actorId));
    await db.db.delete(impersonationSessions).where(eq(impersonationSessions.actorUserId, actorId));
    await db.db
      .delete(platformOperators)
      .where(inArray(platformOperators.userId, [actorId, memberId, peerId]));
    await db.db.delete(memberships).where(inArray(memberships.tenantId, [tenantId, otherTenantId]));
    await db.db
      .delete(tenantIdentityBindings)
      .where(eq(tenantIdentityBindings.providerId, providerId));
    await db.db.delete(users).where(eq(users.issuer, issuer));
    await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
    await db.db.delete(tenants).where(inArray(tenants.id, [tenantId, otherTenantId]));
    redis.disconnect();
    await Promise.all([db.close(), appDb.close()]);
  });
  return {
    allowLocal(value: boolean) {
      auth.allowLocalPlatformAdmin = value;
    },
    tenantId,
    otherTenantId,
    actorId,
    memberId,
    peerId,
    get db() {
      return db;
    },
    get appDb() {
      return appDb;
    },
    get api() {
      return api;
    },
    get actorToken() {
      return actorToken;
    },
    get memberToken() {
      return memberToken;
    },
    get providerId() {
      return providerId;
    },
    async reset() {
      auth.allowLocalPlatformAdmin = false;
      await db.db
        .update(users)
        .set({ status: 'active', notBefore: null })
        .where(inArray(users.id, [actorId, memberId, peerId]));
      await db.db
        .update(identityProviders)
        .set({ status: 'active', scope: 'installation', kind: 'oidc' })
        .where(eq(identityProviders.id, providerId));
      await db.db.insert(platformOperators).values({ userId: actorId }).onConflictDoNothing();
      await db.db.update(tenants).set({ status: 'active' }).where(eq(tenants.id, tenantId));
      await db.db
        .update(memberships)
        .set({ status: 'active', role: 'member' })
        .where(eq(memberships.tenantId, tenantId));
      await db.db.delete(adminActions).where(eq(adminActions.actorUserId, actorId));
    },
    request(
      path: string,
      body?: unknown,
      token = actorToken,
      headers: Record<string, string> = {},
    ) {
      return api.request(path, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    },
    async role(userId = memberId) {
      const [member] = await db.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
      return member?.role;
    },
  };
}
