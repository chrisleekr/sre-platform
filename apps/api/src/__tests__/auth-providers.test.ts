import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { identityProviders, makeDb, workspaceFoundings, type Db, type DbHandle } from '@sre/db';
import type { JWTVerifyGetKey } from 'jose';
import { makeProviderVerifiers } from '../auth/providers';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const MARKER = `provider-verifier-${randomUUID()}`;

let admin: DbHandle;
let app: DbHandle;

function providerValues(overrides: Partial<typeof identityProviders.$inferInsert> = {}) {
  const id = overrides.id ?? randomUUID();
  const issuer = overrides.issuer ?? `https://${id}.provider.invalid/`;
  return {
    id,
    displayName: `${MARKER}-${id}`,
    issuer,
    jwksUri: `${issuer}.well-known/jwks.json`,
    audience: `audience-${id}`,
    kind: 'oidc' as const,
    scope: 'installation' as const,
    supportsSignup: false,
    emailClaim: 'email',
    subjectClaim: 'sub',
    tenantClaim: 'organization_id',
    status: 'active' as const,
    ...overrides,
  };
}

function providerDb(
  load: () => Promise<(typeof identityProviders.$inferSelect)[]>,
  lookup: () => Promise<(typeof identityProviders.$inferSelect)[]> = async () => [],
) {
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => {
          const query = load() as Promise<(typeof identityProviders.$inferSelect)[]> & {
            limit: typeof lookup;
          };
          query.limit = lookup;
          return query;
        },
      }),
    }),
  }));
  return { db: { select } as unknown as Db, select };
}

beforeAll(() => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await admin.sql`
    delete from workspace_foundings
    where provider_id in (select id from identity_providers where display_name like ${`${MARKER}%`})
  `;
  await admin.sql`delete from identity_providers where display_name like ${`${MARKER}%`}`;
});

afterAll(async () => {
  if (app) await app.close();
  if (admin) await admin.close();
});

describe('database-backed provider verifiers', () => {
  test('ordinary verification exposes only an exact active issuer while founding lookup remains isolated', async () => {
    const active = providerValues();
    const provisional = providerValues({
      status: 'provisional',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const disabled = providerValues({ status: 'disabled' });
    await admin.db.insert(identityProviders).values([active, provisional, disabled]);
    const foundingId = randomUUID();
    await admin.db.insert(workspaceFoundings).values({
      id: foundingId,
      path: 'hosted',
      slug: `provider-test-${foundingId}`,
      requestedName: 'Provider verifier test',
      providerId: provisional.id,
      status: 'founder_authenticated',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const verifiers = makeProviderVerifiers(app.db);

    await expect(verifiers.byIssuer(active.issuer)).resolves.toMatchObject({
      providerId: active.id,
      issuer: active.issuer,
      audience: active.audience,
    });
    await expect(verifiers.byIssuer(provisional.issuer)).resolves.toBeUndefined();
    await expect(verifiers.byIssuer(disabled.issuer)).resolves.toBeUndefined();
    await expect(verifiers.byIssuer('https://unknown.provider.invalid/')).resolves.toBeUndefined();
    await expect(verifiers.forFounding(foundingId)).resolves.toMatchObject({
      providerId: provisional.id,
      issuer: provisional.issuer,
    });
  });

  test('resolves back-channel keys only for the exact active opted-in browser client', async () => {
    const enabled = providerValues({
      backchannelLogout: true,
      backchannelLogoutTypRequired: true,
      browserClientId: 'logout-client',
    });
    const disabled = providerValues({
      backchannelLogout: false,
      browserClientId: 'disabled-client',
    });
    const inactive = providerValues({
      backchannelLogout: true,
      browserClientId: 'inactive-client',
      status: 'disabled',
    });
    await admin.db.insert(identityProviders).values([enabled, disabled, inactive]);
    const verifiers = makeProviderVerifiers(app.db);

    await expect(verifiers.byId!(enabled.id)).resolves.toMatchObject({
      id: enabled.id,
      issuer: enabled.issuer,
      browserClientId: 'logout-client',
      enabled: true,
      typRequired: true,
    });
    await expect(verifiers.byId!(disabled.id)).resolves.toBeUndefined();
    await expect(verifiers.byId!(inactive.id)).resolves.toBeUndefined();
    await expect(verifiers.byId!(randomUUID())).resolves.toBeUndefined();
  });

  test('observes provider changes after the bounded TTL and immediately after invalidation', async () => {
    const first = providerValues();
    const second = providerValues();
    await admin.db.insert(identityProviders).values([first, second]);
    const initialNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(initialNow);
    const verifiers = makeProviderVerifiers(app.db, { ttlMs: 25 });

    const cachedFirst = await verifiers.byIssuer(first.issuer);
    const cachedSecond = await verifiers.byIssuer(second.issuer);
    await admin.db
      .update(identityProviders)
      .set({ audience: 'audience-after-update' })
      .where(eq(identityProviders.id, first.id));
    await admin.db
      .update(identityProviders)
      .set({ audience: 'audience-after-invalidate' })
      .where(eq(identityProviders.id, second.id));

    expect((await verifiers.byIssuer(first.issuer))?.audience).toBe(first.audience);
    expect((await verifiers.byIssuer(second.issuer))?.audience).toBe(second.audience);
    now.mockReturnValue(initialNow + 26);
    const refreshedFirst = await verifiers.byIssuer(first.issuer);
    expect(refreshedFirst?.audience).toBe('audience-after-update');

    verifiers.invalidate();
    const refreshedSecond = await verifiers.byIssuer(second.issuer);
    expect(refreshedSecond?.audience).toBe('audience-after-invalidate');
    expect(refreshedFirst?.keys).toBe(cachedFirst?.keys);
    expect(refreshedSecond?.keys).toBe(cachedSecond?.keys);
  });

  test('bounds exact provider lookups across arbitrary unknown issuers', async () => {
    const row = providerValues() as typeof identityProviders.$inferSelect;
    const releases: Array<(rows: (typeof identityProviders.$inferSelect)[]) => void> = [];
    const source = providerDb(
      async () => [row],
      () =>
        new Promise<(typeof identityProviders.$inferSelect)[]>((resolve) => {
          releases.push(resolve);
        }),
    );
    const verifiers = makeProviderVerifiers(source.db);

    const requests = Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        verifiers.byIssuer(`https://untrusted-${index}.invalid/`),
      ),
    );

    await vi.waitFor(() => expect(releases).toHaveLength(8));
    expect(source.select).toHaveBeenCalledTimes(9);
    for (const release of releases) release([]);
    await requests;
    await expect(verifiers.byIssuer(row.issuer)).resolves.toMatchObject({ providerId: row.id });
    expect(source.select).toHaveBeenCalledTimes(9);
  });

  test('deduplicates concurrent exact lookups for one missing issuer', async () => {
    let release!: (rows: (typeof identityProviders.$inferSelect)[]) => void;
    const source = providerDb(
      async () => [],
      () =>
        new Promise<(typeof identityProviders.$inferSelect)[]>((resolve) => {
          release = resolve;
        }),
    );
    const verifiers = makeProviderVerifiers(source.db);

    const requests = Promise.all(
      Array.from({ length: 100 }, () =>
        verifiers.byIssuer('https://same-unknown.provider.invalid/'),
      ),
    );

    await vi.waitFor(() => expect(source.select).toHaveBeenCalledTimes(2));
    release([]);
    await expect(requests).resolves.toEqual(Array.from({ length: 100 }, () => undefined));
    expect(source.select).toHaveBeenCalledTimes(2);
  });

  test('observes a pending provider becoming active immediately across verifier replicas', async () => {
    const provider = providerValues({ status: 'pending_verification' });
    await admin.db.insert(identityProviders).values(provider);
    const firstReplica = makeProviderVerifiers(app.db);
    const secondReplica = makeProviderVerifiers(app.db);

    await expect(firstReplica.byIssuer(provider.issuer)).resolves.toBeUndefined();
    await expect(secondReplica.byIssuer(provider.issuer)).resolves.toBeUndefined();

    await admin.db
      .update(identityProviders)
      .set({ status: 'active' })
      .where(eq(identityProviders.id, provider.id));

    await expect(firstReplica.byIssuer(provider.issuer)).resolves.toMatchObject({
      providerId: provider.id,
    });
    await expect(secondReplica.byIssuer(provider.issuer)).resolves.toMatchObject({
      providerId: provider.id,
    });
  });

  test('resolves providers beyond the 256-entry LRU without another inventory query', async () => {
    const rows = Array.from({ length: 300 }, () =>
      providerValues({ jwksUri: `https://${randomUUID()}.provider.invalid/jwks` }),
    ) as (typeof identityProviders.$inferSelect)[];
    const source = providerDb(async () => rows);
    const verifiers = makeProviderVerifiers(source.db);

    const firstKeys = (await verifiers.byIssuer(rows[0]!.issuer))?.keys;
    for (const row of rows.slice(1, 257)) {
      await expect(verifiers.byIssuer(row.issuer)).resolves.toMatchObject({ providerId: row.id });
    }
    await expect(verifiers.byIssuer(rows[299]!.issuer)).resolves.toMatchObject({
      providerId: rows[299]!.id,
    });
    expect((await verifiers.byIssuer(rows[0]!.issuer))?.keys).not.toBe(firstKeys);
    expect(source.select).toHaveBeenCalledTimes(1);
  });

  test('preserves a provider fetch cooldown when its resolver is evicted', async () => {
    const rows = Array.from({ length: 257 }, () =>
      providerValues(),
    ) as (typeof identityProviders.$inferSelect)[];
    const source = providerDb(async () => rows);
    const fetchJwks = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchJwks);

    try {
      const verifiers = makeProviderVerifiers(source.db);
      const first = await verifiers.byIssuer(rows[0]!.issuer);
      await expect(
        first!.keys({ alg: 'RS256', kid: 'missing' }, { payload: '', signature: '' }),
      ).rejects.toThrow();
      expect(fetchJwks).toHaveBeenCalledTimes(1);

      for (const row of rows.slice(1)) await verifiers.byIssuer(row.issuer);
      const recreated = await verifiers.byIssuer(rows[0]!.issuer);
      expect(recreated!.keys).not.toBe(first!.keys);
      await expect(
        recreated!.keys({ alg: 'RS256', kid: 'missing' }, { payload: '', signature: '' }),
      ).rejects.toThrow('JWKS fetch is cooling down');
      expect(fetchJwks).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('bounds concurrent JWKS fetches across providers', async () => {
    const rows = Array.from({ length: 9 }, () =>
      providerValues(),
    ) as (typeof identityProviders.$inferSelect)[];
    const source = providerDb(async () => rows);
    const releases: Array<(response: Response) => void> = [];
    const fetchJwks = vi.fn(() => new Promise<Response>((resolve) => releases.push(resolve)));
    vi.stubGlobal('fetch', fetchJwks);

    try {
      const verifiers = makeProviderVerifiers(source.db);
      const attempts = rows.map(async (row) => {
        const verifier = await verifiers.byIssuer(row.issuer);
        try {
          await verifier!.keys({ alg: 'RS256', kid: 'missing' }, { payload: '', signature: '' });
          return undefined;
        } catch (error) {
          return error;
        }
      });

      await vi.waitFor(() => expect(fetchJwks).toHaveBeenCalledTimes(8));
      await expect(attempts[8]).resolves.toMatchObject({
        message: 'JWKS fetch concurrency limit reached',
      });
      for (const release of releases) {
        release(
          new Response(JSON.stringify({ keys: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      await Promise.all(attempts);
      expect(fetchJwks).toHaveBeenCalledTimes(8);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('resolves an active local provider only through its injected key set', async () => {
    const row = providerValues({
      kind: 'local',
      scope: 'tenant',
      tenantClaim: null,
      issuer: `urn:sre-platform:test-local:${randomUUID()}`,
      jwksUri: `urn:sre-platform:test-local-jwks:${randomUUID()}`,
    }) as typeof identityProviders.$inferSelect;
    const localKeys = vi.fn() as unknown as JWTVerifyGetKey;
    const configured = providerDb(async () => [row]);
    const unconfigured = providerDb(async () => [row]);

    await expect(
      makeProviderVerifiers(unconfigured.db).byIssuer(row.issuer),
    ).resolves.toBeUndefined();
    await expect(
      makeProviderVerifiers(configured.db, {
        local: { issuer: row.issuer, keys: localKeys },
      }).byIssuer(row.issuer),
    ).resolves.toMatchObject({ providerId: row.id, keys: localKeys });
  });

  test('an invalidation racing an in-flight refresh cannot publish stale data', async () => {
    const stale = providerValues() as typeof identityProviders.$inferSelect;
    const current = { ...stale, audience: 'audience-after-race' };
    let releaseFirst!: (rows: (typeof identityProviders.$inferSelect)[]) => void;
    const first = new Promise<(typeof identityProviders.$inferSelect)[]>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const source = providerDb(async () => {
      calls += 1;
      return calls === 1 ? first : [current];
    });
    const verifiers = makeProviderVerifiers(source.db);

    const pending = verifiers.byIssuer(stale.issuer);
    expect(source.select).toHaveBeenCalledTimes(1);
    verifiers.invalidate();
    releaseFirst([stale]);

    await expect(pending).resolves.toMatchObject({ audience: 'audience-after-race' });
    expect(source.select).toHaveBeenCalledTimes(2);
  });

  test('does not reuse key sources when a provider changes kind with the same JWKS URI', async () => {
    const oidc = providerValues() as typeof identityProviders.$inferSelect;
    const localKeys = vi.fn() as unknown as JWTVerifyGetKey;
    let current = oidc;
    const source = providerDb(async () => [current]);
    const verifiers = makeProviderVerifiers(source.db, {
      local: { issuer: oidc.issuer, keys: localKeys },
    });

    const remoteKeys = (await verifiers.byIssuer(oidc.issuer))?.keys;
    expect(remoteKeys).toBeDefined();
    expect(remoteKeys).not.toBe(localKeys);

    current = { ...oidc, kind: 'local' };
    verifiers.invalidate();
    expect((await verifiers.byIssuer(oidc.issuer))?.keys).toBe(localKeys);

    current = { ...oidc, kind: 'oidc' };
    verifiers.invalidate();
    const restoredRemoteKeys = (await verifiers.byIssuer(oidc.issuer))?.keys;
    expect(restoredRemoteKeys).toBeDefined();
    expect(restoredRemoteKeys).not.toBe(localKeys);
  });
});
