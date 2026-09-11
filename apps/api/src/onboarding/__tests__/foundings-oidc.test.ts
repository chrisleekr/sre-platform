import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import {
  getWorkspaceAddressAvailability,
  identityProviders,
  makeDb,
  users,
  workspaceFoundings,
  type DbHandle,
} from '@sre/db';
import type { AuthDeps } from '../../auth';
import { foundingRoutes } from '../foundings';
import { OidcDiscoveryError } from '../oidc-discovery';

const marker = randomUUID();
const declaredDomain = `${marker}.example.test`;
const issuer = `https://directory-${marker}.example.test`;
const clientId = `browser-${marker}`;
const apiAudience = `https://api-${marker}.sre.example`;
const metadata = {
  issuer,
  authorizationEndpoint: `${issuer}/authorize`,
  tokenEndpoint: `${issuer}/token`,
  jwksUri: `${issuer}/jwks`,
};
let db: DbHandle;

const auth = {
  verifiers: {
    byIssuer: async () => undefined,
    forFounding: async () => undefined,
    invalidate() {},
  },
} as unknown as AuthDeps;

function app(overrides: Record<string, unknown> = {}) {
  const discover = vi.fn(async () => metadata);
  const routes = foundingRoutes({
    auth,
    db: db.db,
    registrationMode: async () => 'approval_required',
    limiter: { allow: async () => true },
    sourceAddress: () => '203.0.113.10',
    oidc: { discover, ...overrides },
  } as never);
  return { api: new Hono().route('/', routes), discover };
}

function create(api: Hono, body: Record<string, unknown>) {
  return api.request('/foundings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  db = makeDb(process.env.DATABASE_URL!);
});

afterAll(async () => {
  if (!db) return;
  const providers = await db.db
    .select({ id: identityProviders.id, issuer: identityProviders.issuer })
    .from(identityProviders)
    .where(eq(identityProviders.browserClientId, clientId));
  await db.db
    .delete(workspaceFoundings)
    .where(eq(workspaceFoundings.declaredDomain, declaredDomain));
  await db.db.delete(users).where(eq(users.issuer, issuer));
  if (providers.length > 0) {
    await db.db.delete(identityProviders).where(
      inArray(
        identityProviders.id,
        providers.map((p) => p.id),
      ),
    );
  }
  await db.close();
});

describe('own-directory OIDC founding', () => {
  test('reclaims only the requested expired reservation when a new setup is submitted', async () => {
    const { api } = app();
    const slug = `restart-${marker}`;
    const unrelated = `unrelated-${marker}`;
    const input = {
      path: 'own_directory',
      requestedName: 'Restart',
      slug,
      declaredDomain,
      issuer,
      clientId,
      apiAudience,
    };
    expect((await create(api, input)).status).toBe(201);
    expect((await create(api, { ...input, slug: unrelated })).status).toBe(201);
    expect((await create(api, input)).status).toBe(409);
    await db.db
      .update(workspaceFoundings)
      .set({ expiresAt: new Date(0) })
      .where(inArray(workspaceFoundings.slug, [slug, unrelated]));
    expect(await getWorkspaceAddressAvailability(db.db, slug)).toEqual({ available: true });
    expect((await create(api, input)).status).toBe(201);
    const records = await db.db
      .select({ slug: workspaceFoundings.slug, status: workspaceFoundings.status })
      .from(workspaceFoundings)
      .where(inArray(workspaceFoundings.slug, [slug, unrelated]));
    expect(
      records
        .filter((row) => row.slug === slug)
        .map((row) => row.status)
        .sort(),
    ).toEqual(['awaiting_founder', 'expired']);
    expect(records.find((row) => row.slug === unrelated)?.status).toBe('awaiting_founder');
    expect(await getWorkspaceAddressAvailability(db.db, slug)).toMatchObject({ available: false });
  });

  test('discovers metadata through the bounded public route and enforces its dependencies', async () => {
    const { api, discover } = app();
    const response = await api.request('/foundings/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issuer }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: metadata });
    expect(discover).toHaveBeenCalledWith(issuer);

    const unavailable = foundingRoutes({
      auth,
      db: db.db,
      registrationMode: async () => 'approval_required',
    });
    expect(
      (
        await new Hono().route('/', unavailable).request('/foundings/discover', {
          method: 'POST',
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await app({}).api.request('/foundings/discover', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(400);
  });

  test('atomically creates one provisional provider and linked one-hour founding', async () => {
    const { api, discover } = app();
    const response = await create(api, {
      path: 'own_directory',
      slug: `oidc-${marker}`,
      requestedName: 'OIDC workspace',
      declaredDomain,
      issuer,
      clientId,
      apiAudience,
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      founding: { id: string; expiresAt: string };
      provider: Record<string, unknown>;
    };
    expect(discover).toHaveBeenCalledWith(issuer);
    expect(body.provider).toMatchObject({
      issuer,
      authorizationEndpoint: metadata.authorizationEndpoint,
      browserClientId: clientId,
    });
    expect(body.provider).not.toHaveProperty('jwksUri');
    expect(body.provider).not.toHaveProperty('tokenEndpoint');
    const rows = await db.db
      .select({ founding: workspaceFoundings, provider: identityProviders })
      .from(workspaceFoundings)
      .innerJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
      .where(eq(workspaceFoundings.id, body.founding.id));
    expect(rows[0]).toMatchObject({
      founding: { status: 'awaiting_founder', declaredDomain },
      provider: {
        issuer,
        status: 'provisional',
        audience: apiAudience,
        browserClientId: clientId,
        tokenEndpoint: metadata.tokenEndpoint,
        jwksUri: metadata.jwksUri,
      },
    });
    expect(rows[0]!.provider.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test('rolls back the provider when the founding address conflicts', async () => {
    const conflictingIssuer = `https://conflict-${marker}.example.test`;
    const { api } = app({
      discover: async () => ({
        ...metadata,
        issuer: conflictingIssuer,
        authorizationEndpoint: `${conflictingIssuer}/authorize`,
        tokenEndpoint: `${conflictingIssuer}/token`,
        jwksUri: `${conflictingIssuer}/jwks`,
      }),
    });
    const response = await create(api, {
      path: 'own_directory',
      slug: `oidc-${marker}`,
      requestedName: 'Duplicate',
      declaredDomain,
      issuer: conflictingIssuer,
      clientId,
      apiAudience,
    });

    expect(response.status).toBe(409);
    expect(
      await db.db
        .select()
        .from(identityProviders)
        .where(eq(identityProviders.issuer, conflictingIssuer)),
    ).toEqual([]);
  });

  test('maps rejected discovery to a bounded 400 and stores nothing', async () => {
    const rejectedIssuer = `https://rejected-${marker}.example.test`;
    const { api } = app({
      discover: async () => {
        throw new OidcDiscoveryError('unsafe_issuer', 'issuer is not reachable from here');
      },
    });
    const response = await create(api, {
      path: 'own_directory',
      slug: `oidc-${marker}-rejected`,
      requestedName: 'Rejected discovery',
      declaredDomain,
      issuer: rejectedIssuer,
      clientId,
      apiAudience,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'directory_unreachable' });
    expect(
      await db.db
        .select()
        .from(identityProviders)
        .where(eq(identityProviders.issuer, rejectedIssuer)),
    ).toEqual([]);
  });

  test.each(['complete-auth', 'continue-auth'])(
    'does not return upstream credentials through %s',
    async (operation) => {
      const { api } = app();
      expect(
        (await api.request(`/foundings/${randomUUID()}/${operation}`, { method: 'POST' })).status,
      ).toBe(404);
    },
  );
});
