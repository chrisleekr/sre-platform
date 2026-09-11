import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import {
  identityProviders,
  listPublicProviders,
  makeDb,
  makePlatformSecretStore,
  platformSecrets,
  type DbHandle,
} from '@sre/db';
import {
  formatBootstrapReport,
  parseBootstrapInput,
  runBootstrap,
} from '../../../../../packages/db/src/bootstrap';
import {
  bootstrapEnv,
  cleanupBootstrapFixtures,
  discovery,
  fixture,
  markerCounts,
} from '../../../../../packages/db/src/__tests__/bootstrap-test-support';
import { makeProviderVerifiers } from '../../auth/providers';
import type { AuthDeps, AuthVariables } from '../../auth';
import { makeBrowserOidc } from '../browser-oidc';
import { makeBrowserSessionRuntime } from '../browser-session-runtime';
import { browserSessionRoutes } from '../browser-session-routes';
import { meRoutes } from '../me';

let db: DbHandle;
const storedNames: string[] = [];
const masterKey = randomBytes(32).toString('base64');
const secret = 'isolated-bootstrap-client-secret';

beforeAll(() => {
  db = makeDb(process.env.DATABASE_URL!);
});
afterEach(async () => {
  for (const name of storedNames.splice(0))
    await db.db.delete(platformSecrets).where(eq(platformSecrets.name, name));
  await cleanupBootstrapFixtures(db);
});
afterAll(async () => {
  await db?.close();
});

function confidential(label: string) {
  const value = fixture(label);
  const { audience: _audience, ...provider } = value.provider;
  return {
    value,
    env: {
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
        ...provider,
        emailClaim: 'email',
        clientAuthentication: 'client_secret_post',
      }),
      BOOTSTRAP_STAFF_CLIENT_SECRET: secret,
      SECRETS_MASTER_KEY: masterKey,
    },
  };
}

test.each(['BOOTSTRAP_STAFF_CLIENT_SECRET', 'SECRETS_MASTER_KEY'])(
  'rejects missing %s before any provider or administrator is created',
  async (missing) => {
    const { value, env } = confidential('missing');
    const input: Record<string, string | undefined> = { ...env, [missing]: undefined };
    const discover = vi.fn();
    await expect(runBootstrap(input, discover)).rejects.toThrow(`Missing required env: ${missing}`);
    expect(discover).not.toHaveBeenCalled();
    expect(await markerCounts(db, value.marker)).toMatchObject({
      providers: 0,
      users: 0,
      operators: 0,
      invitations: 0,
    });
  },
);

test('rejects an invalid encryption key and secret embedded in public metadata', () => {
  const { env } = confidential('invalid-key');
  expect(() => parseBootstrapInput({ ...env, SECRETS_MASTER_KEY: 'short' })).toThrow(
    'must decode to 32 bytes',
  );
  const provider = JSON.parse(env.BOOTSTRAP_STAFF_PROVIDER);
  expect(() =>
    parseBootstrapInput({
      ...env,
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({ ...provider, clientSecret: secret }),
    }),
  ).toThrow('unexpected key "clientSecret"');
});

test('stores a session-only confidential provider and encrypted credential idempotently without disclosure', async () => {
  const { value, env } = confidential('encrypted');
  const first = await runBootstrap(env, discovery(value));
  const name = `oidc-client:${first.provider.id}`;
  storedNames.push(name);
  const [provider] = await db.db
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.id, first.provider.id));
  expect(provider).toMatchObject({
    audience: null,
    clientAuthentication: 'client_secret_post',
    browserClientId: value.provider.browserClientId,
  });
  const [stored] = await db.db.select().from(platformSecrets).where(eq(platformSecrets.name, name));
  expect(stored).toBeDefined();
  expect(Buffer.from(stored!.ciphertext).includes(Buffer.from(secret))).toBe(false);
  expect(await makePlatformSecretStore(db.db, masterKey).get(name)).toBe(secret);
  const repeated = await runBootstrap(
    { ...env, BOOTSTRAP_STAFF_CLIENT_SECRET: 'must-not-rotate' },
    discovery(value),
  );
  expect(repeated.provider).toEqual({ ...first.provider, created: false });
  expect(await db.db.select().from(platformSecrets).where(eq(platformSecrets.name, name))).toEqual([
    stored,
  ]);
  expect(JSON.stringify(await listPublicProviders(db.db))).not.toContain(secret);
  expect(formatBootstrapReport(first)).not.toContain(secret);
  expect(JSON.stringify(first)).not.toContain('clientSecret');
});

test('preserves an explicit API audience and refuses to attach a secret to a different existing client', async () => {
  const { value, env } = confidential('exact-client');
  const declaration = JSON.parse(env.BOOTSTRAP_STAFF_PROVIDER);
  const withAudience = {
    ...env,
    BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({ ...declaration, audience: value.provider.audience }),
  };
  const first = await runBootstrap(withAudience, discovery(value));
  const name = `oidc-client:${first.provider.id}`;
  storedNames.push(name);
  await expect(
    runBootstrap(
      {
        ...env,
        BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
          ...declaration,
          browserClientId: 'different-client',
        }),
      },
      discovery(value),
    ),
  ).rejects.toThrow('existing staff provider differs');
  const [row] = await db.db
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.id, first.provider.id));
  expect(row?.audience).toBe(value.provider.audience);
  expect(await makePlatformSecretStore(db.db, masterKey).get(name)).toBe(secret);
});

test.each(['client_secret_post', 'client_secret_basic', 'none'])(
  'allows the first bootstrapped administrator to sign in with %s without an API audience',
  async (method) => {
    const { value, env } = confidential('first-login');
    const clientBase = value.provider.browserClientId;
    const specialSecret = "secret: +/é%!'()~";
    value.provider.browserClientId += ": +/é%!'()~";
    env.BOOTSTRAP_STAFF_PROVIDER = JSON.stringify({
      ...JSON.parse(env.BOOTSTRAP_STAFF_PROVIDER),
      browserClientId: value.provider.browserClientId,
      clientAuthentication: method,
    });
    env.BOOTSTRAP_STAFF_CLIENT_SECRET = method === 'none' ? '' : specialSecret;
    const bootstrapped = await runBootstrap(env, discovery(value));
    storedNames.push(`oidc-client:${bootstrapped.provider.id}`);
    const pair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    const secrets = makePlatformSecretStore(db.db, masterKey);
    const dashboard = 'http://dashboard.example.test';
    const auth: AuthDeps = {
      db: db.db,
      adminDb: db.db,
      verifiers: makeProviderVerifiers(db.db),
      settings: { get: async () => 86_400 },
      revoke: { publish: async () => {} },
    };
    let nonce: string;
    let challenge: string;
    const runtime = makeBrowserSessionRuntime({
      db: db.db,
      auth,
      secrets,
      dashboardUrl: dashboard,
      production: false,
      setting: async () => 86_400,
      email: async () => null,
      exchange: makeBrowserOidc(secrets, {
        fetchJson: async () => ({ keys: [{ ...jwk, kid: 'bootstrap', alg: 'RS256' }] }),
        postForm: async (_url, form, ...extra: unknown[]) => {
          if (method === 'client_secret_basic') {
            const headers = extra[0] as Record<string, string>;
            const expected = `${clientBase}%3A+%2B%2F%C3%A9%25%21%27%28%29%7E:secret%3A+%2B%2F%C3%A9%25%21%27%28%29%7E`;
            expect(headers.authorization).toBe(`Basic ${Buffer.from(expected).toString('base64')}`);
            expect(form).not.toHaveProperty('client_id');
            expect(form).not.toHaveProperty('client_secret');
          } else {
            expect(form.client_id).toBe(value.provider.browserClientId);
            expect(form.client_secret).toBe(method === 'none' ? undefined : specialSecret);
          }
          expect(createHash('sha256').update(form.code_verifier!).digest('base64url')).toBe(
            challenge,
          );
          return {
            access_token: 'opaque-not-an-api-token',
            id_token: await new SignJWT({
              nonce,
              email: value.subjectAdmin.email,
              email_verified: true,
            })
              .setProtectedHeader({ alg: 'RS256', kid: 'bootstrap' })
              .setSubject(value.subjectAdmin.subject)
              .setIssuer(value.provider.issuer)
              .setAudience(value.provider.browserClientId)
              .setIssuedAt()
              .setExpirationTime('5m')
              .sign(pair.privateKey),
          };
        },
      }),
    });
    auth.browserSession = runtime.resolve;
    const limiter = { allow: async () => true };
    const app = new Hono<{ Variables: AuthVariables }>()
      .route(
        '/',
        browserSessionRoutes(runtime, limiter, () => '203.0.113.10'),
      )
      .route('/', meRoutes({ auth, db: db.db, limiter, sourceAddress: () => '203.0.113.10' }));
    const cookies = new Map<string, string>();
    async function request(path: string, body?: unknown) {
      const response = await app.request(path, {
        method: body ? 'POST' : 'GET',
        headers: {
          origin: dashboard,
          'x-sre-session': '1',
          'content-type': 'application/json',
          cookie: [...cookies].map(([key, item]) => `${key}=${item}`).join('; '),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      for (const header of response.headers.getSetCookie()) {
        const [item] = header.split(';');
        const separator = item!.indexOf('=');
        cookies.set(item!.slice(0, separator), item!.slice(separator + 1));
      }
      return response;
    }
    const start = await request('/auth/browser/start', {
      providerId: bootstrapped.provider.id,
      returnTo: '/admin',
    });
    expect(start.status).toBe(200);
    const url = new URL(((await start.json()) as { authorizationUrl: string }).authorizationUrl);
    nonce = url.searchParams.get('nonce')!;
    challenge = url.searchParams.get('code_challenge')!;
    const completed = await request('/auth/browser/complete', {
      code: randomUUID(),
      state: url.searchParams.get('state'),
    });
    expect(completed.status).toBe(200);
    const body = await completed.text();
    expect(body).not.toContain('opaque-not-an-api-token');
    expect(body).not.toContain(specialSecret);
    expect(body).not.toContain('secret%3A');
    const me = await request('/me');
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { isPlatformAdmin: true } });
  },
);
