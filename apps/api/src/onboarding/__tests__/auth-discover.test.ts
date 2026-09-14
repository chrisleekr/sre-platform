import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  identityProviderDomains,
  identityProviders,
  makeDb,
  makeSecretStore,
  tenantIdentityBindings,
  tenants,
  type Db,
  type DbHandle,
} from '@sre/db';
import { makeApp, type AppDeps } from '../../app';
import { authDiscoveryRoutes } from '../auth-discover';

const marker = randomUUID();
const tenantId = randomUUID();
const directoryId = randomUUID();
const pendingId = randomUUID();
const signupId = randomUUID();
const incompleteDirectoryId = randomUUID();
const incompleteSignupId = randomUUID();
const localId = randomUUID();
const secret = Buffer.alloc(32, 4).toString('base64');
let admin: DbHandle;
let appDb: DbHandle;

function provider(id: string, name: string, scope: 'tenant' | 'installation', signup = false) {
  return {
    id,
    displayName: name,
    issuer: `https://${name.toLowerCase()}-${marker}.invalid`,
    jwksUri: `https://${name.toLowerCase()}-${marker}.invalid/jwks`,
    authorizationEndpoint: `https://${name.toLowerCase()}-${marker}.invalid/authorize`,
    browserClientId: `${name.toLowerCase()}-browser`,
    audience: 'sre-api',
    kind: 'oidc' as const,
    scope,
    supportsSignup: signup,
    status: 'active' as const,
  };
}

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  appDb = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({
    id: tenantId,
    name: 'Discovery workspace',
    slug: `discovery-${marker}`,
    status: 'suspended',
  });
  await admin.db.insert(identityProviders).values([
    provider(directoryId, 'Directory', 'tenant'),
    provider(pendingId, 'Pending', 'tenant'),
    provider(signupId, 'Signup', 'installation', true),
    {
      ...provider(incompleteDirectoryId, 'Incomplete directory', 'tenant'),
      authorizationEndpoint: null,
    },
    {
      ...provider(incompleteSignupId, 'Incomplete signup', 'installation', true),
      browserClientId: null,
    },
    {
      ...provider(localId, 'Local', 'tenant'),
      authorizationEndpoint: null,
      browserClientId: null,
      kind: 'local' as const,
    },
  ]);
  await admin.db.insert(identityProviderDomains).values([
    { providerId: directoryId, domain: `verified-${marker}.test`, status: 'verified' },
    { providerId: pendingId, domain: `pending-${marker}.test`, status: 'pending' },
    {
      providerId: incompleteDirectoryId,
      domain: `incomplete-${marker}.test`,
      status: 'verified',
    },
  ]);
  await admin.db.insert(tenantIdentityBindings).values(
    [directoryId, incompleteDirectoryId, localId].map((providerId) => ({
      tenantId,
      providerId,
      claimValue: null,
    })),
  );
});

afterAll(async () => {
  if (!admin) return;
  await admin.db
    .delete(tenantIdentityBindings)
    .where(eq(tenantIdentityBindings.tenantId, tenantId));
  await admin.db
    .delete(identityProviderDomains)
    .where(
      inArray(identityProviderDomains.providerId, [directoryId, pendingId, incompleteDirectoryId]),
    );
  await admin.db
    .delete(identityProviders)
    .where(
      inArray(identityProviders.id, [
        directoryId,
        pendingId,
        signupId,
        incompleteDirectoryId,
        incompleteSignupId,
        localId,
      ]),
    );
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await Promise.all([admin.close(), appDb.close()]);
});

function application(limiter: AppDeps['publicRateLimiter']) {
  return makeApp({
    auth: {} as AppDeps['auth'],
    readinessDb: appDb.db,
    appDb: appDb.db,
    secrets: makeSecretStore(appDb.db, secret),
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
    publicRateLimiter: limiter,
    publicSourceAddress: () => '203.0.113.10',
  });
}

function discover(api: ReturnType<typeof makeApp>, email: string) {
  return api.request('/auth/discover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

describe('public sign-in discovery', () => {
  test('routes returning users through an installation provider even when signup is disabled', async () => {
    await admin.db
      .update(identityProviders)
      .set({ supportsSignup: false })
      .where(eq(identityProviders.id, signupId));
    try {
      expect(
        await (
          await discover(application({ allow: async () => true }), 'person@unknown.test')
        ).json(),
      ).toMatchObject({ kind: 'installation', provider: { id: signupId } });
    } finally {
      await admin.db
        .update(identityProviders)
        .set({ supportsSignup: true })
        .where(eq(identityProviders.id, signupId));
    }
  });

  test('asks for a provider choice instead of selecting an arbitrary shared provider', async () => {
    const alternate = randomUUID();
    await admin.db
      .insert(identityProviders)
      .values(provider(alternate, 'Alternate', 'installation'));
    try {
      const api = application({ allow: async () => true });
      const choices = await (await discover(api, 'person@unknown.test')).json();
      expect(choices).toMatchObject({
        kind: 'choose_provider',
        providers: expect.arrayContaining([
          expect.objectContaining({ id: alternate }),
          expect.objectContaining({ id: signupId }),
        ]),
      });
      expect(choices).toHaveProperty('providers.length', 2);
      expect(await (await discover(api, `person@verified-${marker}.test`)).json()).toMatchObject({
        kind: 'directory',
        provider: { id: directoryId },
      });
    } finally {
      await admin.db.delete(identityProviders).where(eq(identityProviders.id, alternate));
    }
  });

  test('prefers a verified directory and never matches a pending domain', async () => {
    const api = application({ allow: async () => true });
    const directory = await discover(api, `person@verified-${marker}.test`);
    expect(directory.status).toBe(200);
    expect(await directory.json()).toMatchObject({
      kind: 'directory',
      provider: { id: directoryId, displayName: 'Directory' },
    });
    const pending = await discover(api, `person@pending-${marker}.test`);
    expect(await pending.json()).toMatchObject({ kind: 'signup', provider: { id: signupId } });
  });

  test('returns unknown when neither a directory nor signup provider is active', async () => {
    await admin.db
      .update(identityProviders)
      .set({ status: 'disabled' })
      .where(eq(identityProviders.id, signupId));
    try {
      expect(
        await (
          await discover(application({ allow: async () => true }), 'person@unknown.test')
        ).json(),
      ).toEqual({ kind: 'unknown' });
    } finally {
      await admin.db
        .update(identityProviders)
        .set({ status: 'active' })
        .where(eq(identityProviders.id, signupId));
    }
  });

  test('skips incomplete directory and signup providers during email discovery', async () => {
    const incompleteDirectory = await discover(
      application({ allow: async () => true }),
      `person@incomplete-${marker}.test`,
    );
    expect(await incompleteDirectory.json()).toMatchObject({
      kind: 'signup',
      provider: { id: signupId },
    });

    await admin.db
      .update(identityProviders)
      .set({ status: 'disabled' })
      .where(eq(identityProviders.id, signupId));
    try {
      expect(
        await (
          await discover(application({ allow: async () => true }), 'person@unknown.test')
        ).json(),
      ).toEqual({ kind: 'unknown' });
    } finally {
      await admin.db
        .update(identityProviders)
        .set({ status: 'active' })
        .where(eq(identityProviders.id, signupId));
    }
  });

  test('rejects the twenty-first request from one source address', async () => {
    let calls = 0;
    const api = application({ allow: async () => ++calls <= 20 });
    for (let index = 0; index < 20; index++) {
      expect((await discover(api, `person-${index}@unknown.test`)).status).toBe(200);
    }
    expect((await discover(api, 'blocked@unknown.test')).status).toBe(429);
  });

  test('rejects an oversized discovery body before rate-limit or database work', async () => {
    const allow = vi.fn(async () => true);
    const api = application({ allow });
    const response = await api.request('/auth/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${'x'.repeat(1100)}@example.test` }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload too large' });
    expect(allow).not.toHaveBeenCalled();

    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"email":"'));
        controller.enqueue(encoder.encode('x'.repeat(1100)));
        controller.enqueue(encoder.encode('@example.test"}'));
        controller.close();
      },
    });
    const streamed = await api.request(
      new Request('http://localhost/auth/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(allow).not.toHaveBeenCalled();
  });

  test('returns active sign-in metadata and suspended workspace status without secrets', async () => {
    const response = await application({ allow: async () => true }).request(
      `/workspaces/discovery-${marker}/sign-in-methods`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      workspace: { id: tenantId, status: 'suspended' },
      methods: [{ providerId: directoryId, displayName: 'Directory' }],
    });
    expect(JSON.stringify(body)).not.toMatch(/jwks|secret/i);
    expect(body).toMatchObject({
      methods: [{ authorizationScopes: [], authorizationAudience: null }],
    });
  });

  test('returns zero workspace methods when bindings are only local or browser-incomplete', async () => {
    await admin.db
      .update(identityProviders)
      .set({ status: 'disabled' })
      .where(eq(identityProviders.id, directoryId));
    try {
      const response = await application({ allow: async () => true }).request(
        `/workspaces/discovery-${marker}/sign-in-methods`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ methods: [] });
    } finally {
      await admin.db
        .update(identityProviders)
        .set({ status: 'active' })
        .where(eq(identityProviders.id, directoryId));
    }
  });
});

// A workspace address in a public URL is attacker-supplied. The sign-in-methods route answers it
// unauthenticated, so it owes the same address contract and the same request budget as the
// availability route beside it.
describe('public workspace sign-in methods', () => {
  const unavailableDb = (): Db =>
    ({
      select: vi.fn(() => {
        throw new Error('database must not be called');
      }),
    }) as unknown as Db;

  const permissive = () => ({
    limiter: { allow: vi.fn(async () => true) },
    sourceAddress: vi.fn(() => '203.0.113.20'),
  });

  test.each([
    { name: 'a reserved address', slug: 'settings' },
    { name: 'an address with an illegal character', slug: 'acme_corp' },
    { name: 'an address that starts with a separator', slug: '-acme' },
  ])('refuses $name before reading the workspace', async ({ slug }) => {
    const db = unavailableDb();
    const response = await authDiscoveryRoutes({ db, ...permissive() }).request(
      `/workspaces/${slug}/sign-in-methods`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_workspace_address' });
    expect(db.select).not.toHaveBeenCalled();
  });

  test('a well-formed address still answers with the workspace or with not found', async () => {
    const api = application({ allow: async () => true });

    const found = await api.request(`/workspaces/discovery-${marker}/sign-in-methods`);
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({
      workspace: { id: tenantId, status: 'suspended' },
      methods: [{ providerId: directoryId, displayName: 'Directory' }],
    });

    const missing = await api.request(`/workspaces/absent-${marker}/sign-in-methods`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'workspace_not_found' });
  });

  test('sign-in method discovery spends its own request budget, not the address-availability one', async () => {
    // Declared with the limiter's real parameters so the recorded scope argument is readable here.
    const allow = vi.fn(
      async (_scope: string, _source: string, _limit: number, _windowMs: number) => false,
    );
    const sourceAddress = vi.fn(() => '203.0.113.20');
    const routes = () =>
      authDiscoveryRoutes({ db: unavailableDb(), limiter: { allow }, sourceAddress });

    expect((await routes().request(`/workspaces/acme-${marker}/sign-in-methods`)).status).toBe(429);
    expect(
      (await routes().request(`/workspace-addresses/acme-${marker}/availability`)).status,
    ).toBe(429);

    expect(allow).toHaveBeenCalledTimes(2);
    expect(allow.mock.calls[0]?.[0]).toBe('workspace-sign-in-methods');
    expect(allow.mock.calls[0]?.[1]).toBe('203.0.113.20');
    expect(allow.mock.calls[1]?.[0]).toBe('workspace-address-availability');
  });
});
