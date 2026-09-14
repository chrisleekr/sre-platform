import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  identityProviderDomains,
  identityProviders,
  makeDb,
  memberships,
  tenantIdentityBindings,
  tenants,
  users,
  workspaceFoundings,
  type DbHandle,
} from '@sre/db';
import { authMiddleware, requireUser, type AuthDeps, type AuthVariables } from '../../auth';
import type { Verifier } from '../../auth/providers';
import { foundingRoutes } from '../foundings';
import { meRoutes } from '../me';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

describe('founder onboarding authentication', () => {
  let admin: DbHandle;
  let app: DbHandle;

  beforeAll(() => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
  });

  afterAll(async () => {
    await Promise.all([app.close(), admin.close()]);
  });

  test('limits a non-active directory token to its founder and onboarding routes', async () => {
    const providerId = randomUUID();
    const foundingId = randomUUID();
    const tenantId = randomUUID();
    const founderUserId = randomUUID();
    const issuer = `https://founder-auth-${randomUUID()}.example.invalid/`;
    const audience = 'founder-auth-api';
    const founderSubject = 'oidc|founder';
    const strangerSubject = 'oidc|stranger';
    const domain = `founder-${randomUUID()}.example.invalid`;
    const slug = `founder-auth-${randomUUID()}`;
    const keyId = 'founder-auth-key';
    const pair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = keyId;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
    const verifier: Verifier = {
      providerId,
      issuer,
      audience,
      keys,
      emailClaim: 'email',
      subjectClaim: 'sub',
      tenantClaim: null,
      scope: 'tenant',
    };
    const token = (subject: string) =>
      new SignJWT({
        sub: subject,
        email: `${subject.replaceAll('|', '-')}@${domain}`,
        email_verified: true,
      })
        .setProtectedHeader({ alg: 'RS256', kid: keyId })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(pair.privateKey);

    try {
      await admin.db.insert(identityProviders).values({
        id: providerId,
        displayName: 'Founder auth directory',
        issuer,
        jwksUri: `${issuer}.well-known/jwks.json`,
        authorizationEndpoint: `${issuer}authorize`,
        tokenEndpoint: `${issuer}token`,
        audience,
        browserClientId: 'founder-auth-browser',
        kind: 'oidc',
        scope: 'tenant',
        status: 'provisional',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await admin.db.insert(users).values({
        id: founderUserId,
        issuer,
        subject: founderSubject,
        email: `founder@${domain}`,
      });
      await admin.db.insert(workspaceFoundings).values({
        id: foundingId,
        path: 'own_directory',
        requestedName: 'Founder auth workspace',
        slug,
        providerId,
        founderUserId,
        declaredDomain: domain,
        status: 'founder_authenticated',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const auth: AuthDeps = {
        verifiers: {
          byIssuer: async (candidate) => {
            if (candidate !== issuer) return undefined;
            const [provider] = await app.db
              .select({ status: identityProviders.status })
              .from(identityProviders)
              .where(eq(identityProviders.id, providerId));
            return provider?.status === 'active' ? verifier : undefined;
          },
          forFounding: async (candidate) => (candidate === foundingId ? verifier : undefined),
          invalidate() {},
        },
        db: app.db,
        adminDb: admin.db,
        settings: { get: async () => 86_400 },
        revoke: { publish: async () => undefined },
      };
      const api = new Hono<{ Variables: AuthVariables }>();
      api.route(
        '/',
        meRoutes({
          auth,
          db: admin.db,
          limiter: { allow: async () => true },
          sourceAddress: () => '192.0.2.10',
        }),
      );
      api.route(
        '/',
        foundingRoutes({
          auth,
          db: admin.db,
          registrationMode: async () => 'approval_required',
          limiter: { allow: async () => true },
          sourceAddress: () => '192.0.2.10',
          oidc: {
            discover: async () => {
              throw new Error('not used');
            },
            checkDomain: async (candidateFoundingId, candidateUserId) =>
              candidateFoundingId === foundingId && candidateUserId === founderUserId
                ? { status: 'pending' }
                : null,
          },
        }),
      );
      api.get('/identity', requireUser(auth), (c) => c.json(c.get('user')));
      api.get('/product', authMiddleware(auth), (c) => c.json(c.get('tenant')));
      const founderAuthorization = { authorization: `Bearer ${await token(founderSubject)}` };
      const strangerAuthorization = { authorization: `Bearer ${await token(strangerSubject)}` };
      const founderOnboarding = {
        ...founderAuthorization,
        'x-onboarding-founding-id': foundingId,
      };
      const strangerOnboarding = {
        ...strangerAuthorization,
        'x-onboarding-founding-id': foundingId,
      };

      const resumed = await api.request('/me', { headers: founderOnboarding });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toMatchObject({
        state: 'founding',
        user: { id: founderUserId },
        founding: {
          id: foundingId,
          status: 'founder_authenticated',
          slug,
          requestedName: 'Founder auth workspace',
        },
        tenant: null,
      });

      const strangerResume = await api.request('/me', { headers: strangerOnboarding });
      expect(strangerResume.status).toBe(401);
      expect(await strangerResume.json()).toEqual({ error: 'invalid token' });
      expect(
        await admin.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.subject, strangerSubject)),
      ).toEqual([]);

      const strangerProduct = await api.request('/product', { headers: strangerAuthorization });
      expect(strangerProduct.status).toBe(401);
      const founderProduct = await api.request('/product', { headers: founderAuthorization });
      expect(founderProduct.status).toBe(401);

      await admin.db.insert(tenants).values({
        id: tenantId,
        name: 'Founder auth workspace',
        slug,
      });
      await admin.db
        .insert(tenantIdentityBindings)
        .values({ tenantId, providerId, claimValue: null });
      await admin.db.insert(memberships).values({ tenantId, userId: founderUserId, role: 'owner' });
      await admin.db.insert(identityProviderDomains).values({
        providerId,
        domain,
        status: 'pending',
        challenge: 'sre-platform-verify=founder-auth',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await admin.db
        .update(workspaceFoundings)
        .set({ status: 'active', tenantId })
        .where(eq(workspaceFoundings.id, foundingId));
      await admin.db
        .update(identityProviders)
        .set({ status: 'pending_verification', expiresAt: null })
        .where(eq(identityProviders.id, providerId));

      const pending = await api.request('/me', { headers: founderOnboarding });
      expect(pending.status).toBe(200);
      expect(await pending.json()).toMatchObject({
        state: 'active',
        tenant: { id: tenantId, role: 'owner' },
        domain: {
          domain,
          status: 'pending',
          challengeValue: 'sre-platform-verify=founder-auth',
          foundingId,
        },
        welcome: { shown: false, dismissed: false, domainVerified: false },
      });
      const domainCheck = await api.request(`/foundings/${foundingId}/check-domain`, {
        method: 'POST',
        headers: founderAuthorization,
      });
      expect(domainCheck.status).toBe(200);
      expect(await domainCheck.json()).toEqual({ status: 'pending' });
      expect(
        (
          await api.request(`/foundings/${foundingId}/check-domain`, {
            method: 'POST',
            headers: strangerAuthorization,
          })
        ).status,
      ).toBe(401);

      const shown = await api.request('/me/welcome/show', {
        method: 'POST',
        headers: founderOnboarding,
      });
      expect(shown.status).toBe(200);
      expect(await shown.json()).toEqual({ shown: true });
      const dismissed = await api.request('/me/welcome/dismiss', {
        method: 'POST',
        headers: founderOnboarding,
      });
      expect(dismissed.status).toBe(200);
      expect(await dismissed.json()).toEqual({ dismissed: true });

      const persisted = await api.request('/me', { headers: founderOnboarding });
      expect(await persisted.json()).toMatchObject({
        welcome: { shown: true, dismissed: true },
      });
      expect((await api.request('/product', { headers: founderAuthorization })).status).toBe(401);

      await admin.db
        .update(identityProviderDomains)
        .set({ status: 'verified', verifiedAt: new Date() })
        .where(eq(identityProviderDomains.providerId, providerId));
      await admin.db
        .update(identityProviders)
        .set({ status: 'active' })
        .where(eq(identityProviders.id, providerId));

      const activeMe = await api.request('/me', { headers: founderAuthorization });
      expect(activeMe.status).toBe(200);
      expect(await activeMe.json()).toMatchObject({ state: 'active', tenant: { id: tenantId } });
      const activeFounder = await api.request('/product', { headers: founderAuthorization });
      expect(activeFounder.status).toBe(200);
      expect(await activeFounder.json()).toMatchObject({
        tenantId,
        userId: founderUserId,
        role: 'owner',
      });
      const activeStranger = await api.request('/product', { headers: strangerAuthorization });
      expect(activeStranger.status).toBe(200);
      expect(await activeStranger.json()).toMatchObject({ tenantId, role: 'member' });
      expect((await api.request('/identity', { headers: strangerAuthorization })).status).toBe(200);
    } finally {
      await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
      await admin.db
        .delete(identityProviderDomains)
        .where(eq(identityProviderDomains.providerId, providerId));
      await admin.db
        .delete(tenantIdentityBindings)
        .where(eq(tenantIdentityBindings.providerId, providerId));
      await admin.db.delete(workspaceFoundings).where(eq(workspaceFoundings.id, foundingId));
      await admin.db.delete(users).where(eq(users.issuer, issuer));
      await admin.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
      await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  }, 30_000);

  test('uses the explicit founding selector when provisional providers share an issuer', async () => {
    const issuer = `https://shared-founder-auth-${randomUUID()}.example.invalid/`;
    const audience = 'shared-founder-auth-api';
    const pair = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = 'shared-founder-auth-key';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
    const attempts = [0, 1].map((index) => ({
      providerId: randomUUID(),
      foundingId: randomUUID(),
      founderUserId: randomUUID(),
      subject: `oidc|founder-${index}`,
      slug: `shared-founder-${randomUUID()}`,
    }));
    const verifier = (providerId: string): Verifier => ({
      providerId,
      issuer,
      audience,
      keys,
      emailClaim: 'email',
      subjectClaim: 'sub',
      tenantClaim: null,
      scope: 'tenant',
    });
    const token = (subject: string) =>
      new SignJWT({ sub: subject, email: `${subject.replaceAll('|', '-')}@example.test` })
        .setProtectedHeader({ alg: 'RS256', kid: 'shared-founder-auth-key' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(pair.privateKey);

    try {
      await admin.db.insert(identityProviders).values(
        attempts.map((attempt) => ({
          id: attempt.providerId,
          displayName: `Shared issuer ${attempt.slug}`,
          issuer,
          jwksUri: `${issuer}.well-known/jwks.json`,
          audience,
          kind: 'oidc' as const,
          scope: 'tenant' as const,
          status: 'provisional' as const,
          expiresAt: new Date(Date.now() + 60_000),
        })),
      );
      await admin.db.insert(users).values(
        attempts.map((attempt) => ({
          id: attempt.founderUserId,
          issuer,
          subject: attempt.subject,
          email: `${attempt.subject.replaceAll('|', '-')}@example.test`,
        })),
      );
      await admin.db.insert(workspaceFoundings).values(
        attempts.map((attempt) => ({
          id: attempt.foundingId,
          path: 'hosted' as const,
          requestedName: attempt.slug,
          slug: attempt.slug,
          providerId: attempt.providerId,
          founderUserId: attempt.founderUserId,
          status: 'founder_authenticated' as const,
          expiresAt: new Date(Date.now() + 60_000),
        })),
      );

      const auth: AuthDeps = {
        verifiers: {
          byIssuer: async () => undefined,
          forFounding: async (foundingId) => {
            const attempt = attempts.find((candidate) => candidate.foundingId === foundingId);
            return attempt ? verifier(attempt.providerId) : undefined;
          },
          invalidate() {},
        },
        db: app.db,
        adminDb: admin.db,
        settings: { get: async () => 86_400 },
        revoke: { publish: async () => undefined },
      };
      const api = new Hono<{ Variables: AuthVariables }>();
      api.route(
        '/',
        meRoutes({
          auth,
          db: admin.db,
          limiter: { allow: async () => true },
          sourceAddress: () => '192.0.2.11',
        }),
      );
      const tokens = await Promise.all(attempts.map((attempt) => token(attempt.subject)));

      for (const [index, attempt] of attempts.entries()) {
        const response = await api.request('/me', {
          headers: {
            authorization: `Bearer ${tokens[index]}`,
            'x-onboarding-founding-id': attempt.foundingId,
          },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          user: { id: attempt.founderUserId },
          founding: { id: attempt.foundingId },
        });
      }

      const crossed = await api.request('/me', {
        headers: {
          authorization: `Bearer ${tokens[0]}`,
          'x-onboarding-founding-id': attempts[1]!.foundingId,
        },
      });
      expect(crossed.status).toBe(401);
      expect(await crossed.json()).toEqual({ error: 'invalid token' });
    } finally {
      await admin.db
        .delete(workspaceFoundings)
        .where(eq(workspaceFoundings.providerId, attempts[0]!.providerId));
      await admin.db
        .delete(workspaceFoundings)
        .where(eq(workspaceFoundings.providerId, attempts[1]!.providerId));
      await admin.db.delete(users).where(eq(users.issuer, issuer));
      await admin.db.delete(identityProviders).where(eq(identityProviders.issuer, issuer));
    }
  }, 30_000);

  test.each([
    ['rate limited', { allow: async () => false }, 429],
    ['unavailable', undefined, 503],
  ] as const)(
    'does not look up a founding provider when onboarding auth is %s',
    async (_, limiter, status) => {
      const byIssuer = vi.fn(async () => undefined);
      const forFounding = vi.fn(async () => undefined);
      const auth = {
        verifiers: { byIssuer, forFounding, invalidate() {} },
        db: {} as AuthDeps['db'],
        adminDb: {} as AuthDeps['adminDb'],
        settings: { get: async () => 86_400 },
        revoke: { publish: async () => undefined },
      } satisfies AuthDeps;
      const api = new Hono<{ Variables: AuthVariables }>();
      api.route(
        '/',
        meRoutes({
          auth,
          db: {} as AuthDeps['db'],
          limiter,
          sourceAddress: () => '192.0.2.12',
        }),
      );
      const token = await new SignJWT({ sub: 'founder' })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer('https://rate-limited.example.invalid/')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign((await generateKeyPair('RS256')).privateKey);

      const response = await api.request('/me', {
        headers: {
          authorization: `Bearer ${token}`,
          'x-onboarding-founding-id': randomUUID(),
        },
      });

      expect(response.status).toBe(status);
      expect(byIssuer).not.toHaveBeenCalled();
      expect(forFounding).not.toHaveBeenCalled();
    },
  );
});
