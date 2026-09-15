import { registerInactiveLocalAuthCases } from './local-auth-inactive-cases';
import { seedMembership } from '@sre/db/test-support';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JSONWebKeySet,
} from 'jose';
import {
  identityProviders,
  makeDb,
  makeSecretStore,
  isPlatformOperator,
  memberships,
  platformOperators,
  tenantIdentityBindings,
  tenants,
  users,
  workspaceFoundings,
  type DbHandle,
} from '@sre/db';
import { makeApp } from '../app';
import { allowLocalAutoLogin } from '../local-development-auth';
import type { AuthDeps } from '../auth';
import { makeProviderVerifiers, type ProviderVerifiers } from '../auth/providers';
import {
  LOCAL_ISSUER,
  LOCAL_TOKEN_TTL_SECONDS,
  MIN_LOCAL_PASSWORD_LENGTH,
  armLocalLogin,
  localLoginCredentials,
  type LocalLogin,
} from '../local-auth';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const AUTH0_ISSUER = `https://test-${randomUUID()}.auth0.local/`;
const AUDIENCE = 'sre-api';
const AUTH0_KID = 'auth0-key';
const KEY = Buffer.alloc(32, 5).toString('base64');

const LOCAL_EMAIL = 'dev@example.test';
const LOCAL_PASSWORD = 'dev-password-1234';
/** A pre-seeded local identity, so C13/C14 pin verification+tenant resolution without touching C20's provisioning. */
const SEEDED_SUBJECT = 'seeded@example.test';
const TEST_SUBJECTS = [LOCAL_EMAIL, SEEDED_SUBJECT];

let admin: DbHandle;
let app: DbHandle;
let local: LocalLogin;
let armedApi: ReturnType<typeof makeApp>;
let disarmedApi: ReturnType<typeof makeApp>;
let auth0PrivateKey: CryptoKey;
let localPrivateKey: CryptoKey;
let seededTenantId: string;
let armedVerifiers: ProviderVerifiers;
let maxTokenLifetimeSec = 86_400;
/** Every tenant the API provisioned during the run, so afterAll drops exactly those and no others. */
const createdTenantIds = new Set<string>();

async function keySet(kid: string): Promise<{ privateKey: CryptoKey; keys: JSONWebKeySet }> {
  const kp = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { privateKey: kp.privateKey, keys: { keys: [jwk] } };
}

function signWith(
  key: CryptoKey,
  kid: string,
  claims: Record<string, unknown>,
  issuer: string,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

function login(api: ReturnType<typeof makeApp>, body: unknown) {
  return api.request('/auth/local/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function me(api: ReturnType<typeof makeApp>, token: string) {
  return api.request('/me', { headers: { authorization: `Bearer ${token}` } });
}

/** Memberships of the configured local identity, read on the admin connection (users/memberships carry no RLS). */
function localMemberships(subject: string): Promise<{ tenantId: string }[]> {
  return admin.db
    .select({ tenantId: memberships.tenantId })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(users.issuer, LOCAL_ISSUER), eq(users.subject, subject)));
}

/** Return the configured local identity to its never-logged-in state, remembering what to drop later. */
async function resetLocalIdentity(): Promise<void> {
  for (const row of await localMemberships(LOCAL_EMAIL)) createdTenantIds.add(row.tenantId);
  await admin.db
    .delete(workspaceFoundings)
    .where(
      sql`founder_user_id in (select id from users where issuer = ${LOCAL_ISSUER} and subject = ${LOCAL_EMAIL})`,
    );
  await admin.db
    .delete(platformOperators)
    .where(
      sql`user_id in (select id from users where issuer = ${LOCAL_ISSUER} and subject = ${LOCAL_EMAIL})`,
    );
  await admin.db
    .delete(memberships)
    .where(
      sql`user_id in (select id from users where issuer = ${LOCAL_ISSUER} and subject = ${LOCAL_EMAIL})`,
    );
  await admin.db
    .delete(tenantIdentityBindings)
    .where(sql`provider_id in (select id from identity_providers where issuer = ${LOCAL_ISSUER})`);
  await admin.db.delete(identityProviders).where(eq(identityProviders.issuer, LOCAL_ISSUER));
  await admin.db.delete(users).where(sql`issuer = ${LOCAL_ISSUER} and subject = ${LOCAL_EMAIL}`);
  for (const id of createdTenantIds) {
    if (id !== seededTenantId) await admin.db.delete(tenants).where(eq(tenants.id, id));
  }
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);

  const auth0 = await keySet(AUTH0_KID);
  auth0PrivateKey = auth0.privateKey;

  // Arming owns its own ephemeral keypair; the suite needs the private half to forge
  // cross-key-set tokens, so it mints a parallel pair and hands it to armLocalLogin.
  const localKeys = await keySet('local-key');
  localPrivateKey = localKeys.privateKey;
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    local = await armLocalLogin(
      { email: LOCAL_EMAIL, password: LOCAL_PASSWORD },
      { audience: AUDIENCE, privateKey: localKeys.privateKey, jwks: localKeys.keys },
    );
  } finally {
    warn.mockRestore();
  }

  const auth0Keys = createLocalJWKSet(auth0.keys);
  const sharedAuth = {
    db: app.db,
    adminDb: admin.db,
    settings: { get: async () => maxTokenLifetimeSec },
    revoke: { publish: async () => undefined },
  };
  const shared = {
    readinessDb: app.db,
    appDb: app.db,
    secrets: makeSecretStore(app.db, KEY),
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
  };

  armedVerifiers = makeProviderVerifiers(app.db, {
    local: { issuer: local.issuer, keys: local.keys },
  });
  armedApi = makeApp({
    ...shared,
    auth: {
      ...sharedAuth,
      verifiers: armedVerifiers,
    } satisfies AuthDeps,
    localAuth: {
      local,
      db: admin.db,
      invalidateProviderVerifiers: armedVerifiers.invalidate,
      maxTokenLifetimeSec: async () => maxTokenLifetimeSec,
      allowAutomaticSession: (c) => allowLocalAutoLogin(c, 'http://localhost:45173', '127.0.0.1'),
    },
  });
  // Disarmed: no `local` on the auth deps and no localAuth route deps at all.
  disarmedApi = makeApp({
    ...shared,
    auth: {
      ...sharedAuth,
      verifiers: {
        byIssuer: async (issuer) =>
          issuer === AUTH0_ISSUER
            ? {
                providerId: randomUUID(),
                issuer: AUTH0_ISSUER,
                audience: AUDIENCE,
                keys: auth0Keys,
                emailClaim: 'email',
                subjectClaim: 'sub',
                tenantClaim: null,
                scope: 'tenant',
              }
            : undefined,
        forFounding: async () => undefined,
        invalidate() {},
      },
    } satisfies AuthDeps,
  });

  seededTenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: seededTenantId, name: 'Local Seeded' });
  await seedMembership(admin.db, { issuer: LOCAL_ISSUER, subject: SEEDED_SUBJECT }, seededTenantId);
}, 30_000);

afterAll(async () => {
  if (admin) {
    for (const row of await localMemberships(LOCAL_EMAIL)) createdTenantIds.add(row.tenantId);
    const testUserIds = admin.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.issuer, LOCAL_ISSUER), inArray(users.subject, TEST_SUBJECTS)));
    await admin.db.delete(platformOperators).where(inArray(platformOperators.userId, testUserIds));
    await admin.db.delete(memberships).where(inArray(memberships.userId, testUserIds));
    await admin.db
      .delete(workspaceFoundings)
      .where(
        sql`founder_user_id in (select id from users where issuer = ${LOCAL_ISSUER} and subject in (${LOCAL_EMAIL}, ${SEEDED_SUBJECT}))`,
      );
    await admin.db
      .delete(tenantIdentityBindings)
      .where(
        sql`provider_id in (select id from identity_providers where issuer = ${LOCAL_ISSUER})`,
      );
    await admin.db.delete(identityProviders).where(eq(identityProviders.issuer, LOCAL_ISSUER));
    await admin.db
      .delete(users)
      .where(and(eq(users.issuer, LOCAL_ISSUER), inArray(users.subject, TEST_SUBJECTS)));
    if (seededTenantId) createdTenantIds.add(seededTenantId);
    for (const id of createdTenantIds) await admin.db.delete(tenants).where(sql`id = ${id}`);
    await admin.close();
  }
  if (app) await app.close();
});

// Pure decision, no live DB: the fail-closed truth table for arming a shared password credential.
// Mirrors shouldEnforceRuntimeRole's table (packages/db/src/__tests__/runtime-role.test.ts).
describe('localLoginCredentials (fail-closed env gate)', () => {
  const creds = { LOCAL_LOGIN_EMAIL: LOCAL_EMAIL, LOCAL_LOGIN_PASSWORD: LOCAL_PASSWORD };
  const armed = { ALLOW_LOCAL_PASSWORD_LOGIN: 'true', NODE_ENV: 'development', ...creds };

  test('C15: leaves local login disarmed when the flag is unset', () => {
    expect(localLoginCredentials({ NODE_ENV: 'development', ...creds })).toBeUndefined();
  });

  test('C15: ignores a non-exact flag value (fail-closed)', () => {
    expect(localLoginCredentials({ ...armed, ALLOW_LOCAL_PASSWORD_LOGIN: 'TRUE' })).toBeUndefined();
    expect(localLoginCredentials({ ...armed, ALLOW_LOCAL_PASSWORD_LOGIN: '1' })).toBeUndefined();
  });

  test('C15: arms on the exact string "true" outside production', () => {
    expect(localLoginCredentials(armed)).toEqual({
      email: LOCAL_EMAIL,
      password: LOCAL_PASSWORD,
    });
  });

  test('C16: refuses to boot when the flag is armed under NODE_ENV=production', () => {
    expect(() => localLoginCredentials({ ...armed, NODE_ENV: 'production' })).toThrow(/production/);
  });

  test('C17: refuses to arm when NODE_ENV is unset (fail-closed)', () => {
    const { NODE_ENV: _unset, ...noNodeEnv } = armed;
    expect(() => localLoginCredentials(noNodeEnv)).toThrow(/NODE_ENV/);
  });

  test('C19: refuses to boot when the email or password is missing', () => {
    const { LOCAL_LOGIN_EMAIL: _e, ...noEmail } = armed;
    expect(() => localLoginCredentials(noEmail)).toThrow(/LOCAL_LOGIN_EMAIL/);
    const { LOCAL_LOGIN_PASSWORD: _p, ...noPassword } = armed;
    expect(() => localLoginCredentials(noPassword)).toThrow(/LOCAL_LOGIN_PASSWORD/);
  });

  test('C19: refuses a password shorter than the enforced minimum', () => {
    // The plan fixes the floor at 12; pin the number so a later loosening is a test failure.
    expect(MIN_LOCAL_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
    expect(() =>
      localLoginCredentials({
        ...armed,
        LOCAL_LOGIN_PASSWORD: 'a'.repeat(MIN_LOCAL_PASSWORD_LENGTH - 1),
      }),
    ).toThrow(new RegExp(String(MIN_LOCAL_PASSWORD_LENGTH)));
    expect(
      localLoginCredentials({
        ...armed,
        LOCAL_LOGIN_PASSWORD: 'a'.repeat(MIN_LOCAL_PASSWORD_LENGTH),
      })?.password,
    ).toHaveLength(MIN_LOCAL_PASSWORD_LENGTH);
  });

  test('C18: arming emits a loud startup error naming the flag', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const keys = await keySet('loud-key');
      await armLocalLogin(
        { email: LOCAL_EMAIL, password: LOCAL_PASSWORD },
        { audience: AUDIENCE, privateKey: keys.privateKey, jwks: keys.keys },
      );
      expect(err).toHaveBeenCalled();
      const logged = err.mock.calls.flat().join(' ');
      expect(logged).toContain('ALLOW_LOCAL_PASSWORD_LOGIN');
    } finally {
      err.mockRestore();
    }
  });
});

describe('POST /auth/local/login', () => {
  test('a login invalidates a prewarmed provider snapshot before returning its token', async () => {
    await resetLocalIdentity();
    await admin.db
      .delete(tenantIdentityBindings)
      .where(
        sql`provider_id in (select id from identity_providers where issuer = ${LOCAL_ISSUER})`,
      );
    await admin.db.delete(identityProviders).where(eq(identityProviders.issuer, LOCAL_ISSUER));
    await expect(armedVerifiers.byIssuer(LOCAL_ISSUER)).resolves.toBeUndefined();

    const response = await login(armedApi, {
      email: LOCAL_EMAIL,
      password: LOCAL_PASSWORD,
    });
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect((await me(armedApi, token)).status).toBe(200);
  });

  test('C10: returns a short-lived RS256 token on the local issuer with the configured audience', async () => {
    const res = await login(armedApi, { email: LOCAL_EMAIL, password: LOCAL_PASSWORD });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number; email: string };
    expect(body.email).toBe(LOCAL_EMAIL);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    const { payload, protectedHeader } = await jwtVerify(body.token, local.keys, {
      issuer: LOCAL_ISSUER,
      audience: AUDIENCE,
    });
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.iss).toBe(LOCAL_ISSUER);
    expect(payload.aud).toBe(AUDIENCE);
    expect(payload.sub).toBe(LOCAL_EMAIL);
    const ttl = (payload.exp ?? 0) - (payload.iat ?? 0);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(LOCAL_TOKEN_TTL_SECONDS);
  });

  test('caps the local session at the live platform token-lifetime maximum', async () => {
    maxTokenLifetimeSec = 300;
    try {
      const response = await login(armedApi, { email: LOCAL_EMAIL, password: LOCAL_PASSWORD });
      expect(response.status).toBe(200);
      const { token } = (await response.json()) as { token: string };
      const { payload } = await jwtVerify(token, local.keys, {
        issuer: LOCAL_ISSUER,
        audience: AUDIENCE,
      });
      expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
      expect((await me(armedApi, token)).status).toBe(200);
    } finally {
      maxTokenLifetimeSec = 86_400;
    }
  });

  test('C11: a wrong password and an unknown email produce byte-identical 401s', async () => {
    const wrongPassword = await login(armedApi, {
      email: LOCAL_EMAIL,
      password: 'wrong-password-1',
    });
    const unknownEmail = await login(armedApi, {
      email: 'someone-else@example.test',
      password: LOCAL_PASSWORD,
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    const wrongBody = await wrongPassword.text();
    expect(await unknownEmail.text()).toBe(wrongBody);
    // Nothing in the response may hint at which half failed.
    expect(wrongBody).not.toMatch(/password|email|account|unknown/i);
  });

  test('C11: a password of a different length is the same generic 401, not a crash', async () => {
    // timingSafeEqual throws on unequal buffer lengths; an unguarded compare would 500 here and
    // that difference alone would disclose whether the length matched.
    const short = await login(armedApi, { email: LOCAL_EMAIL, password: 'x' });
    expect(short.status).toBe(401);
    const long = await login(armedApi, { email: LOCAL_EMAIL, password: `${LOCAL_PASSWORD}-extra` });
    expect(long.status).toBe(401);
    const baseline = await (
      await login(armedApi, { email: LOCAL_EMAIL, password: 'wrong' })
    ).text();
    expect(await short.text()).toBe(baseline);
    expect(await long.text()).toBe(baseline);
  });

  test('C12: the endpoint is not registered when local login is disarmed', async () => {
    expect(
      (await login(disarmedApi, { email: LOCAL_EMAIL, password: LOCAL_PASSWORD })).status,
    ).toBe(404);
  });

  test('C12: capabilities report arming from the same object that gates the route', async () => {
    expect(await (await armedApi.request('/auth/capabilities')).json()).toEqual({
      localPasswordLogin: true,
      localDevelopmentLogin: true,
    });
    expect(await (await disarmedApi.request('/auth/capabilities')).json()).toEqual({
      localPasswordLogin: false,
      localDevelopmentLogin: false,
    });
  });
});

describe('local token verification', () => {
  test('automatic sessions reuse the local workspace and pass ordinary authorization', async () => {
    const res = await armedApi.request('http://localhost/auth/local/session', {
      method: 'POST',
      headers: { origin: 'http://localhost:45173', 'x-sre-local-development': 'true' },
      body: JSON.stringify({ email: '  DEV@example.test  ' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { token } = (await res.json()) as { token: string };
    const current = await me(armedApi, token);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      state: 'active',
      tenant: { slug: 'local-dev', role: 'owner' },
    });
    expect(await localMemberships(LOCAL_EMAIL)).toHaveLength(1);
  });

  test('C14: a local token resolves through the persisted local provider binding', async () => {
    const token = await signWith(localPrivateKey, 'local-key', { sub: LOCAL_EMAIL }, LOCAL_ISSUER);
    const res = await me(armedApi, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: 'active',
      tenant: { slug: 'local-dev', role: 'owner' },
    });
  });

  test('C13: an Auth0-signed token claiming the local issuer is rejected', async () => {
    const forged = await signWith(
      auth0PrivateKey,
      AUTH0_KID,
      { sub: SEEDED_SUBJECT },
      LOCAL_ISSUER,
    );
    const res = await me(armedApi, forged);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid token' });
  });

  test('C13: a local-signed token claiming the Auth0 issuer is rejected', async () => {
    const forged = await signWith(
      localPrivateKey,
      'local-key',
      { sub: SEEDED_SUBJECT },
      AUTH0_ISSUER,
    );
    const res = await me(armedApi, forged);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid token' });
  });

  test('C12: a local-issuer token is rejected when local login is disarmed', async () => {
    const token = await signWith(
      localPrivateKey,
      'local-key',
      { sub: SEEDED_SUBJECT },
      LOCAL_ISSUER,
    );
    const res = await me(disarmedApi, token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid token' });
  });
});

describe('C20: tenant provisioning for the local identity', () => {
  // Earlier blocks already logged in, so rewind the identity to prove creation from nothing.
  beforeAll(async () => {
    await resetLocalIdentity();
  });

  test('provisioning is unreachable while local login is disarmed', async () => {
    expect(await localMemberships(LOCAL_EMAIL)).toHaveLength(0);
    expect(
      (await login(disarmedApi, { email: LOCAL_EMAIL, password: LOCAL_PASSWORD })).status,
    ).toBe(404);
    expect(await localMemberships(LOCAL_EMAIL)).toHaveLength(0);
  });

  test('provisions a tenant + membership on first login and is idempotent on the second', async () => {
    const first = await login(armedApi, { email: LOCAL_EMAIL, password: LOCAL_PASSWORD });
    expect(first.status).toBe(200);
    const rows = await localMemberships(LOCAL_EMAIL);
    expect(rows).toHaveLength(1);
    const provisionedTenantId = rows[0]?.tenantId;
    expect(provisionedTenantId).toBeTruthy();
    expect(provisionedTenantId).not.toBe(seededTenantId);
    const [localUser] = await admin.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.issuer, LOCAL_ISSUER), eq(users.subject, LOCAL_EMAIL)));
    expect(localUser).toBeDefined();
    expect(await isPlatformOperator(app.db, localUser!.id)).toBe(true);
    const [localProvider] = await admin.db
      .select({
        id: identityProviders.id,
        kind: identityProviders.kind,
        scope: identityProviders.scope,
        status: identityProviders.status,
      })
      .from(identityProviders)
      .where(eq(identityProviders.issuer, LOCAL_ISSUER));
    expect(localProvider).toMatchObject({ kind: 'local', scope: 'tenant', status: 'active' });
    expect(
      await admin.db
        .select({
          tenantId: tenantIdentityBindings.tenantId,
          claimValue: tenantIdentityBindings.claimValue,
        })
        .from(tenantIdentityBindings)
        .where(eq(tenantIdentityBindings.providerId, localProvider!.id)),
    ).toEqual([{ tenantId: provisionedTenantId, claimValue: null }]);
    expect(
      await admin.db
        .select({ role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, localUser!.id),
            eq(memberships.tenantId, provisionedTenantId!),
          ),
        ),
    ).toEqual([{ role: 'owner', status: 'active' }]);
    expect(
      await admin.db
        .select({ status: workspaceFoundings.status, tenantId: workspaceFoundings.tenantId })
        .from(workspaceFoundings)
        .where(
          and(
            eq(workspaceFoundings.founderUserId, localUser!.id),
            eq(workspaceFoundings.slug, 'local-dev'),
          ),
        ),
    ).toEqual([{ status: 'active', tenantId: provisionedTenantId }]);

    // The minted token must reach data: the provisioned membership is what /me resolves.
    const { token } = (await first.json()) as { token: string };
    const meRes = await me(armedApi, token);
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toMatchObject({
      state: 'active',
      tenant: { id: provisionedTenantId, slug: 'local-dev', role: 'owner' },
    });

    const second = await login(armedApi, { email: LOCAL_EMAIL, password: LOCAL_PASSWORD });
    expect(second.status).toBe(200);
    // Idempotent: no second tenant, no ambiguous-membership 403 on the next request.
    expect(await localMemberships(LOCAL_EMAIL)).toEqual([{ tenantId: provisionedTenantId }]);
    const { token: token2 } = (await second.json()) as { token: string };
    expect(await (await me(armedApi, token2)).json()).toMatchObject({
      tenant: { id: provisionedTenantId },
    });
  });
});

registerInactiveLocalAuthCases(() => ({
  db: admin,
  local,
  api: armedApi,
  reset: resetLocalIdentity,
  email: LOCAL_EMAIL,
  password: LOCAL_PASSWORD,
  memberships: () => localMemberships(LOCAL_EMAIL),
}));
