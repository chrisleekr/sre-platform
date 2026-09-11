import { seedMembership } from '@sre/db/test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import {
  makeDb,
  makeSecretStore,
  platformOperators,
  tenantIdentityBindings,
  tenants,
  users,
  memberships,
  type DbHandle,
} from '@sre/db';
import { makeApp } from '../app';
import { requirePlatformAdmin, requireUser, type AuthDeps, type AuthVariables } from '../auth';
import { makeTestAuth } from './auth-test-support';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const ISSUER = 'https://test.auth0.local/';
const AUDIENCE = 'sre-api';
const KID = 'test-key';
const KEY = Buffer.alloc(32, 5).toString('base64');

// A member of the tenant, and an authenticated non-member (valid token, no membership assigned).
const MEMBER_SUB = 'auth0|member';
const STRANGER_SUB = 'auth0|stranger';
const UNLISTED_SUB = 'auth0|unlisted';
// Members used to pin email-claim extraction (namespaced claim, fallback, precedence).
const MEMBER_SUB_CLAIM = 'auth0|member-claim';
const MEMBER_SUB2 = 'auth0|member-top';
const MEMBER_SUB_BOTH = 'auth0|member-both';
const MEMBER_SUB_UNVERIFIED = 'auth0|member-unverified';
const MEMBER_SUB_EMPTY = 'auth0|member-empty';
// Auth0 custom claims must be namespaced with a collision-free URI.
const EMAIL_CLAIM = 'https://sre-platform.chrislee.kr/email';

let admin: DbHandle;
let app: DbHandle;
let api: ReturnType<typeof makeApp>;
let auth: AuthDeps;
let privateKey: CryptoKey;
let tenantId: string;
let memberUserId: string;

function sign(claims: Record<string, unknown>, audience = AUDIENCE): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

/**
 * Mint a token deliberately missing one of the two standard time claims. A token with no `exp`
 * cannot say when it stops being valid, and a token with no `iat` cannot be aged, so both are refused.
 */
function signWithout(claims: Record<string, unknown>, omit: 'exp' | 'iat'): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE);
  if (omit !== 'iat') jwt.setIssuedAt();
  if (omit !== 'exp') jwt.setExpirationTime('5m');
  return jwt.sign(privateKey);
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);

  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const keys = createLocalJWKSet(jwks);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Test' });
  memberUserId = await seedMembership(admin.db, { issuer: ISSUER, subject: MEMBER_SUB }, tenantId);
  await seedMembership(admin.db, { issuer: ISSUER, subject: UNLISTED_SUB }, tenantId);
  await seedMembership(admin.db, { issuer: ISSUER, subject: MEMBER_SUB_CLAIM }, tenantId);
  await seedMembership(admin.db, { issuer: ISSUER, subject: MEMBER_SUB2 }, tenantId);
  await seedMembership(admin.db, { issuer: ISSUER, subject: MEMBER_SUB_BOTH }, tenantId);
  await seedMembership(admin.db, { issuer: ISSUER, subject: MEMBER_SUB_UNVERIFIED }, tenantId);
  await seedMembership(admin.db, { issuer: ISSUER, subject: MEMBER_SUB_EMPTY }, tenantId);
  auth = await makeTestAuth({
    adminDb: admin.db,
    appDb: app.db,
    issuer: ISSUER,
    audience: AUDIENCE,
    keys,
    emailClaim: EMAIL_CLAIM,
    bindings: [
      MEMBER_SUB,
      UNLISTED_SUB,
      MEMBER_SUB_CLAIM,
      MEMBER_SUB2,
      MEMBER_SUB_BOTH,
      MEMBER_SUB_UNVERIFIED,
      MEMBER_SUB_EMPTY,
    ].map((subject) => ({ tenantId, subject })),
  });
  api = makeApp({
    auth,
    readinessDb: app.db,
    appDb: app.db,
    secrets: makeSecretStore(app.db, KEY),
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
  });
}, 30_000);

async function storedEmail(subject: string): Promise<string | null | undefined> {
  const rows = await admin.db
    .select({ email: users.email })
    .from(users)
    .where(sql`issuer = ${ISSUER} and subject = ${subject}`);
  return rows[0]?.email;
}

afterAll(async () => {
  if (admin) {
    if (tenantId) {
      await admin.db.delete(memberships).where(sql`tenant_id = ${tenantId}`);
      await admin.db.delete(tenantIdentityBindings).where(sql`tenant_id = ${tenantId}`);
      await admin.db
        .delete(users)
        .where(
          sql`issuer = ${ISSUER} and subject in (${MEMBER_SUB}, ${STRANGER_SUB}, ${UNLISTED_SUB}, ${MEMBER_SUB_CLAIM}, ${MEMBER_SUB2}, ${MEMBER_SUB_BOTH}, ${MEMBER_SUB_UNVERIFIED}, ${MEMBER_SUB_EMPTY})`,
        );
      await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    }
    await admin.close();
  }
  if (app) await app.close();
});

describe('API auth + tenant resolution', () => {
  test('healthz is open', async () => {
    expect((await api.request('/healthz')).status).toBe(200);
  });

  test('readyz pings the database', async () => {
    const res = await api.request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });
  });

  test('rejects a missing token', async () => {
    expect((await api.request('/me')).status).toBe(401);
  });

  test('rejects a token with the wrong audience', async () => {
    const t = await sign({ sub: MEMBER_SUB }, 'wrong-audience');
    const res = await api.request('/me', { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
  });

  test('resolves (issuer, sub) to the internal tenant via membership', async () => {
    const t = await sign({ sub: MEMBER_SUB });
    const res = await api.request('/me', { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: 'active',
      user: { id: memberUserId },
      tenant: { id: tenantId, role: 'member', founderOnly: false },
      workspaces: [{ id: tenantId, role: 'member' }],
    });
  });

  test('rejects a token carrying no exp claim', async () => {
    const t = await signWithout({ sub: MEMBER_SUB }, 'exp');
    const res = await api.request('/me', { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'token missing exp or iat' });
  });

  test('rejects a token carrying no iat claim', async () => {
    const t = await signWithout({ sub: MEMBER_SUB }, 'iat');
    const res = await api.request('/me', { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'token missing exp or iat' });
  });

  test('extracts email from the namespaced Auth0 claim when no top-level email', async () => {
    const t = await sign({ sub: MEMBER_SUB_CLAIM, [EMAIL_CLAIM]: 'claim@x.io' });
    const res = await api.request('/me', { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    expect(await storedEmail(MEMBER_SUB_CLAIM)).toBe('claim@x.io');
  });

  test('falls back to the verified top-level email claim when the namespaced claim is absent', async () => {
    const t = await sign({ sub: MEMBER_SUB2, email: 'top@x.io', email_verified: true });
    const res = await api.request('/me', { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    expect(await storedEmail(MEMBER_SUB2)).toBe('top@x.io');
  });

  test('namespaced email claim wins over the top-level email when both are present', async () => {
    const t = await sign({ sub: MEMBER_SUB_BOTH, email: 'top@x.io', [EMAIL_CLAIM]: 'claim@x.io' });
    const res = await api.request('/me', { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    expect(await storedEmail(MEMBER_SUB_BOTH)).toBe('claim@x.io');
  });

  test('ignores an unverified top-level email claim (no email_verified)', async () => {
    const t = await sign({ sub: MEMBER_SUB_UNVERIFIED, email: 'unverified@x.io' });
    const res = await api.request('/me', { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    // Unverified email is an unsafe attribution key; it must never reach the DB.
    expect(await storedEmail(MEMBER_SUB_UNVERIFIED)).toBeNull();
  });

  test('an empty-string namespaced claim does not clobber a previously stored email', async () => {
    const first = await sign({
      sub: MEMBER_SUB_EMPTY,
      [EMAIL_CLAIM]: 'real@x.io',
    });
    expect(
      (await api.request('/me', { headers: { authorization: `Bearer ${first}` } })).status,
    ).toBe(200);
    expect(await storedEmail(MEMBER_SUB_EMPTY)).toBe('real@x.io');

    const second = await sign({ sub: MEMBER_SUB_EMPTY, [EMAIL_CLAIM]: '' });
    expect(
      (await api.request('/me', { headers: { authorization: `Bearer ${second}` } })).status,
    ).toBe(200);
    // Empty string is treated as absent, so no-clobber keeps the real address.
    expect(await storedEmail(MEMBER_SUB_EMPTY)).toBe('real@x.io');
  });

  test('a valid token with no membership is JIT-provisioned and reported as unaffiliated', async () => {
    const t = await sign({ sub: STRANGER_SUB });
    const res = await api.request('/me', { headers: { authorization: `Bearer ${t}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'unaffiliated', tenant: null });
    // JIT created the user row even though access was denied.
    const row = await admin.db
      .select({ id: users.id })
      .from(users)
      .where(sql`issuer = ${ISSUER} and subject = ${STRANGER_SUB}`);
    expect(row).toHaveLength(1);
  });
});

describe('requirePlatformAdmin composition', () => {
  function testRoute() {
    let runs = 0;
    const guarded = new Hono<{ Variables: AuthVariables }>();
    guarded.get(
      '/operator',
      requireUser(auth),
      async (c, next) => {
        if (c.req.header('x-test-missing-user-id') === '1') {
          c.set('user', { ...c.get('user'), userId: '' });
        }
        await next();
      },
      requirePlatformAdmin(auth),
      (c) => {
        runs++;
        return c.json({ ok: true });
      },
    );
    return { guarded, runs: () => runs };
  }

  test('allows a listed authenticated tenant member', async () => {
    await admin.db.insert(platformOperators).values({ userId: memberUserId });
    try {
      const route = testRoute();
      const token = await sign({ sub: MEMBER_SUB });
      const res = await route.guarded.request('/operator', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(route.runs()).toBe(1);
    } finally {
      await admin.db.delete(platformOperators).where(sql`user_id = ${memberUserId}`);
    }
  });

  test('forbids an unlisted member and a context without userId without running the route', async () => {
    const route = testRoute();
    const unlisted = await sign({ sub: UNLISTED_SUB });
    const unlistedRes = await route.guarded.request('/operator', {
      headers: { authorization: `Bearer ${unlisted}` },
    });
    expect(unlistedRes.status).toBe(403);
    expect(await unlistedRes.json()).toEqual({ error: 'forbidden' });

    const listed = await sign({ sub: MEMBER_SUB });
    const missingIdRes = await route.guarded.request('/operator', {
      headers: { authorization: `Bearer ${listed}`, 'x-test-missing-user-id': '1' },
    });
    expect(missingIdRes.status).toBe(403);
    expect(await missingIdRes.json()).toEqual({ error: 'forbidden' });
    expect(route.runs()).toBe(0);
  });

  test('runs authentication before operator authorization', async () => {
    const route = testRoute();
    const res = await route.guarded.request('/operator');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing token' });
    expect(route.runs()).toBe(0);
  });
});
