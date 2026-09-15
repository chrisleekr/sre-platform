// An objective is the definition every reliability figure is computed from, and the service graph is
// what blast radius is derived over. Both are durable descriptions of the workspace rather than
// incident work, so both take the change tier. A refused request must leave the stored rows exactly
// as they were, so each case asserts the row and not only the status code.
import { seedMembership } from '@sre/db/test-support';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import {
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  users,
  tenants,
  slos,
  services,
  serviceDependencies,
  type DbHandle,
  type MembershipRole,
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

/** The one refusal every configuration route shares, so a member cannot tell which one they reached. */
const REFUSED = 'A workspace owner or administrator must change this configuration.';

let admin: DbHandle;
let app: DbHandle;
let api: ReturnType<typeof makeApp>;
let privateKey: CryptoKey;
let orgA: string;
let tenantA: string;

function sign(org: string): Promise<string> {
  return new SignJWT({ sub: org })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function headers(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await sign(orgA)}`, 'content-type': 'application/json' };
}

async function setRole(role: MembershipRole): Promise<void> {
  await admin.db.update(memberships).set({ role }).where(eq(memberships.tenantId, tenantA));
}

const objective = (): Record<string, unknown> => ({
  name: `checkout-availability-${randomUUID().slice(0, 8)}`,
  service: 'checkout',
  sliType: 'availability',
  target: 0.999,
  windowDays: 30,
  metricQuery: 'sum(rate(errors[$window])) / sum(rate(total[$window]))',
  connectorType: 'prometheus',
});

/** Creates one objective as an administrator, then drops back to member. */
async function seedObjective(): Promise<{ id: string; target: number }> {
  await setRole('admin');
  const created = await api.request('/slos', {
    method: 'POST',
    headers: await headers(),
    body: JSON.stringify(objective()),
  });
  expect(created.status).toBe(201);
  const { slo } = (await created.json()) as { slo: { id: string } };
  await setRole('member');
  const [row] = await admin.db
    .select({ id: slos.id, target: slos.target })
    .from(slos)
    .where(eq(slos.id, slo.id));
  expect(row).toBeDefined();
  return row!;
}

/** Creates one service as an administrator, then drops back to member. */
async function seedService(): Promise<string> {
  const name = `checkout-${randomUUID().slice(0, 8)}`;
  await setRole('admin');
  const saved = await api.request(`/topology/services/${name}`, {
    method: 'PUT',
    headers: await headers(),
    body: JSON.stringify({ criticality: 'tier1' }),
  });
  expect(saved.status).toBeLessThan(300);
  await setRole('member');
  return name;
}

// The admin connection bypasses RLS and the suite shares one database with every other backend
// test, so both reads scope to this workspace explicitly. Without it these assertions count rows
// another worker happens to be holding.
function objectiveRows() {
  return admin.db
    .select({ id: slos.id, target: slos.target })
    .from(slos)
    .where(eq(slos.tenantId, tenantA));
}

function serviceRows() {
  return admin.db
    .select({ name: services.name, criticality: services.criticality })
    .from(services)
    .where(eq(services.tenantId, tenantA));
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
  await admin.db.insert(tenants).values([{ id: tenantA, name: 'Boundary' }]);
  await seedMembership(admin.db, { issuer: ISSUER, subject: orgA }, tenantA, 'member');
  api = makeApp({
    auth: await makeTestAuth({
      adminDb: admin.db,
      appDb: app.db,
      issuer: ISSUER,
      audience: AUDIENCE,
      keys,
      bindings: [{ tenantId: tenantA, subject: orgA }],
    }),
    readinessDb: app.db,
    appDb: app.db,
    secrets,
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
  });
}, 30_000);

afterEach(async () => {
  await admin.db.delete(serviceDependencies).where(eq(serviceDependencies.tenantId, tenantA));
  await admin.db.delete(slos).where(eq(slos.tenantId, tenantA));
  await admin.db.delete(services).where(eq(services.tenantId, tenantA));
  await setRole('member');
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(memberships).where(sql`tenant_id = ${tenantA}`);
    await admin.db.delete(tenantIdentityBindings).where(sql`tenant_id = ${tenantA}`);
    await admin.db.delete(users).where(sql`issuer = ${ISSUER} and subject = ${orgA}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantA}`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('service level objective authorization boundary', () => {
  test('a member defining an objective stores nothing', async () => {
    await setRole('member');
    const created = await api.request('/slos', {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify(objective()),
    });
    expect(created.status).toBe(403);
    expect(await created.json()).toEqual({ error: REFUSED });
    expect(await objectiveRows()).toHaveLength(0);
  });

  test('a member retargeting an objective leaves the target untouched', async () => {
    const seeded = await seedObjective();
    const patched = await api.request(`/slos/${seeded.id}`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ target: 0.5 }),
    });
    expect(patched.status).toBe(403);
    const [row] = await objectiveRows();
    expect(row?.target).toBe(seeded.target);
  });

  test('a member deleting an objective leaves it in place', async () => {
    const seeded = await seedObjective();
    const removed = await api.request(`/slos/${seeded.id}`, {
      method: 'DELETE',
      headers: await headers(),
    });
    expect(removed.status).toBe(403);
    expect((await objectiveRows()).map((row) => row.id)).toEqual([seeded.id]);
  });

  test('a member still reads the objectives and the dashboard status', async () => {
    await seedObjective();
    expect((await api.request('/slos', { headers: await headers() })).status).toBe(200);
    expect((await api.request('/slos/status', { headers: await headers() })).status).toBe(200);
  });

  test('an administrator defining an objective persists it', async () => {
    await setRole('admin');
    const created = await api.request('/slos', {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify(objective()),
    });
    expect(created.status).toBe(201);
    expect(await objectiveRows()).toHaveLength(1);
  });
});

describe('service topology authorization boundary', () => {
  test.each([
    ['PUT', '/topology/runtime-bindings'],
    ['DELETE', '/topology/runtime-bindings/11111111-1111-4111-8111-111111111111'],
    ['PUT', '/topology/incidents/11111111-1111-4111-8111-111111111111/services'],
    ['DELETE', '/topology/incidents/11111111-1111-4111-8111-111111111111/services'],
    ['PATCH', '/topology/dependencies'],
  ])('a member cannot reach new topology configuration handlers: %s %s', async (method, path) => {
    const response = await api.request(path!, {
      method,
      headers: await headers(),
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: REFUSED });
  });
  test('a member cataloguing a service stores nothing', async () => {
    await setRole('member');
    const saved = await api.request(`/topology/services/checkout-${randomUUID().slice(0, 8)}`, {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({ criticality: 'tier1' }),
    });
    expect(saved.status).toBe(403);
    expect(await saved.json()).toEqual({ error: REFUSED });
    expect(await serviceRows()).toHaveLength(0);
  });

  test('a member retiering a catalogued service leaves the criticality untouched', async () => {
    const name = await seedService();
    const patched = await api.request(`/topology/services/${name}`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ criticality: 'tier3' }),
    });
    expect(patched.status).toBe(403);
    expect(await serviceRows()).toEqual([{ name, criticality: 'tier1' }]);
  });

  test('a member deleting a catalogued service leaves it in place', async () => {
    const name = await seedService();
    const removed = await api.request(`/topology/services/${name}`, {
      method: 'DELETE',
      headers: await headers(),
    });
    expect(removed.status).toBe(403);
    expect((await serviceRows()).map((row) => row.name)).toEqual([name]);
  });

  test('a member declaring a dependency edge stores nothing', async () => {
    const from = await seedService();
    const to = await seedService();
    const declared = await api.request('/topology/dependencies', {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({ upstream: from, downstream: to }),
    });
    expect(declared.status).toBe(403);
    expect(
      await admin.db
        .select({ id: serviceDependencies.tenantId })
        .from(serviceDependencies)
        .where(eq(serviceDependencies.tenantId, tenantA)),
    ).toHaveLength(0);
  });

  test('a member still reads the catalog, the graph and blast radius', async () => {
    const name = await seedService();
    expect((await api.request('/topology/services', { headers: await headers() })).status).toBe(
      200,
    );
    expect((await api.request('/topology/graph', { headers: await headers() })).status).toBe(200);
    expect(
      (await api.request(`/topology/blast-radius?service=${name}`, { headers: await headers() }))
        .status,
    ).toBe(200);
  });

  test('an administrator cataloguing a service persists it', async () => {
    await setRole('admin');
    const name = `checkout-${randomUUID().slice(0, 8)}`;
    const saved = await api.request(`/topology/services/${name}`, {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({ criticality: 'tier1' }),
    });
    expect(saved.status).toBeLessThan(300);
    expect(await serviceRows()).toEqual([{ name, criticality: 'tier1' }]);
  });
});
