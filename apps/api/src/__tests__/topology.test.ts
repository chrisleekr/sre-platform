import { seedMembership } from '@sre/db/test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import {
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  users,
  tenants,
  services,
  serviceDependencies,
  type DbHandle,
} from '@sre/db';
import { makeApp } from '../app';
import { makeTestAuth } from './auth-test-support';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const ISSUER = 'https://test.auth0.local/';
const AUDIENCE = 'sre-api';
const KID = 'test-key';
const KEY = Buffer.alloc(32, 9).toString('base64');

let admin: DbHandle;
let app: DbHandle;
let api: ReturnType<typeof makeApp>;
let privateKey: CryptoKey;
let orgA: string;
let tenantA: string;
let orgB: string;
let tenantB: string;

function sign(org: string, _perms: string[]): Promise<string> {
  return new SignJWT({ sub: org })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function bearer(token: string): { authorization: string; 'content-type': string } {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  const secrets = makeSecretStore(app.db, KEY);

  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);

  orgA = `org_${randomUUID().slice(0, 8)}`;
  tenantA = randomUUID();
  orgB = `org_${randomUUID().slice(0, 8)}`;
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
  await seedMembership(admin.db, { issuer: ISSUER, subject: orgA }, tenantA, 'admin');
  await seedMembership(admin.db, { issuer: ISSUER, subject: orgB }, tenantB, 'admin');
  api = makeApp({
    auth: await makeTestAuth({
      adminDb: admin.db,
      appDb: app.db,
      issuer: ISSUER,
      audience: AUDIENCE,
      keys,
      bindings: [
        { tenantId: tenantA, subject: orgA },
        { tenantId: tenantB, subject: orgB },
      ],
    }),
    readinessDb: app.db,
    appDb: app.db,
    secrets,
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
  });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(serviceDependencies).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(services).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenantIdentityBindings).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(users).where(sql`issuer = ${ISSUER} and subject in (${orgA}, ${orgB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('topology CRUD API', () => {
  test('admin registers services + a dependency; GET lists them', async () => {
    for (const [name, body] of [
      ['checkout', { criticality: 'tier1', team: 'payments' }],
      ['orders-db', {}],
    ] as const) {
      const res = await api.request(`/topology/services/${name}`, {
        method: 'PUT',
        headers: bearer(await sign(orgA, ['admin'])),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
    }

    const dep = await api.request('/topology/dependencies', {
      method: 'PUT',
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({ upstream: 'checkout', downstream: 'orders-db', syncType: 'sync' }),
    });
    expect(dep.status).toBe(200);

    const list = await api.request('/topology/services', {
      headers: { authorization: `Bearer ${await sign(orgA, ['responder'])}` },
    });
    const body = (await list.json()) as { services: Array<{ name: string; criticality: string }> };
    expect(body.services.map((s) => s.name)).toEqual(
      expect.arrayContaining(['checkout', 'orders-db']),
    );
    expect(body.services.find((s) => s.name === 'checkout')?.criticality).toBe('tier1');

    const deps = await api.request('/topology/dependencies', {
      headers: { authorization: `Bearer ${await sign(orgA, ['responder'])}` },
    });
    const depBody = (await deps.json()) as { dependencies: unknown[] };
    expect(depBody.dependencies).toHaveLength(1);
  });

  test('a dependency to an unregistered service is rejected with 400 (no raw DB error)', async () => {
    const res = await api.request('/topology/dependencies', {
      method: 'PUT',
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({ upstream: 'checkout', downstream: 'ghost' }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/constraint|foreign key|violates/i);
  });

  test('rejects a self-dependency and invalid enum values with 400', async () => {
    const selfLoop = await api.request('/topology/dependencies', {
      method: 'PUT',
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({ upstream: 'checkout', downstream: 'checkout' }),
    });
    expect(selfLoop.status).toBe(400);

    const badSync = await api.request('/topology/dependencies', {
      method: 'PUT',
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({ upstream: 'checkout', downstream: 'orders-db', syncType: 'aync' }),
    });
    expect(badSync.status).toBe(400);

    const badCriticality = await api.request('/topology/services/foo', {
      method: 'PUT',
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({ criticality: 'critical' }),
    });
    expect(badCriticality.status).toBe(400);
  });

  test('another tenant cannot see the graph (RLS)', async () => {
    const res = await api.request('/topology/services', {
      headers: { authorization: `Bearer ${await sign(orgB, ['responder'])}` },
    });
    const body = (await res.json()) as { services: Array<{ name: string }> };
    expect(body.services.some((s) => s.name === 'checkout')).toBe(false);
  });

  test('PATCH /topology/services/:name updates one attribute without resetting others', async () => {
    const put = await api.request('/topology/services/patch-api', {
      method: 'PUT',
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({ team: 'payments', criticality: 'tier1' }),
    });
    expect(put.status).toBe(200);

    const patch = await api.request('/topology/services/patch-api', {
      method: 'PATCH',
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({ team: 'newteam' }),
    });
    expect(patch.status).toBe(200);

    const list = await api.request('/topology/services', {
      headers: { authorization: `Bearer ${await sign(orgA, ['responder'])}` },
    });
    const body = (await list.json()) as {
      services: Array<{ name: string; team: string; criticality: string }>;
    };
    const svc = body.services.find((s) => s.name === 'patch-api');
    expect(svc?.team).toBe('newteam');
    // criticality was omitted from the PATCH, so it must not reset.
    expect(svc?.criticality).toBe('tier1');
  });

  test('PATCH /topology/dependencies updates one attribute without resetting others', async () => {
    for (const name of ['patch-src', 'patch-dst']) {
      const res = await api.request(`/topology/services/${name}`, {
        method: 'PUT',
        headers: bearer(await sign(orgA, ['admin'])),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    }
    const put = await api.request('/topology/dependencies', {
      method: 'PUT',
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({
        upstream: 'patch-src',
        downstream: 'patch-dst',
        syncType: 'async',
        circuitBreaker: true,
      }),
    });
    expect(put.status).toBe(200);

    const patch = await api.request('/topology/dependencies', {
      method: 'PATCH',
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({
        upstream: 'patch-src',
        downstream: 'patch-dst',
        circuitBreaker: false,
      }),
    });
    expect(patch.status).toBe(200);

    const deps = await api.request('/topology/dependencies', {
      headers: { authorization: `Bearer ${await sign(orgA, ['responder'])}` },
    });
    const depBody = (await deps.json()) as {
      dependencies: Array<{
        upstream: string;
        downstream: string;
        syncType: string;
        circuitBreaker: boolean;
      }>;
    };
    const edge = depBody.dependencies.find(
      (d) => d.upstream === 'patch-src' && d.downstream === 'patch-dst',
    );
    expect(edge?.circuitBreaker).toBe(false);
    // syncType was omitted from the PATCH, so it must not reset.
    expect(edge?.syncType).toBe('async');
  });

  test('PATCH a missing service returns 404', async () => {
    const res = await api.request('/topology/services/does-not-exist', {
      method: 'PATCH',
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({ team: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

test('dependency mutations preserve exact scope and return 404 for missing or foreign edges', async () => {
  const headers = bearer(await sign(orgA, ['admin']));
  for (const name of ['scoped-caller', 'scoped-target']) {
    expect(
      (await api.request(`/topology/services/${name}`, { method: 'PUT', headers, body: '{}' }))
        .status,
    ).toBe(200);
  }
  const edge = { upstream: 'scoped-caller', downstream: 'scoped-target' };
  const request = (method: string, body: object, auth = headers) =>
    api.request('/topology/dependencies', { method, headers: auth, body: JSON.stringify(body) });
  for (const environment of ['', 'production', 'staging']) {
    const result = await request('PUT', { ...edge, environment });
    expect(result.status).toBe(200);
    expect(
      ((await result.json()) as { dependency: { environment: string } }).dependency.environment,
    ).toBe(environment);
  }
  const graph = await api.request('/topology/graph', { headers });
  expect(graph.status).toBe(200);
  const graphBody = (await graph.json()) as {
    edges: Array<{ upstream: string; environment?: string }>;
  };
  expect(
    graphBody.edges
      .filter((row) => row.upstream === edge.upstream)
      .map((row) => row.environment ?? '')
      .sort(),
  ).toEqual(['', 'production', 'staging']);
  const updated = await request('PATCH', { ...edge, environment: 'production', syncType: 'async' });
  expect(updated.status).toBe(200);
  expect(
    ((await updated.json()) as { dependency: { environment: string; syncType: string } })
      .dependency,
  ).toMatchObject({
    environment: 'production',
    syncType: 'async',
  });
  const foreign = bearer(await sign(orgB, ['admin']));
  expect(
    (await request('PATCH', { ...edge, environment: 'production', syncType: 'sync' }, foreign))
      .status,
  ).toBe(404);
  expect((await request('DELETE', { ...edge, environment: 'production' }, foreign)).status).toBe(
    404,
  );
  expect((await request('DELETE', { ...edge, environment: 'production' })).status).toBe(200);
  expect((await request('DELETE', { ...edge, environment: 'production' })).status).toBe(404);
  const remaining = await api.request('/topology/dependencies', { headers });
  expect(
    (
      (await remaining.json()) as { dependencies: Array<{ upstream: string; environment: string }> }
    ).dependencies
      .filter((row: { upstream: string }) => row.upstream === edge.upstream)
      .map((row: { environment: string }) => row.environment)
      .sort(),
  ).toEqual(['', 'staging']);
  expect((await request('DELETE', edge)).status).toBe(200);
  expect((await request('DELETE', edge)).status).toBe(404);
});

test.each(['PUT', 'PATCH', 'DELETE'])(
  'dependency %s rejects non-string environment',
  async (method) => {
    const response = await api.request('/topology/dependencies', {
      method,
      headers: bearer(await sign(orgA, ['admin'])),
      body: JSON.stringify({
        upstream: 'caller',
        downstream: 'target',
        environment: 123,
        syncType: 'sync',
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'environment must be a string' });
  },
);
