import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import {
  backchannelLogoutReceipts,
  identityProviders,
  makeDb,
  makeSecretStore,
  type DbHandle,
} from '@sre/db';
import { makeApp } from '../app';
import type { AuthDeps } from '../auth';
import { backchannelLogoutRoutes } from '../auth/backchannel-logout';

const issuer = `https://registration-${randomUUID()}.provider.invalid/`;
const providerId = randomUUID();
const browserClientId = `browser-${randomUUID()}`;
const event = 'http://schemas.openid.net/event/backchannel-logout';
let db: DbHandle;
let token: string;
const rateLimit = vi.fn(async () => true);
const sourceAddress = vi.fn(() => '192.0.2.20');
const resolveProvider = vi.fn();
const publish = vi.fn(async () => undefined);

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'registration-key';
  jwk.alg = 'RS256';
  const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
  token = await new SignJWT({
    sub: 'already-signed-out',
    jti: randomUUID(),
    events: { [event]: {} },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'registration-key', typ: 'logout+jwt' })
    .setIssuer(issuer)
    .setAudience(browserClientId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey);
  const verifiers: AuthDeps['verifiers'] = {
    byIssuer: async () => undefined,
    forFounding: async () => undefined,
    invalidate() {},
  };
  const auth: AuthDeps = {
    verifiers,
    db: db.db,
    adminDb: db.db,
    settings: { get: async () => 86_400 },
    revoke: { publish },
  };
  const settings = {
    list: async () => [],
    set: async () => null,
  };
  api = makeApp({
    auth,
    readinessDb: db.db,
    appDb: db.db,
    secrets: makeSecretStore(db.db, Buffer.alloc(32, 9).toString('base64')),
    cache: { get: async () => [], set: async () => undefined },
    settings,
    publicRateLimiter: { allow: rateLimit },
    publicSourceAddress: sourceAddress,
    backchannelLogout: {
      db: db.db,
      resolveProvider: async (id) => resolveProvider(id),
      limiter: { allow: rateLimit },
      sourceAddress,
      revoke: auth.revoke,
    },
  });
  resolveProvider.mockImplementation(async (id) =>
    id === providerId
      ? { id: providerId, issuer, browserClientId, keys, enabled: true, typRequired: false }
      : undefined,
  );
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Registration test provider',
    issuer,
    jwksUri: `${issuer}.well-known/jwks.json`,
    browserClientId,
    backchannelLogout: true,
    kind: 'oidc',
    scope: 'tenant',
    status: 'active',
  });
});

let api: ReturnType<typeof makeApp>;

afterAll(async () => {
  await db?.db
    .delete(backchannelLogoutReceipts)
    .where(eq(backchannelLogoutReceipts.providerId, providerId));
  await db?.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await db?.close();
});

beforeEach(async () => {
  rateLimit.mockClear();
  rateLimit.mockResolvedValue(true);
  sourceAddress.mockClear();
  resolveProvider.mockClear();
  publish.mockClear();
  await db.db
    .delete(backchannelLogoutReceipts)
    .where(eq(backchannelLogoutReceipts.providerId, providerId));
});

test('the application serves provider-authenticated logout before bearer auth and user limiting', async () => {
  const response = await api.request(`/auth/providers/${providerId}/backchannel-logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ logout_token: token }),
  });

  expect(response.status).toBe(200);
  expect(rateLimit).toHaveBeenCalledWith('oidc-backchannel', '192.0.2.20', 600, 60_000);
  expect(sourceAddress).toHaveBeenCalledOnce();
});

test('bounds public ingress before provider lookup without requiring bearer authentication', async () => {
  rateLimit.mockResolvedValue(false);

  const response = await api.request(`/auth/providers/${providerId}/backchannel-logout`, {
    method: 'POST',
    body: 'not-a-token',
  });

  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(resolveProvider).not.toHaveBeenCalled();
});

test('fails closed before provider lookup when the replica-safe limiter fails', async () => {
  rateLimit.mockRejectedValue(new Error('Valkey unavailable'));

  const response = await api.request(`/auth/providers/${providerId}/backchannel-logout`, {
    method: 'POST',
    body: 'not-a-token',
  });

  expect(response.status).toBe(503);
  expect(resolveProvider).not.toHaveBeenCalled();
});

test('fails closed before provider lookup when the ingress budget is not configured', async () => {
  const route = new Hono().route(
    '/',
    backchannelLogoutRoutes({
      db: db.db,
      resolveProvider,
      revoke: { publish: async () => undefined },
    }),
  );

  const response = await route.request(`/auth/providers/${providerId}/backchannel-logout`, {
    method: 'POST',
    body: 'not-a-token',
  });

  expect(response.status).toBe(503);
  expect(resolveProvider).not.toHaveBeenCalled();
});

test('rejects an oversized form before provider lookup or durable receipt work', async () => {
  const response = await api.request(`/auth/providers/${providerId}/backchannel-logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ logout_token: 'x'.repeat(33 * 1_024) }),
  });

  expect(response.status).toBe(400);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(resolveProvider).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(
    await db.db
      .select({ id: backchannelLogoutReceipts.id })
      .from(backchannelLogoutReceipts)
      .where(eq(backchannelLogoutReceipts.providerId, providerId)),
  ).toEqual([]);
});

test('rejects a malformed provider id before provider lookup or body parsing', async () => {
  const request = new Request('http://localhost/auth/providers/not-a-uuid/backchannel-logout', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'logout_token=must-not-be-read',
  });
  const readBody = vi
    .spyOn(request, 'text')
    .mockRejectedValue(new Error('malformed provider ID must not parse the body'));

  const response = await api.fetch(request);

  expect(response.status).toBe(404);
  expect(readBody).not.toHaveBeenCalled();
  expect(resolveProvider).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(
    await db.db
      .select({ id: backchannelLogoutReceipts.id })
      .from(backchannelLogoutReceipts)
      .where(eq(backchannelLogoutReceipts.providerId, providerId)),
  ).toEqual([]);
});
