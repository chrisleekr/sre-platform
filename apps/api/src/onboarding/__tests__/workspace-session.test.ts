import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  browserSessions,
  browserCredentialHash,
  applyBackchannelLogout,
  selectBrowserSessionWorkspace,
  createBrowserSession,
  getUserTenantSessionState,
  identityProviders,
  makeDb,
  makePlatformSecretStore,
  memberships,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { requireUser, requireTenant, type AuthDeps, type AuthVariables } from '../../auth';
import { makeProviderVerifiers } from '../../auth/providers';
import { browserSessionRoutes } from '../browser-session-routes';
import { makeBrowserSessionRuntime } from '../browser-session-runtime';
import { meRoutes } from '../me';

const userId = randomUUID();
const providerId = randomUUID();
const tenantId = randomUUID();
const otherTenant = randomUUID();
const issuer = `https://${providerId}.example.test`;
const origin = 'http://dashboard.example.test';
const publish = vi.fn(async () => undefined);
let db: DbHandle;
let app: Hono<{ Variables: AuthVariables }>;
const sessions = new Map<string, Awaited<ReturnType<typeof createBrowserSession>>>();

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(identityProviders).values({
    id: providerId,
    issuer,
    jwksUri: `${issuer}/jwks`,
    kind: 'oidc',
    scope: 'installation',
    status: 'active',
    displayName: 'Company account',
    browserClientId: 'browser',
    authorizationEndpoint: `${issuer}/authorize`,
  });
  await db.db
    .insert(users)
    .values({ id: userId, issuer, subject: 'member', email: 'member@example.test' });
  await db.db
    .insert(tenants)
    .values([tenantId, otherTenant].map((id) => ({ id, name: id, slug: id })));
  await db.db.insert(memberships).values({ userId, tenantId, role: 'member' });
  const auth: AuthDeps = {
    db: db.db,
    adminDb: db.db,
    verifiers: makeProviderVerifiers(db.db),
    settings: { get: async () => 86_400 },
    revoke: { publish },
  };
  const runtime = makeBrowserSessionRuntime({
    db: db.db,
    auth,
    secrets: makePlatformSecretStore(db.db, randomBytes(32).toString('base64')),
    dashboardUrl: origin,
    production: false,
    setting: async () => 3_600,
    email: async () => null,
  });
  auth.browserSession = runtime.resolve;
  app = new Hono<{ Variables: AuthVariables }>()
    .route(
      '/',
      browserSessionRoutes(runtime, { allow: async () => true }, () => '127.0.0.1'),
    )
    .route('/', meRoutes({ auth, db: db.db }))
    .get('/protected', requireUser(auth), requireTenant(), (c) => c.json(c.get('tenant')));
});
afterAll(async () => {
  if (!db) return;
  await db.db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.db.delete(tenants).where(eq(tenants.id, otherTenant));
  await db.db.delete(users).where(eq(users.id, userId));
  await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await db.close();
});

async function session(claimValue: string | null = null) {
  const created = await createBrowserSession(db.db, {
    providerId,
    userId,
    clientId: 'browser',
    foundingId: null,
    oidcSubject: 'member',
    bindingClaimValue: claimValue,
    authenticatedAt: new Date(),
    idleSeconds: 3_600,
    absoluteSeconds: 86_400,
  });
  sessions.set(created.credential, created);
  return created;
}
async function request(credential: string, path: string, body?: unknown, headers = {}) {
  const response = await app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      'x-sre-session': '1',
      'content-type': 'application/json',
      cookie: `sre-session=${credential}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const entry = sessions.get(credential);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('sre-session='));
  if (entry && cookie) {
    const next = cookie.split(';')[0]!.slice('sre-session='.length);
    const [stored] = await db.db
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.credentialHash, browserCredentialHash(next)));
    if (stored) {
      entry.credential = next;
      entry.session = stored;
      sessions.set(next, entry);
    }
  }
  return response;
}
const membershipWhere = and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId));

describe('membership-based browser workspace selection', () => {
  test('OIDC session logout revokes a successor created by a concurrent workspace switch', async () => {
    const s = await session();
    const sid = randomUUID();
    await db.db
      .update(browserSessions)
      .set({ oidcSessionId: sid })
      .where(eq(browserSessions.id, s.session.id));
    const rotationName = `rotation-${sid}`;
    const logoutName = `logout-${sid}`;
    const logoutUrl = new URL(process.env.DATABASE_URL!);
    logoutUrl.searchParams.set('application_name', logoutName);
    const logoutDb = makeDb(logoutUrl.toString());
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const holder = db.db.transaction(async (tx) => {
      await tx
        .select()
        .from(browserSessions)
        .where(eq(browserSessions.id, s.session.id))
        .for('update');
      locked();
      await release;
    });
    await ready;
    const rotation = db.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('application_name', ${rotationName}, true)`);
      return selectBrowserSessionWorkspace(tx, s.session.id, tenantId);
    });
    let logout: ReturnType<typeof applyBackchannelLogout> | undefined;
    try {
      await vi.waitFor(async () => {
        const rows =
          await db.sql`select pid from pg_stat_activity where application_name = ${rotationName} and wait_event_type = 'Lock'`;
        expect(rows.length).toBe(1);
      });
      logout = applyBackchannelLogout(logoutDb.db, {
        providerId,
        clientId: 'browser',
        jtiHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
        target: { kind: 'session', oidcSessionId: sid },
      });
      await vi.waitFor(async () => {
        const rows =
          await db.sql`select pid from pg_stat_activity where application_name = ${logoutName} and wait_event_type = 'Lock' and query like '%pg_advisory_xact_lock%'`;
        expect(rows.length).toBe(1);
      });
      unlock();
      const successor = await rotation;
      expect(successor).not.toBeNull();
      expect((await logout).sessions.map((row) => row.id)).toContain(successor!.session.id);
      expect((await request(successor!.credential, '/protected')).status).toBe(401);
      expect(
        (await getUserTenantSessionState(
          db.db,
          userId,
          tenantId,
          providerId,
          successor!.session.id,
        ))!.sessionEligible,
      ).toBe(false);
    } finally {
      unlock();
      await Promise.allSettled([holder, rotation, ...(logout ? [logout] : [])]);
      await logoutDb.close();
    }
  });
  test('opens an existing membership without a provider binding and preserves session deadlines', async () => {
    const s = await session();
    const previousSessionId = s.session.id;
    const authenticatedAt = s.session.authenticatedAt;
    const absoluteExpiresAt = s.session.absoluteExpiresAt;
    const me = (await (await request(s.credential, '/me')).json()) as {
      state: string;
      workspaces: unknown[];
    };
    expect(me.state).toBe('unaffiliated');
    expect(me.workspaces[0]).toMatchObject({
      id: tenantId,
      canSelect: true,
      signInAvailable: false,
    });
    expect((await request(s.credential, '/auth/browser/workspace', { tenantId })).status).toBe(200);
    expect(await (await request(s.credential, '/protected')).json()).toMatchObject({
      tenantId,
      role: 'member',
      userId,
    });
    expect(publish).toHaveBeenCalledWith({ userId, applicationSessionId: previousSessionId });
    expect(s.session.id).not.toBe(previousSessionId);
    expect(
      (
        await request(s.credential, '/protected', undefined, {
          'x-sre-session-id': previousSessionId,
        })
      ).status,
    ).toBe(401);
    const [stored] = await db.db
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, s.session.id));
    expect(stored!.authenticatedAt).toEqual(authenticatedAt);
    expect(stored!.absoluteExpiresAt).toEqual(absoluteExpiresAt);
    expect(
      await getUserTenantSessionState(db.db, userId, tenantId, providerId, s.session.id),
    ).toMatchObject({ providerEligible: true, sessionEligible: true });
  });

  test('rejects missing membership, malformed input and cross-site selection', async () => {
    const s = await session();
    expect(
      (await request(s.credential, '/auth/browser/workspace', { tenantId: otherTenant })).status,
    ).toBe(403);
    expect(
      (await request(s.credential, '/auth/browser/workspace', { tenantId: 'invalid' })).status,
    ).toBe(400);
    expect(
      (
        await request(
          s.credential,
          '/auth/browser/workspace',
          { tenantId },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect((await request('', '/auth/browser/workspace', { tenantId })).status).toBe(401);
    expect((await request(s.credential, '/protected')).status).toBe(403);
  });

  test.each([
    'removed',
    'suspended',
    'deleting',
    'directory_required',
    'provider_disabled',
    'user_disabled',
    'revoked',
  ])('rechecks %s after selection for HTTP and durable sockets', async (gate) => {
    const s = await session();
    expect((await request(s.credential, '/auth/browser/workspace', { tenantId })).status).toBe(200);
    try {
      if (gate === 'removed')
        await db.db.update(memberships).set({ status: 'removed' }).where(membershipWhere);
      if (gate === 'suspended' || gate === 'deleting')
        await db.db.update(tenants).set({ status: gate }).where(eq(tenants.id, tenantId));
      if (gate === 'directory_required')
        await db.db.update(tenants).set({ requireDirectory: true }).where(eq(tenants.id, tenantId));
      if (gate === 'provider_disabled')
        await db.db
          .update(identityProviders)
          .set({ status: 'disabled' })
          .where(eq(identityProviders.id, providerId));
      if (gate === 'user_disabled')
        await db.db.update(users).set({ status: 'disabled' }).where(eq(users.id, userId));
      if (gate === 'revoked')
        await db.db
          .update(browserSessions)
          .set({ revokedAt: new Date() })
          .where(eq(browserSessions.id, s.session.id));
      expect([401, 403]).toContain((await request(s.credential, '/protected')).status);
      expect([401, 403]).toContain(
        (await request(s.credential, '/auth/browser/workspace', { tenantId })).status,
      );
      const state = await getUserTenantSessionState(
        db.db,
        userId,
        tenantId,
        providerId,
        s.session.id,
      );
      expect(
        state!.providerEligible &&
          state!.sessionEligible &&
          state!.membershipStatus === 'active' &&
          state!.tenantStatus === 'active' &&
          state!.userStatus === 'active',
      ).toBe(false);
    } finally {
      await db.db.update(memberships).set({ status: 'active' }).where(membershipWhere);
      await db.db
        .update(tenants)
        .set({ status: 'active', requireDirectory: false })
        .where(eq(tenants.id, tenantId));
      await db.db
        .update(identityProviders)
        .set({ status: 'active' })
        .where(eq(identityProviders.id, providerId));
      await db.db.update(users).set({ status: 'active' }).where(eq(users.id, userId));
    }
  });

  test('a company binding prevents installation fallback and requires its exact claim', async () => {
    const s = await session();
    await request(s.credential, '/auth/browser/workspace', { tenantId });
    await db.db
      .insert(tenantIdentityBindings)
      .values({ tenantId, providerId, claimValue: 'company' });
    await db.db
      .update(identityProviders)
      .set({ tenantClaim: 'organization' })
      .where(eq(identityProviders.id, providerId));
    try {
      expect((await request(s.credential, '/protected')).status).toBe(403);
      expect((await request(s.credential, '/auth/browser/workspace', { tenantId })).status).toBe(
        403,
      );
      const bound = await session('company');
      expect(
        (await request(bound.credential, '/auth/browser/workspace', { tenantId })).status,
      ).toBe(200);
      expect((await request(bound.credential, '/protected')).status).toBe(200);
    } finally {
      await db.db
        .delete(tenantIdentityBindings)
        .where(eq(tenantIdentityBindings.tenantId, tenantId));
      await db.db
        .update(identityProviders)
        .set({ tenantClaim: null })
        .where(eq(identityProviders.id, providerId));
    }
  });

  test('switching workspaces makes an old workspace socket ticket ineligible', async () => {
    const s = await session();
    await db.db.insert(memberships).values({ userId, tenantId: otherTenant, role: 'member' });
    try {
      await request(s.credential, '/auth/browser/workspace', { tenantId });
      expect(
        (await request(s.credential, '/auth/browser/workspace', { tenantId: otherTenant })).status,
      ).toBe(200);
      expect(await (await request(s.credential, '/protected')).json()).toMatchObject({
        tenantId: otherTenant,
      });
      expect(
        (await getUserTenantSessionState(db.db, userId, tenantId, providerId, s.session.id))!
          .sessionEligible,
      ).toBe(false);
    } finally {
      await db.db
        .delete(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, otherTenant)));
    }
  });
});
