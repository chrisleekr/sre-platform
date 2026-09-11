import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeDb, makeSecretStore, tenants, workspaceFoundings, type DbHandle } from '@sre/db';
import { makeApp, type AppDeps } from '../../app';

const marker = randomUUID();
const occupiedTenantId = randomUUID();
const occupiedSlug = `occupied-${marker}`;
const reservedSlug = `reserved-${marker}`;
const reservedRootSlug = 'w';
const secret = Buffer.alloc(32, 7).toString('base64');
let admin: DbHandle;
let appDb: DbHandle;

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  appDb = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({
    id: occupiedTenantId,
    name: 'Occupied workspace',
    slug: occupiedSlug,
  });
  await admin.db.insert(workspaceFoundings).values({
    path: 'own_directory',
    requestedName: 'Reserved workspace',
    slug: reservedSlug,
    status: 'awaiting_founder',
    expiresAt: new Date(Date.now() + 60_000),
  });
});

afterAll(async () => {
  if (!admin) return;
  await admin.db
    .delete(workspaceFoundings)
    .where(
      inArray(workspaceFoundings.slug, [reservedSlug, `personal-${marker}`, `closed-${marker}`]),
    );
  await admin.db.delete(tenants).where(eq(tenants.id, occupiedTenantId));
  await Promise.all([admin.close(), appDb.close()]);
});

function application(mode: 'open' | 'approval_required' | 'closed' = 'closed') {
  const deps: AppDeps & {
    publicSite: { supportUrl: string; termsUrl: string; termsVersion: string };
  } = {
    auth: { adminDb: admin.db } as AppDeps['auth'],
    readinessDb: appDb.db,
    appDb: appDb.db,
    adminDb: admin.db,
    secrets: makeSecretStore(appDb.db, secret),
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
    publicRateLimiter: { allow: async () => true },
    publicSourceAddress: () => '203.0.113.20',
    registrationMode: (async () => mode) as unknown as NonNullable<AppDeps['registrationMode']>,
    publicSite: {
      supportUrl: 'https://support.example.test/help',
      termsUrl: 'https://legal.example.test/terms',
      termsVersion: '2026-09',
    },
  };
  return makeApp(deps);
}

describe('dashboard public onboarding contract', () => {
  test.each([[occupiedSlug], [reservedSlug]])(
    'reports unavailable address %s without exposing a conflicting record',
    async (slug) => {
      const response = await application().request(`/workspace-addresses/${slug}/availability`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        available: false,
        code: 'workspace_address_taken',
      });
    },
  );

  test('rejects a reserved root route before availability or founding persistence', async () => {
    const availability = await application('open').request(
      `/workspace-addresses/${reservedRootSlug}/availability`,
    );
    expect(availability.status).toBe(400);
    expect(await availability.json()).toEqual({
      available: false,
      code: 'invalid_workspace_address',
    });

    const creation = await application('open').request('/foundings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'own_directory',
        requestedName: 'Reserved root workspace',
        slug: reservedRootSlug,
      }),
    });
    expect(creation.status).toBe(400);
    expect(await creation.json()).toEqual({
      error: 'valid own-directory workspace details are required',
      code: 'invalid_workspace',
    });
    expect(
      await admin.db
        .select({ id: workspaceFoundings.id })
        .from(workspaceFoundings)
        .where(eq(workspaceFoundings.slug, reservedRootSlug)),
    ).toEqual([]);
    expect(
      await admin.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, reservedRootSlug)),
    ).toEqual([]);
  });

  test('returns a stable server-owned error for a public-mail founding domain', async () => {
    const response = await application('open').request('/foundings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'own_directory',
        requestedName: 'Personal workspace',
        slug: `personal-${marker}`,
        issuer: 'https://accounts.example.test',
        clientId: 'browser-client',
        apiAudience: 'sre-api',
        declaredDomain: 'gmail.com',
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'use your organisation email domain',
      code: 'public_email_domain',
    });
  });

  test('projects closed registration and optional public support and terms metadata', async () => {
    const response = await application().request('/public-config');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      registrationMode: 'closed',
      supportUrl: 'https://support.example.test/help',
      termsUrl: 'https://legal.example.test/terms',
      termsVersion: '2026-09',
    });
  });

  test('rejects workspace creation before persistence while registration is closed', async () => {
    const response = await application().request('/foundings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'own_directory',
        requestedName: 'Closed workspace',
        slug: `closed-${marker}`,
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'workspace registration is closed',
      code: 'registration_closed',
    });
    expect(
      await admin.db
        .select({ id: workspaceFoundings.id })
        .from(workspaceFoundings)
        .where(eq(workspaceFoundings.slug, `closed-${marker}`)),
    ).toEqual([]);
  });
});
