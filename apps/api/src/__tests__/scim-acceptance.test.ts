import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  directoryAccountLinks,
  directoryAccounts,
  identityProviders,
  makeDb,
  users,
  type DbHandle,
} from '@sre/db';
import { SCIM_USER_SCHEMA } from '../scim/constants';
import { scimRoutes } from '../scim/routes';

const marker = randomUUID();
const providerId = randomUUID();
const otherProviderId = randomUUID();
const token = randomBytes(32).toString('base64url');
const otherToken = randomBytes(32).toString('base64url');
const base = `/scim/v2/providers/${providerId}`;
const otherBase = `/scim/v2/providers/${otherProviderId}`;
const publish = vi.fn(async () => undefined);
let db: DbHandle;

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function user(userName: string, externalId = `external-${randomUUID()}`, active = true) {
  return {
    schemas: [SCIM_USER_SCHEMA],
    externalId,
    userName,
    active,
    name: { givenName: 'Ada', familyName: 'Lovelace' },
    emails: [{ value: userName, type: 'work', primary: true }],
  };
}

function api(limiter = { allow: async () => true }) {
  return new Hono().route(
    '/',
    scimRoutes({
      db: db.db,
      revoke: { publish },
      limiter,
      sourceAddress: () => '192.0.2.20',
    }),
  );
}

function request(
  path: string,
  init: RequestInit = {},
  bearer: string | null = token,
  application = api(),
) {
  const headers = new Headers(init.headers);
  if (bearer) headers.set('authorization', `Bearer ${bearer}`);
  return application.request(path, { ...init, headers });
}

async function jsonMutation(path: string, method: string, body: unknown, bearer = token) {
  return request(
    path,
    {
      method,
      headers: { 'content-type': 'application/scim+json; charset=utf-8' },
      body: JSON.stringify(body),
    },
    bearer,
  );
}

async function create(
  path: string,
  body = user(`person-${randomUUID()}@example.test`),
  bearer = token,
) {
  const response = await jsonMutation(`${path}/Users`, 'POST', body, bearer);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  const now = new Date();
  const expiresAt = new Date(Date.now() + 86_400_000);
  await db.db.insert(identityProviders).values([
    {
      id: providerId,
      displayName: 'SCIM provider',
      issuer: `https://scim-${marker}.invalid`,
      jwksUri: `https://scim-${marker}.invalid/jwks`,
      browserClientId: 'scim-client',
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
      scimEnabled: true,
      scimTokenHash: hash(token),
      scimTokenCreatedAt: now,
      scimTokenExpiresAt: expiresAt,
    },
    {
      id: otherProviderId,
      displayName: 'Other SCIM provider',
      issuer: `https://other-scim-${marker}.invalid`,
      jwksUri: `https://other-scim-${marker}.invalid/jwks`,
      browserClientId: 'other-scim-client',
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
      scimEnabled: true,
      scimTokenHash: hash(otherToken),
      scimTokenCreatedAt: now,
      scimTokenExpiresAt: expiresAt,
    },
  ]);
});

beforeEach(async () => {
  publish.mockClear();
  await db.db
    .delete(directoryAccounts)
    .where(inArray(directoryAccounts.providerId, [providerId, otherProviderId]));
  await db.db.delete(users).where(eq(users.issuer, `https://scim-${marker}.invalid`));
});

afterAll(async () => {
  if (!db) return;
  await db.db
    .delete(directoryAccounts)
    .where(inArray(directoryAccounts.providerId, [providerId, otherProviderId]));
  await db.db.delete(users).where(eq(users.issuer, `https://scim-${marker}.invalid`));
  await db.db
    .delete(identityProviders)
    .where(inArray(identityProviders.id, [providerId, otherProviderId]));
  await db.close();
});

describe('SCIM authentication and discovery', () => {
  test('refuses missing, malformed, cross-provider, expired, disabled, and rate-limited access', async () => {
    for (const [bearer, expected] of [
      [null, 401],
      ['bad token', 401],
      [otherToken, 401],
    ] as const) {
      const response = await request(`${base}/ServiceProviderConfig`, {}, bearer);
      expect(response.status).toBe(expected);
      expect(response.headers.get('content-type')).toContain('application/scim+json');
    }
    await db.db
      .update(identityProviders)
      .set({ scimTokenExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(identityProviders.id, providerId));
    expect((await request(`${base}/ServiceProviderConfig`)).status).toBe(401);
    await db.db
      .update(identityProviders)
      .set({ scimTokenExpiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(identityProviders.id, providerId));
    await db.db
      .update(identityProviders)
      .set({
        scimEnabled: false,
        scimTokenHash: null,
        scimTokenCreatedAt: null,
        scimTokenExpiresAt: null,
      })
      .where(eq(identityProviders.id, providerId));
    expect((await request(`${base}/ServiceProviderConfig`)).status).toBe(401);
    await db.db
      .update(identityProviders)
      .set({
        scimEnabled: true,
        scimTokenHash: hash(token),
        scimTokenCreatedAt: new Date(),
        scimTokenExpiresAt: new Date(Date.now() + 86_400_000),
      })
      .where(eq(identityProviders.id, providerId));
    const response = await request(
      `${base}/ServiceProviderConfig`,
      {},
      token,
      api({ allow: async () => false }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    const unavailable = await request(
      `${base}/ServiceProviderConfig`,
      {},
      token,
      api({ allow: async () => Promise.reject(new Error('unavailable')) }),
    );
    expect(unavailable.status).toBe(503);
  });

  test('advertises only the implemented User protocol', async () => {
    const config = await request(`${base}/ServiceProviderConfig`);
    expect(config.status).toBe(200);
    await expect(config.json()).resolves.toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 200 },
      sort: { supported: false },
    });
    const resourceTypes = await request(`${base}/ResourceTypes`);
    await expect(resourceTypes.json()).resolves.toMatchObject({
      totalResults: 1,
      Resources: [{ id: 'User', endpoint: '/Users', schema: SCIM_USER_SCHEMA }],
    });
    const schema = await request(`${base}/Schemas/${encodeURIComponent(SCIM_USER_SCHEMA)}`);
    expect(schema.status).toBe(200);
    await expect(schema.json()).resolves.toMatchObject({
      id: SCIM_USER_SCHEMA,
      name: 'User',
      attributes: expect.arrayContaining([
        expect.objectContaining({ name: 'externalId', uniqueness: 'server' }),
        expect.objectContaining({
          name: 'name',
          subAttributes: expect.arrayContaining([expect.objectContaining({ name: 'givenName' })]),
        }),
        expect.objectContaining({
          name: 'emails',
          subAttributes: expect.arrayContaining([expect.objectContaining({ name: 'value' })]),
        }),
      ]),
    });
  });
});

describe('SCIM User lifecycle', () => {
  test('creates, isolates, filters, paginates, and enforces current uniqueness', async () => {
    const input = user('Ada@example.test', 'directory-ada');
    const created = await create(base, input);
    expect(created.response.status).toBe(201);
    expect(created.response.headers.get('location')).toContain(`/Users/${created.body.id}`);
    expect(created.body).toMatchObject({
      schemas: [SCIM_USER_SCHEMA],
      userName: 'Ada@example.test',
      externalId: 'directory-ada',
      active: true,
      meta: { resourceType: 'User' },
    });
    expect((await create(base, input)).response.status).toBe(409);
    expect((await create(otherBase, input, otherToken)).response.status).toBe(201);
    const byName = await request(
      `${base}/Users?filter=${encodeURIComponent('USERNAME Eq "ada@example.test"')}`,
    );
    await expect(byName.json()).resolves.toMatchObject({ totalResults: 1, itemsPerPage: 1 });
    const byExternal = await request(
      `${base}/Users?filter=${encodeURIComponent('externalId eq "directory-ada"')}`,
    );
    await expect(byExternal.json()).resolves.toMatchObject({ totalResults: 1 });
    const page = await request(`${base}/Users?startIndex=2&count=1`);
    await expect(page.json()).resolves.toMatchObject({
      totalResults: 1,
      startIndex: 2,
      itemsPerPage: 0,
    });
    const totalsOnly = await request(`${base}/Users?count=0`);
    await expect(totalsOnly.json()).resolves.toMatchObject({
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 0,
      Resources: [],
    });
    expect((await request(`${otherBase}/Users/${created.body.id}`, {}, otherToken)).status).toBe(
      404,
    );
  });

  test('rejects unsupported filters and patches before changing a resource', async () => {
    const created = await create(base, user('patch@example.test', 'patch-person'));
    const id = String(created.body.id);
    const filter = await request(
      `${base}/Users?filter=${encodeURIComponent('displayName eq "Ada"')}`,
    );
    expect(filter.status).toBe(400);
    await expect(filter.json()).resolves.toMatchObject({ scimType: 'invalidFilter' });
    const invalid = await jsonMutation(`${base}/Users/${id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'replace', path: 'active', value: false },
        { op: 'replace', path: 'unsupported', value: 'x' },
      ],
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ scimType: 'invalidPath' });
    const current = await request(`${base}/Users/${id}`);
    await expect(current.json()).resolves.toMatchObject({ active: true });

    const badValue = await jsonMutation(`${base}/Users/${id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: 'false' }],
    });
    await expect(badValue.json()).resolves.toMatchObject({ scimType: 'invalidValue' });
  });

  test('replaces and patches the supported User attributes as complete resources', async () => {
    const created = await create(base, user('mutable@example.test', 'mutable-person'));
    const id = String(created.body.id);
    const replacement = user('renamed@example.test', 'renamed-person', false);
    const replaced = await jsonMutation(`${base}/Users/${id}`, 'PUT', replacement);
    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toMatchObject({
      id,
      userName: 'renamed@example.test',
      externalId: 'renamed-person',
      active: false,
    });

    const patched = await jsonMutation(`${base}/Users/${id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        { op: 'replace', value: { active: true, userName: 'current@example.test' } },
        { op: 'remove', path: 'externalId' },
      ],
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as Record<string, unknown>;
    expect(patchedBody).toMatchObject({
      id,
      userName: 'current@example.test',
      active: true,
    });
    expect(patchedBody).not.toHaveProperty('externalId');
  });

  test('rejects non-SCIM and oversized mutation bodies without creating a resource', async () => {
    const wrongMedia = await request(`${base}/Users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(user('wrong-media@example.test')),
    });
    expect(wrongMedia.status).toBe(400);
    const oversized = await request(`${base}/Users`, {
      method: 'POST',
      headers: { 'content-type': 'application/scim+json' },
      body: JSON.stringify({ ...user('large@example.test'), ignored: 'x'.repeat(300_000) }),
    });
    expect(oversized.status).toBe(413);
    const listed = await request(`${base}/Users`);
    await expect(listed.json()).resolves.toMatchObject({ totalResults: 0, Resources: [] });
  });

  test('deactivates a linked identity durably before publishing a live revoke hint', async () => {
    const created = await create(base, user('linked@example.test', 'linked-subject'));
    const [account] = await db.db
      .select()
      .from(directoryAccounts)
      .where(eq(directoryAccounts.id, String(created.body.id)));
    const [platformUser] = await db.db
      .insert(users)
      .values({
        issuer: `https://scim-${marker}.invalid`,
        subject: 'linked-subject',
        email: 'linked@example.test',
      })
      .returning();
    await db.db.insert(directoryAccountLinks).values({
      providerId,
      directoryAccountId: account!.id,
      userId: platformUser!.id,
    });
    const response = await jsonMutation(`${base}/Users/${account!.id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledWith({ userId: platformUser!.id });
    const [stored] = await db.db.select().from(users).where(eq(users.id, platformUser!.id));
    expect(stored!.notBefore).toBeInstanceOf(Date);
  });

  test('keeps committed deactivation authoritative when the live revoke hint is unavailable', async () => {
    const created = await create(base, user('publish-failure@example.test', 'publish-failure'));
    const [account] = await db.db
      .select()
      .from(directoryAccounts)
      .where(eq(directoryAccounts.id, String(created.body.id)));
    const [platformUser] = await db.db
      .insert(users)
      .values({
        issuer: `https://scim-${marker}.invalid`,
        subject: 'publish-failure',
        email: 'publish-failure@example.test',
      })
      .returning();
    await db.db.insert(directoryAccountLinks).values({
      providerId,
      directoryAccountId: account!.id,
      userId: platformUser!.id,
    });
    publish.mockRejectedValueOnce(new Error('revoke bus unavailable'));

    const response = await jsonMutation(`${base}/Users/${account!.id}`, 'PATCH', {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });

    expect(response.status).toBe(200);
    const [storedAccount] = await db.db
      .select()
      .from(directoryAccounts)
      .where(eq(directoryAccounts.id, account!.id));
    const [storedUser] = await db.db.select().from(users).where(eq(users.id, platformUser!.id));
    expect(storedAccount!.active).toBe(false);
    expect(storedUser!.notBefore).toBeInstanceOf(Date);
  });

  test('tombstones DELETE, hides the old id, and assigns a new id after reprovisioning', async () => {
    const input = user('deleted@example.test', 'deleted-person');
    const created = await create(base, input);
    const id = String(created.body.id);
    expect((await request(`${base}/Users/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`${base}/Users/${id}`)).status).toBe(404);
    const hidden = await request(
      `${base}/Users?filter=${encodeURIComponent('userName eq "deleted@example.test"')}`,
    );
    await expect(hidden.json()).resolves.toMatchObject({ totalResults: 0, Resources: [] });
    const reprovisioned = await create(base, input);
    expect(reprovisioned.response.status).toBe(201);
    expect(reprovisioned.body.id).not.toBe(id);
  });
});
