import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  browserSessions,
  identityProviders,
  mailboxProofs,
  oidcAttempts,
  platformSecrets,
  makeDb,
  makePlatformSecretStore,
  users,
  workspaceFoundings,
  type DbHandle,
} from '@sre/db';
import { makeProviderVerifiers } from '../../auth/providers';
import { requireUser, type AuthDeps, type AuthVariables } from '../../auth';
import { makeBrowserOidc } from '../browser-oidc';
import { makeBrowserSessionRuntime } from '../browser-session-runtime';
import { browserSessionRoutes } from '../browser-session-routes';
import { meRoutes } from '../me';

const marker = randomUUID();
const providerId = randomUUID();
const issuer = `https://directory-${marker}.example.test`;
const dashboard = 'http://dashboard.example.test';
const clientId = `client-${marker}`;
const grants = new Map<string, { nonce: string; challenge: string }>();
const published: string[] = [];
const sentCodes: string[] = [];
let db: DbHandle;
let app: Hono<{ Variables: AuthVariables }>;
let privateKey: CryptoKey;
let wrongKey: CryptoKey;
let claims: Record<string, unknown> = {};
let emailVerified = true;
let smtpAvailable = true;
let deliveryFails = false;

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  wrongKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  const secrets = makePlatformSecretStore(db.db, randomBytes(32).toString('base64'));
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Directory',
    issuer,
    jwksUri: `${issuer}/jwks`,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    browserClientId: clientId,
    audience: null,
    kind: 'oidc',
    scope: 'tenant',
    status: 'active',
    clientAuthentication: 'client_secret_post',
  });
  await secrets.put(`oidc-client:${providerId}`, 'test-client-secret');
  const auth: AuthDeps = {
    db: db.db,
    adminDb: db.db,
    verifiers: makeProviderVerifiers(db.db),
    settings: { get: async () => 86_400 },
    revoke: {
      publish: async ({ userId }) => {
        published.push(userId);
      },
    },
  };
  const runtime = makeBrowserSessionRuntime({
    db: db.db,
    auth,
    secrets,
    dashboardUrl: dashboard,
    production: false,
    setting: async (key) => (key === 'SESSION_IDLE_SECONDS' ? 3_600 : 86_400),
    email: async () =>
      smtpAvailable
        ? {
            send: async ({ text }) => {
              if (deliveryFails)
                throw new Error('SMTP secret must never be returned to the browser');
              sentCodes.push(text.match(/\b\d{8}\b/)![0]);
            },
          }
        : null,
    exchange: makeBrowserOidc(secrets, {
      fetchJson: async () => ({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }),
      postForm: async (_url, form) => {
        const grant = grants.get(form.code!);
        if (!grant) throw new Error('invalid code');
        grants.delete(form.code!);
        expect(form.client_secret).toBe('test-client-secret');
        expect(createHash('sha256').update(form.code_verifier!).digest('base64url')).toBe(
          grant.challenge,
        );
        return {
          access_token: 'opaque-upstream-token',
          id_token: await new SignJWT({
            email: `person@${marker}.example.test`,
            email_verified: emailVerified,
            nonce: grant.nonce,
            sid: 'directory-session',
            ...claims,
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'test' })
            .setSubject('person')
            .setIssuer(typeof claims.iss === 'string' ? claims.iss : issuer)
            .setAudience(typeof claims.aud === 'string' ? claims.aud : clientId)
            .setIssuedAt(typeof claims.iat === 'number' ? claims.iat : undefined)
            .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : '5m')
            .sign(claims.invalidSignature ? wrongKey : privateKey),
        };
      },
    }),
  });
  auth.browserSession = runtime.resolve;
  app = new Hono<{ Variables: AuthVariables }>()
    .route(
      '/',
      browserSessionRoutes(runtime, { allow: async () => true }, () => '203.0.113.10'),
    )
    .route(
      '/',
      meRoutes({
        auth,
        db: db.db,
        limiter: { allow: async () => true },
        sourceAddress: () => '203.0.113.10',
      }),
    )
    .get('/identity', requireUser(auth), (c) => c.json({ user: c.get('user') }))
    .post('/identity', requireUser(auth), (c) => c.json({ ok: true }));
});

afterAll(async () => {
  if (!db) return;
  await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await db.db.delete(platformSecrets).where(eq(platformSecrets.name, `oidc-client:${providerId}`));
  await db.db
    .delete(mailboxProofs)
    .where(sql`${mailboxProofs.identity}->>'providerId' = ${providerId}`);
  await db.db.delete(users).where(eq(users.issuer, issuer));
  await db.close();
});

class Browser {
  readonly cookies = new Map<string, string>();
  async request(path: string, body?: unknown, overrides: Record<string, string> = {}) {
    const response = await app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin: dashboard,
        'x-sre-session': '1',
        'content-type': 'application/json',
        cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        ...overrides,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const separator = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, separator), pair!.slice(separator + 1));
    }
    return response;
  }
  async begin(foundingId?: string) {
    const response = await this.request('/auth/browser/start', {
      providerId,
      foundingId,
      returnTo: '/w',
    });
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { authorizationUrl: string }).authorizationUrl);
    expect(url.searchParams.has('prompt')).toBe(false);
    const code = randomUUID();
    grants.set(code, {
      nonce: url.searchParams.get('nonce')!,
      challenge: url.searchParams.get('code_challenge')!,
    });
    return { code, state: url.searchParams.get('state')! };
  }
}

describe('server-owned browser session', () => {
  test('keeps an activated workspace session usable when the browser still sends its founding selector', async () => {
    const foundingId = randomUUID();
    const [person] = await db.db
      .insert(users)
      .values({ issuer, subject: 'person', email: `person@${marker}.example.test` })
      .onConflictDoUpdate({ target: [users.issuer, users.subject], set: { status: 'active' } })
      .returning();
    await db.db.insert(workspaceFoundings).values({
      id: foundingId,
      path: 'own_directory',
      providerId,
      founderUserId: person!.id,
      slug: `activation-${marker}`,
      requestedName: 'Activation',
      declaredDomain: `${marker}.example.test`,
      status: 'founder_authenticated',
      expiresAt: new Date(Date.now() + 3600000),
    });
    try {
      await db.db
        .update(identityProviders)
        .set({ status: 'pending_verification' })
        .where(eq(identityProviders.id, providerId));
      const browser = new Browser();
      expect(
        (await browser.request('/auth/browser/complete', await browser.begin(foundingId))).status,
      ).toBe(200);
      await db.db
        .update(workspaceFoundings)
        .set({ status: 'active' })
        .where(eq(workspaceFoundings.id, foundingId));
      await db.db
        .update(identityProviders)
        .set({ status: 'active' })
        .where(eq(identityProviders.id, providerId));
      expect(
        (await browser.request('/me', undefined, { 'x-onboarding-founding-id': foundingId }))
          .status,
      ).toBe(200);
      expect(await (await browser.request('/auth/browser/session')).json()).toMatchObject({
        authenticated: true,
        foundingId: null,
      });
    } finally {
      await db.db
        .update(identityProviders)
        .set({ status: 'active' })
        .where(eq(identityProviders.id, providerId));
      await db.db.delete(workspaceFoundings).where(eq(workspaceFoundings.id, foundingId));
    }
  });
  test('accepts ordinary OIDC and keeps upstream tokens out of browser responses and storage', async () => {
    const browser = new Browser();
    const attempt = await browser.begin();
    const response = await browser.request('/auth/browser/complete', attempt);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ returnTo: '/w' });
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('sre-session='));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('opaque-upstream-token');
    const [row] = await db.db
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.providerId, providerId));
    expect(row!.credentialHash).not.toBe(browser.cookies.get('sre-session'));
    expect(row!.oidcSubject).toBe('person');
    expect(row!.oidcSessionId).toBe('directory-session');
    expect((await browser.request('/identity')).status).toBe(200);
    expect((await browser.request('/auth/browser/complete', attempt)).status).toBe(400);
    const session = (await (await browser.request('/auth/browser/session')).json()) as {
      authenticated: boolean;
    };
    expect(session.authenticated).toBe(true);
    expect(JSON.stringify(session)).not.toMatch(/accessToken|refreshToken|idToken|credentialHash/);
  });

  test('rejects a callback from another browser without consuming the correct browser attempt', async () => {
    const owner = new Browser();
    const attempt = await owner.begin();
    expect((await new Browser().request('/auth/browser/complete', attempt)).status).toBe(400);
    expect((await owner.request('/auth/browser/complete', attempt)).status).toBe(200);
  });

  test('rejects cross-origin starts and authenticated mutations', async () => {
    const browser = new Browser();
    expect(
      (
        await browser.request(
          '/auth/browser/start',
          { providerId },
          { origin: 'https://attacker.example' },
        )
      ).status,
    ).toBe(403);
    expect((await browser.request('/auth/browser/complete', await browser.begin())).status).toBe(
      200,
    );
    expect(
      (await browser.request('/identity', {}, { origin: 'https://attacker.example' })).status,
    ).toBe(403);
  });

  test.each([
    { nonce: 'wrong-attempt' },
    { aud: 'wrong-client' },
    { azp: 'wrong-client' },
    { iss: 'https://other-directory.example.test' },
    { exp: 1 },
    { invalidSignature: true },
  ])('refuses mismatched identity claims %j', async (invalid) => {
    claims = invalid;
    try {
      const browser = new Browser();
      expect((await browser.request('/auth/browser/complete', await browser.begin())).status).toBe(
        400,
      );
      expect((await browser.request('/identity')).status).toBe(401);
    } finally {
      claims = {};
    }
  });

  test('rejects caller-selected callback providers and redirect destinations without consuming the saved attempt', async () => {
    const browser = new Browser();
    const attempt = await browser.begin();
    for (const extra of [
      { providerId: randomUUID() },
      { redirectUri: 'https://attacker.example/callback' },
    ]) {
      expect(
        (await browser.request('/auth/browser/complete', { ...attempt, ...extra })).status,
      ).toBe(400);
    }
    expect(
      (await browser.request('/auth/browser/complete', { ...attempt, state: randomUUID() })).status,
    ).toBe(400);
    expect((await browser.request('/auth/browser/complete', attempt)).status).toBe(200);
  });

  test('requires mailbox proof and cannot promote a session before the code is consumed once', async () => {
    emailVerified = false;
    try {
      const browser = new Browser();
      const response = await browser.request('/auth/browser/complete', await browser.begin());
      expect(await response.json()).toMatchObject({ mailboxVerificationRequired: true });
      expect((await browser.request('/identity')).status).toBe(401);
      expect(
        (await browser.request('/auth/browser/verify-email', { code: 'xxxxxxxx' })).status,
      ).toBe(400);
      const code = sentCodes.at(-1)!;
      expect((await browser.request('/auth/browser/verify-email', { code })).status).toBe(200);
      expect((await browser.request('/auth/browser/verify-email', { code })).status).toBe(400);
      expect((await browser.request('/identity')).status).toBe(200);
    } finally {
      emailVerified = true;
    }
  });

  test('rejects an expired server attempt even with the original browser and callback', async () => {
    const browser = new Browser();
    const attempt = await browser.begin();
    await db.db
      .update(oidcAttempts)
      .set({ expiresAt: new Date(0) })
      .where(eq(oidcAttempts.stateHash, createHash('sha256').update(attempt.state).digest('hex')));
    expect((await browser.request('/auth/browser/complete', attempt)).status).toBe(400);
    expect((await browser.request('/identity')).status).toBe(401);
  });

  test('rejects an expired mailbox proof without issuing a session', async () => {
    emailVerified = false;
    try {
      const browser = new Browser();
      await browser.request('/auth/browser/complete', await browser.begin());
      const credential = browser.cookies.get('sre-mailbox-proof')!;
      await db.db
        .update(mailboxProofs)
        .set({ expiresAt: new Date(0) })
        .where(
          eq(mailboxProofs.credentialHash, createHash('sha256').update(credential).digest('hex')),
        );
      expect(
        (await browser.request('/auth/browser/verify-email', { code: sentCodes.at(-1) })).status,
      ).toBe(400);
      expect((await browser.request('/identity')).status).toBe(401);
    } finally {
      emailVerified = true;
    }
  });

  test.each(['missing', 'failed'])('fails closed when mailbox delivery is %s', async (mode) => {
    emailVerified = false;
    smtpAvailable = mode !== 'missing';
    deliveryFails = mode === 'failed';
    try {
      const browser = new Browser();
      const response = await browser.request('/auth/browser/complete', await browser.begin());
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('SMTP secret');
      expect((await browser.request('/identity')).status).toBe(401);
    } finally {
      emailVerified = true;
      smtpAvailable = true;
      deliveryFails = false;
    }
  });

  test('keeps the authentication baseline immutable and refuses durable logout immediately', async () => {
    const browser = new Browser();
    await browser.request('/auth/browser/complete', await browser.begin());
    const identity = (await (await browser.request('/identity')).json()) as {
      user: { applicationSessionId: string; userId: string };
    };
    const id = identity.user.applicationSessionId as string;
    const [before] = await db.db.select().from(browserSessions).where(eq(browserSessions.id, id));
    await browser.request('/identity');
    const [after] = await db.db.select().from(browserSessions).where(eq(browserSessions.id, id));
    expect(after!.authenticatedAt).toEqual(before!.authenticatedAt);
    expect(after!.absoluteExpiresAt).toEqual(before!.absoluteExpiresAt);
    await browser.request('/auth/browser/logout', {});
    expect((await browser.request('/identity')).status).toBe(401);
    expect(published).toContain(identity.user.userId);
  });

  test('never treats a valid directory ID token as an API bearer credential', async () => {
    const token = await new SignJWT({
      email: `person@${marker}.example.test`,
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject('person')
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(
      (await app.request('/identity', { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    const browser = new Browser();
    expect((await browser.request('/auth/browser/complete', await browser.begin())).status).toBe(
      200,
    );
    expect((await browser.request('/identity')).status).toBe(200);
  });

  test.each(['idle', 'absolute'])(
    'rejects an expired %s session and cannot renew it',
    async (bound) => {
      const browser = new Browser();
      await browser.request('/auth/browser/complete', await browser.begin());
      const value = (await (await browser.request('/identity')).json()) as {
        user: { applicationSessionId: string };
      };
      const past = new Date(Date.now() - 1_000);
      await db.db
        .update(browserSessions)
        .set(
          bound === 'idle'
            ? { idleExpiresAt: past }
            : { idleExpiresAt: past, absoluteExpiresAt: past },
        )
        .where(eq(browserSessions.id, value.user.applicationSessionId));
      expect((await browser.request('/identity')).status).toBe(401);
      expect(await (await browser.request('/auth/browser/session')).json()).toEqual({
        authenticated: false,
      });
    },
  );

  test.each(['disabled', 'deleted'] as const)(
    'honors current account state %s on the next request',
    async (status) => {
      const browser = new Browser();
      await browser.request('/auth/browser/complete', await browser.begin());
      try {
        await db.db.update(users).set({ status }).where(eq(users.issuer, issuer));
        expect((await browser.request('/identity')).status).toBe(401);
        expect(
          (await browser.request('/auth/browser/complete', await browser.begin())).status,
        ).toBe(400);
      } finally {
        await db.db.update(users).set({ status: 'active' }).where(eq(users.issuer, issuer));
      }
    },
  );

  test('rejects a changed provider client and a disabled provider on the next request', async () => {
    const browser = new Browser();
    await browser.request('/auth/browser/complete', await browser.begin());
    try {
      await db.db
        .update(identityProviders)
        .set({ browserClientId: 'different-client' })
        .where(eq(identityProviders.id, providerId));
      expect((await browser.request('/identity')).status).toBe(401);
      await db.db
        .update(identityProviders)
        .set({ browserClientId: clientId, status: 'disabled' })
        .where(eq(identityProviders.id, providerId));
      expect((await browser.request('/identity')).status).toBe(401);
    } finally {
      await db.db
        .update(identityProviders)
        .set({ browserClientId: clientId, status: 'active' })
        .where(eq(identityProviders.id, providerId));
    }
  });

  test('an administrative cutoff blocks old authentication even if a fresh session is requested', async () => {
    const browser = new Browser();
    await browser.request('/auth/browser/complete', await browser.begin());
    const cutoff = new Date(Date.now());
    try {
      await db.db.update(users).set({ notBefore: cutoff }).where(eq(users.issuer, issuer));
      expect((await browser.request('/identity')).status).toBe(401);
      claims = { iat: Math.floor(cutoff.getTime() / 1_000) - 30 };
      expect((await browser.request('/auth/browser/complete', await browser.begin())).status).toBe(
        400,
      );
    } finally {
      claims = {};
      await db.db.update(users).set({ notBefore: null }).where(eq(users.issuer, issuer));
    }
  });

  test('binds mailbox proof to its browser and limits incorrect code guesses', async () => {
    emailVerified = false;
    try {
      const browser = new Browser();
      await browser.request('/auth/browser/complete', await browser.begin());
      const code = sentCodes.at(-1)!;
      expect((await new Browser().request('/auth/browser/verify-email', { code })).status).toBe(
        400,
      );
      const wrong = code === '00000000' ? '11111111' : '00000000';
      for (let attempt = 0; attempt < 5; attempt++)
        expect((await browser.request('/auth/browser/verify-email', { code: wrong })).status).toBe(
          400,
        );
      expect((await browser.request('/auth/browser/verify-email', { code })).status).toBe(400);
      expect((await browser.request('/identity')).status).toBe(401);
    } finally {
      emailVerified = true;
    }
  });

  test('resends only after cooldown, invalidates the old code, and keeps the same pending identity', async () => {
    emailVerified = false;
    try {
      const browser = new Browser();
      await browser.request('/auth/browser/complete', await browser.begin());
      const oldCode = sentCodes.at(-1)!;
      expect(await (await browser.request('/auth/browser/mailbox')).json()).toMatchObject({
        recipient: `p***@${marker}.example.test`,
      });
      expect((await browser.request('/auth/browser/resend-email', {})).status).toBe(400);
      const proofCredential = browser.cookies.get('sre-mailbox-proof')!;
      await db.db
        .update(mailboxProofs)
        .set({ lastSentAt: new Date(Date.now() - 61000) })
        .where(
          eq(
            mailboxProofs.credentialHash,
            createHash('sha256').update(proofCredential).digest('hex'),
          ),
        );
      expect((await browser.request('/auth/browser/resend-email', {})).status).toBe(200);
      const newCode = sentCodes.at(-1)!;
      expect((await browser.request('/auth/browser/verify-email', { code: oldCode })).status).toBe(
        400,
      );
      expect((await browser.request('/auth/browser/verify-email', { code: newCode })).status).toBe(
        200,
      );
      expect((await browser.request('/identity')).status).toBe(200);
    } finally {
      emailVerified = true;
    }
  });
});
