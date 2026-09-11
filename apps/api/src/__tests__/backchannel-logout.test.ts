import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  backchannelLogoutReceipts,
  browserSessions,
  createBrowserSession,
  identityProviders,
  makeDb,
  users,
  type DbHandle,
} from '@sre/db';
import { backchannelLogoutRoutes } from '../auth/backchannel-logout';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const marker = randomUUID();
const providerId = randomUUID();
const otherProviderId = randomUUID();
const issuer = `https://logout-${marker}.provider.invalid/`;
const otherIssuer = `https://other-${marker}.provider.invalid/`;
const browserClientId = `browser-${marker}`;
const eventName = 'http://schemas.openid.net/event/backchannel-logout';
const published =
  vi.fn<(message: { userId: string; applicationSessionId?: string }) => Promise<void>>();

let db: DbHandle;
let signingKey: CryptoKey;
let wrongSigningKey: CryptoKey;
let es256SigningKey: CryptoKey;
let verificationKeys: ReturnType<typeof createLocalJWKSet>;
let capabilityEnabled = true;
let typRequired = false;

function api() {
  return new Hono().route(
    '/',
    backchannelLogoutRoutes({
      db: db.db,
      resolveProvider: async (id) =>
        id === providerId
          ? {
              id: providerId,
              issuer,
              browserClientId,
              keys: verificationKeys,
              enabled: capabilityEnabled,
              typRequired,
            }
          : undefined,
      limiter: { allow: async () => true },
      sourceAddress: () => '192.0.2.10',
      revoke: { publish: published },
    }),
  );
}

interface TokenOverrides {
  algorithm?: 'RS256' | 'ES256';
  audience?: string | string[];
  azp?: string;
  events?: Record<string, unknown> | null;
  expiresAt?: number | string | null;
  issuedAt?: number;
  issuer?: string;
  jti?: string | null;
  nonce?: string;
  padding?: string;
  sid?: string;
  signingKey?: CryptoKey;
  sub?: string;
  typ?: string | null;
}

async function logoutToken(overrides: TokenOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const claims: Record<string, unknown> = {
    events: overrides.events === undefined ? { [eventName]: {} } : overrides.events,
  };
  if (typeof overrides.expiresAt === 'string') claims.exp = overrides.expiresAt;
  if (overrides.jti !== null) claims.jti = overrides.jti ?? randomUUID();
  if (overrides.azp !== undefined) claims.azp = overrides.azp;
  if (overrides.nonce !== undefined) claims.nonce = overrides.nonce;
  if (overrides.padding !== undefined) claims.padding = overrides.padding;
  if (overrides.sid !== undefined) claims.sid = overrides.sid;
  if (overrides.sub !== undefined) claims.sub = overrides.sub;
  const algorithm = overrides.algorithm ?? 'RS256';
  const protectedHeader = {
    alg: algorithm,
    kid: algorithm === 'ES256' ? 'es256-key' : 'logout-key',
    ...(overrides.typ === null ? {} : { typ: overrides.typ ?? 'logout+jwt' }),
  };
  const token = new SignJWT(claims)
    .setProtectedHeader(protectedHeader)
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? browserClientId);
  if (overrides.expiresAt !== null && typeof overrides.expiresAt !== 'string') {
    token.setExpirationTime(overrides.expiresAt ?? now + 300);
  }
  if (overrides.issuedAt !== undefined) token.setIssuedAt(overrides.issuedAt);
  else token.setIssuedAt(now);
  return token.sign(overrides.signingKey ?? signingKey);
}

async function post(
  token: string,
  id = providerId,
  contentType = 'application/x-www-form-urlencoded',
) {
  return api().request(`/auth/providers/${id}/backchannel-logout`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: new URLSearchParams({ logout_token: token }),
  });
}

async function createIdentity(input: {
  providerId?: string;
  issuer?: string;
  clientId?: string;
  subject?: string;
  oidcSubject?: string;
  sid?: string;
}) {
  const [user] = await db.db
    .insert(users)
    .values({
      issuer: input.issuer ?? issuer,
      subject: input.subject ?? `canonical-${randomUUID()}`,
      email: `${randomUUID()}@example.test`,
    })
    .returning();
  const created = await createBrowserSession(db.db, {
    providerId: input.providerId ?? providerId,
    clientId: input.clientId ?? browserClientId,
    userId: user!.id,
    foundingId: null,
    oidcSubject: input.oidcSubject ?? 'directory-person',
    oidcSessionId: input.sid,
    bindingClaimValue: null,
    authenticatedAt: new Date(),
    idleSeconds: 3_600,
    absoluteSeconds: 86_400,
  });
  return { user: user!, session: created.session };
}

async function sessionState(ids: string[]) {
  return db.db
    .select({ id: browserSessions.id, revokedAt: browserSessions.revokedAt })
    .from(browserSessions)
    .where(inArray(browserSessions.id, ids));
}

async function receiptRows() {
  return db.db
    .select({ jtiHash: backchannelLogoutReceipts.jtiHash })
    .from(backchannelLogoutReceipts)
    .where(eq(backchannelLogoutReceipts.providerId, providerId));
}

beforeAll(async () => {
  db = makeDb(DATABASE_URL);
  const pair = await generateKeyPair('RS256', { extractable: true });
  const es256Pair = await generateKeyPair('ES256', { extractable: true });
  signingKey = pair.privateKey;
  wrongSigningKey = (await generateKeyPair('RS256')).privateKey;
  es256SigningKey = es256Pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'logout-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const es256Jwk = await exportJWK(es256Pair.publicKey);
  es256Jwk.kid = 'es256-key';
  es256Jwk.alg = 'ES256';
  es256Jwk.use = 'sig';
  verificationKeys = createLocalJWKSet({ keys: [jwk, es256Jwk] } as JSONWebKeySet);
  await db.db.insert(identityProviders).values([
    {
      id: providerId,
      displayName: 'Back-channel logout provider',
      issuer,
      jwksUri: `${issuer}.well-known/jwks.json`,
      browserClientId,
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
    },
    {
      id: otherProviderId,
      displayName: 'Other provider',
      issuer: otherIssuer,
      jwksUri: `${otherIssuer}.well-known/jwks.json`,
      browserClientId: `other-${browserClientId}`,
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
    },
  ]);
});

beforeEach(async () => {
  published.mockReset();
  published.mockResolvedValue(undefined);
  capabilityEnabled = true;
  typRequired = false;
  await db.db
    .delete(backchannelLogoutReceipts)
    .where(inArray(backchannelLogoutReceipts.providerId, [providerId, otherProviderId]));
  await db.db.delete(users).where(inArray(users.issuer, [issuer, otherIssuer]));
});

afterAll(async () => {
  if (!db) return;
  await db.db
    .delete(backchannelLogoutReceipts)
    .where(inArray(backchannelLogoutReceipts.providerId, [providerId, otherProviderId]));
  await db.db.delete(users).where(inArray(users.issuer, [issuer, otherIssuer]));
  await db.db
    .delete(identityProviders)
    .where(inArray(identityProviders.id, [providerId, otherProviderId]));
  await db.close();
});

describe('OIDC back-channel logout', () => {
  test('accepts a signed sub logout without bearer auth and cuts off only the exact provider identity', async () => {
    const matching = await createIdentity({
      subject: 'configured-subject-claim',
      oidcSubject: 'raw-oidc-subject',
      sid: 'first-upstream-session',
    });
    const secondMatching = await createIdentity({
      subject: 'second-local-user',
      oidcSubject: 'raw-oidc-subject',
      sid: 'second-upstream-session',
    });
    const wrongSubject = await createIdentity({ oidcSubject: 'another-raw-subject' });
    const wrongClient = await createIdentity({
      oidcSubject: 'raw-oidc-subject',
      clientId: 'retired-browser-client',
    });
    const wrongProvider = await createIdentity({
      providerId: otherProviderId,
      issuer: otherIssuer,
      oidcSubject: 'raw-oidc-subject',
    });

    const response = await post(await logoutToken({ sub: 'raw-oidc-subject' }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    const states = await sessionState([
      matching.session.id,
      secondMatching.session.id,
      wrongSubject.session.id,
      wrongClient.session.id,
      wrongProvider.session.id,
    ]);
    expect(
      states
        .filter((row) => row.revokedAt !== null)
        .map((row) => row.id)
        .sort(),
    ).toEqual([matching.session.id, secondMatching.session.id].sort());
    const affectedUsers = await db.db
      .select({ id: users.id, notBefore: users.notBefore })
      .from(users)
      .where(
        inArray(users.id, [
          matching.user.id,
          secondMatching.user.id,
          wrongSubject.user.id,
          wrongClient.user.id,
          wrongProvider.user.id,
        ]),
      );
    expect(
      affectedUsers
        .filter((row) => row.notBefore !== null)
        .map((row) => row.id)
        .sort(),
    ).toEqual([matching.user.id, secondMatching.user.id].sort());
    expect(published.mock.calls.map(([message]) => message)).toEqual(
      expect.arrayContaining([{ userId: matching.user.id }, { userId: secondMatching.user.id }]),
    );
    expect(published).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['nonce', { sub: 'raw-oidc-subject', nonce: 'forbidden' }],
    ['missing events', { sub: 'raw-oidc-subject', events: null }],
    ['missing event member', { sub: 'raw-oidc-subject', events: { other: {} } }],
    ['scalar event member', { sub: 'raw-oidc-subject', events: { [eventName]: 'invalid' } }],
    ['array event member', { sub: 'raw-oidc-subject', events: { [eventName]: [] } }],
    ['missing jti', { sub: 'raw-oidc-subject', jti: null }],
    ['missing exp', { sub: 'raw-oidc-subject', expiresAt: null }],
    ['non-numeric exp', { sub: 'raw-oidc-subject', expiresAt: 'later' }],
    ['missing sub and sid', {}],
    ['wrong signature', { sub: 'raw-oidc-subject', signingKey: undefined }],
    ['wrong algorithm', { sub: 'raw-oidc-subject', algorithm: 'ES256' }],
    ['wrong issuer', { sub: 'raw-oidc-subject', issuer: otherIssuer }],
    ['wrong audience', { sub: 'raw-oidc-subject', audience: 'another-client' }],
    ['wrong azp', { sub: 'raw-oidc-subject', azp: 'another-client' }],
    ['multi-audience without azp', { sub: 'raw-oidc-subject', audience: [browserClientId, 'api'] }],
    [
      'multi-audience with matching azp',
      { sub: 'raw-oidc-subject', audience: [browserClientId, 'api'], azp: browserClientId },
    ],
    ['stale iat', { sub: 'raw-oidc-subject', issuedAt: 0 }],
    ['expired token', { sub: 'raw-oidc-subject', expiresAt: 1 }],
  ] satisfies Array<[string, TokenOverrides]>)(
    'rejects %s without mutation',
    async (name, value) => {
      const target = await createIdentity({ oidcSubject: 'raw-oidc-subject', sid: 'upstream' });
      const token = await logoutToken(
        name === 'wrong signature'
          ? { ...value, signingKey: wrongSigningKey }
          : name === 'wrong algorithm'
            ? { ...value, signingKey: es256SigningKey }
            : value,
      );

      const response = await post(token);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
      expect(await sessionState([target.session.id])).toEqual([
        { id: target.session.id, revokedAt: null },
      ]);
      expect(
        (
          await db.db
            .select({ notBefore: users.notBefore })
            .from(users)
            .where(eq(users.id, target.user.id))
        )[0]?.notBefore,
      ).toBeNull();
      expect(published).not.toHaveBeenCalled();
      expect(await receiptRows()).toEqual([]);
    },
  );

  test('rejects a replay without applying or publishing the logout twice', async () => {
    const target = await createIdentity({ oidcSubject: 'raw-oidc-subject' });
    const token = await logoutToken({ sub: 'raw-oidc-subject', jti: 'one-time-jti' });

    expect((await post(token)).status).toBe(200);
    const replay = await post(token);

    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_request' });
    expect(published).toHaveBeenCalledTimes(1);
    expect(published).toHaveBeenCalledWith({ userId: target.user.id });
    expect(await receiptRows()).toEqual([
      { jtiHash: createHash('sha256').update('one-time-jti').digest('hex') },
    ]);
  });

  test('a sid-only logout revokes only matching provider and client sessions without a user cutoff', async () => {
    const first = await createIdentity({ oidcSubject: 'first', sid: 'shared-upstream-session' });
    const second = await createIdentity({ oidcSubject: 'second', sid: 'shared-upstream-session' });
    const wrongSid = await createIdentity({ oidcSubject: 'third', sid: 'another-session' });
    const wrongClient = await createIdentity({
      oidcSubject: 'fourth',
      sid: 'shared-upstream-session',
      clientId: 'retired-browser-client',
    });

    const response = await post(await logoutToken({ sid: 'shared-upstream-session' }));

    expect(response.status).toBe(200);
    const states = await sessionState([
      first.session.id,
      second.session.id,
      wrongSid.session.id,
      wrongClient.session.id,
    ]);
    expect(
      states
        .filter((row) => row.revokedAt !== null)
        .map((row) => row.id)
        .sort(),
    ).toEqual([first.session.id, second.session.id].sort());
    expect(
      await db.db
        .select({ notBefore: users.notBefore })
        .from(users)
        .where(inArray(users.id, [first.user.id, second.user.id])),
    ).toEqual([{ notBefore: null }, { notBefore: null }]);
    expect(published.mock.calls.map(([message]) => message)).toEqual(
      expect.arrayContaining([
        { userId: first.user.id, applicationSessionId: first.session.id },
        { userId: second.user.id, applicationSessionId: second.session.id },
      ]),
    );
    expect(published).toHaveBeenCalledTimes(2);
  });

  test('gives sid precedence and uses sub only to isolate the exact upstream session', async () => {
    const exact = await createIdentity({ oidcSubject: 'raw-subject', sid: 'shared-session' });
    const wrongSubject = await createIdentity({
      oidcSubject: 'other-subject',
      sid: 'shared-session',
    });
    const wrongSession = await createIdentity({
      oidcSubject: 'raw-subject',
      sid: 'other-session',
    });

    const response = await post(await logoutToken({ sub: 'raw-subject', sid: 'shared-session' }));

    expect(response.status).toBe(200);
    expect(
      await sessionState([exact.session.id, wrongSubject.session.id, wrongSession.session.id]),
    ).toEqual(
      expect.arrayContaining([
        { id: exact.session.id, revokedAt: expect.any(Date) },
        { id: wrongSubject.session.id, revokedAt: null },
        { id: wrongSession.session.id, revokedAt: null },
      ]),
    );
    expect(published).toHaveBeenCalledOnce();
    expect(published).toHaveBeenCalledWith({
      userId: exact.user.id,
      applicationSessionId: exact.session.id,
    });
    expect(
      await db.db
        .select({ notBefore: users.notBefore })
        .from(users)
        .where(inArray(users.id, [exact.user.id, wrongSubject.user.id, wrongSession.user.id])),
    ).toEqual([{ notBefore: null }, { notBefore: null }, { notBefore: null }]);
  });

  test('accepts a non-empty logout event object', async () => {
    const response = await post(
      await logoutToken({
        sub: 'unknown-subject',
        events: { [eventName]: { provider: 'extension' } },
      }),
    );

    expect(response.status).toBe(200);
  });

  test('accepts a one-element audience array with matching azp', async () => {
    const response = await post(
      await logoutToken({
        sub: 'unknown-subject',
        audience: [browserClientId],
        azp: browserClientId,
      }),
    );

    expect(response.status).toBe(200);
  });

  test('accepts a signed logout token larger than the identifier claim limit', async () => {
    const token = await logoutToken({ sub: 'unknown-subject', padding: 'x'.repeat(3_000) });
    expect(token.length).toBeGreaterThan(2_048);

    expect((await post(token)).status).toBe(200);
  });

  test('accepts form media-type parameters case-insensitively', async () => {
    const token = await logoutToken({ sub: 'unknown-subject' });

    expect(
      (await post(token, providerId, 'Application/X-WWW-Form-Urlencoded; Charset=UTF-8')).status,
    ).toBe(200);
  });

  test.each([
    ['application/json', JSON.stringify({ logout_token: 'not-a-form' })],
    ['multipart/form-data; boundary=invalid', '--invalid'],
  ])('rejects %s before replay or mutation', async (contentType, body) => {
    const target = await createIdentity({ oidcSubject: 'raw-oidc-subject' });

    const response = await api().request(`/auth/providers/${providerId}/backchannel-logout`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });

    expect(response.status).toBe(400);
    expect(await sessionState([target.session.id])).toEqual([
      { id: target.session.id, revokedAt: null },
    ]);
    expect(await receiptRows()).toEqual([]);
    expect(published).not.toHaveBeenCalled();
  });

  test('optionally requires the exact logout+jwt token type', async () => {
    expect((await post(await logoutToken({ sub: 'unknown', typ: null }))).status).toBe(200);
    typRequired = true;

    expect((await post(await logoutToken({ sub: 'unknown', typ: null }))).status).toBe(400);
    expect((await post(await logoutToken({ sub: 'unknown', typ: 'JWT' }))).status).toBe(400);
    expect((await post(await logoutToken({ sub: 'unknown' }))).status).toBe(200);
  });

  test('returns 404 for a disabled capability before consuming the request body', async () => {
    capabilityEnabled = false;
    const request = new Request(
      `http://localhost/auth/providers/${providerId}/backchannel-logout`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'logout_token=must-not-be-read',
      },
    );
    const readBody = vi
      .spyOn(request, 'text')
      .mockRejectedValue(new Error('disabled capability must not parse the body'));

    const response = await api().fetch(request);

    expect(response.status).toBe(404);
    expect(readBody).not.toHaveBeenCalled();
    expect(await receiptRows()).toEqual([]);
    expect(published).not.toHaveBeenCalled();
  });

  test('accepts an unknown sub without publishing a revoke', async () => {
    const response = await post(await logoutToken({ sub: 'unknown-raw-subject' }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(published).not.toHaveBeenCalled();
    expect(await receiptRows()).toHaveLength(1);
  });

  test('consumes a valid unknown sid without publishing or advancing a cutoff', async () => {
    const unrelated = await createIdentity({ oidcSubject: 'known-subject', sid: 'known-sid' });
    const response = await post(
      await logoutToken({ sid: 'unknown-sid', jti: 'unknown-session-token' }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(await sessionState([unrelated.session.id])).toEqual([
      { id: unrelated.session.id, revokedAt: null },
    ]);
    expect(
      (
        await db.db
          .select({ notBefore: users.notBefore })
          .from(users)
          .where(eq(users.id, unrelated.user.id))
      )[0]?.notBefore,
    ).toBeNull();
    expect(published).not.toHaveBeenCalled();
    expect(await receiptRows()).toEqual([
      { jtiHash: createHash('sha256').update('unknown-session-token').digest('hex') },
    ]);
  });
});
