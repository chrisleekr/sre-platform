// Tenant-scoped CRUD for service level objectives plus the dashboard status read. Every route is
// authenticated and RLS-scoped; validation is hand-rolled at the boundary so a tenant-facing router
// never returns raw database text, and the per-tenant cap is enforced before the write.
import { seedMembership } from '@sre/db/test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import {
  makeDb,
  makeSecretStore,
  createSlo,
  recordBurnEvent,
  memberships,
  tenantIdentityBindings,
  users,
  tenants,
  slos,
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

/** Mirrors the router's per-tenant cap; a definition store is bounded, not a log. */
const MAX_SLOS_PER_TENANT = 100;

// Seeding helper for the cases that are not about the ceiling: they create a handful of objectives and
// must not trip it.
const createSloUncapped = (
  db: Parameters<typeof createSlo>[0],
  tid: string,
  input: Parameters<typeof createSlo>[2],
) => createSlo(db, tid, input, MAX_SLOS_PER_TENANT + 1);

let admin: DbHandle;
let app: DbHandle;
let api: ReturnType<typeof makeApp>;
let privateKey: CryptoKey;
let orgA: string;
let tenantA: string;
let orgB: string;
let tenantB: string;
// Dedicated tenant for the cap test so its ~100 seeded rows do not perturb the other tests.
let orgCap: string;
let tenantCap: string;

function sign(org: string): Promise<string> {
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

const availability = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: `checkout-availability-${randomUUID().slice(0, 8)}`,
  service: 'checkout',
  sliType: 'availability',
  target: 0.999,
  windowDays: 30,
  metricQuery: 'sum(rate(errors[$window])) / sum(rate(total[$window]))',
  connectorType: 'prometheus',
  ...over,
});

async function postSlo(org: string, body: Record<string, unknown>) {
  return api.request('/slos', {
    method: 'POST',
    headers: bearer(await sign(org)),
    body: JSON.stringify(body),
  });
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
  orgCap = `org_${randomUUID().slice(0, 8)}`;
  tenantCap = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
    { id: tenantCap, name: 'CAP' },
  ]);
  await seedMembership(admin.db, { issuer: ISSUER, subject: orgA }, tenantA, 'admin');
  await seedMembership(admin.db, { issuer: ISSUER, subject: orgB }, tenantB, 'admin');
  await seedMembership(admin.db, { issuer: ISSUER, subject: orgCap }, tenantCap, 'admin');
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
        { tenantId: tenantCap, subject: orgCap },
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
    // Burn events cascade off their objective.
    await admin.db.delete(slos).where(sql`tenant_id in (${tenantA}, ${tenantB}, ${tenantCap})`);
    await admin.db
      .delete(memberships)
      .where(sql`tenant_id in (${tenantA}, ${tenantB}, ${tenantCap})`);
    await admin.db
      .delete(tenantIdentityBindings)
      .where(sql`tenant_id in (${tenantA}, ${tenantB}, ${tenantCap})`);
    await admin.db
      .delete(users)
      .where(sql`issuer = ${ISSUER} and subject in (${orgA}, ${orgB}, ${orgCap})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB}, ${tenantCap})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('SLO CRUD API', () => {
  test('rejects an unauthenticated request', async () => {
    expect((await api.request('/slos')).status).toBe(401);
  });

  test('creates an objective, then lists and fetches it by id', async () => {
    const body = availability();
    const created = await postSlo(orgA, body);
    expect(created.status).toBe(201);
    const { slo } = (await created.json()) as { slo: { id: string; name: string } };
    expect(slo.name).toBe(body.name);

    const listed = await api.request('/slos', { headers: bearer(await sign(orgA)) });
    expect(listed.status).toBe(200);
    const { slos: list } = (await listed.json()) as { slos: Array<{ id: string }> };
    expect(list.map((s) => s.id)).toContain(slo.id);

    const one = await api.request(`/slos/${slo.id}`, { headers: bearer(await sign(orgA)) });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { slo: { id: string } }).slo.id).toBe(slo.id);
  });

  test('accepts a latency objective carrying a threshold', async () => {
    const res = await postSlo(orgA, availability({ sliType: 'latency', thresholdMs: 250 }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { slo: { thresholdMs: number } }).slo.thresholdMs).toBe(250);
  });

  test('GET /slos/status is routed before /:id and returns the latest evaluation', async () => {
    const service = `status-${randomUUID().slice(0, 8)}`;
    const slo = await createSloUncapped(app.db, tenantA, {
      name: `status-${randomUUID().slice(0, 8)}`,
      service,
      sliType: 'availability',
      target: 0.999,
      windowDays: 30,
      metricQuery: 'bad_ratio',
      connectorType: 'prometheus',
    });
    await recordBurnEvent(app.db, tenantA, {
      sloId: slo.id,
      budgetPct: 0.25,
      burnRate: 4,
      window: '1h',
    });

    const res = await api.request('/slos/status', { headers: bearer(await sign(orgA)) });
    // 'status' must not be captured as an objective id, which would 404 the whole panel.
    expect(res.status).toBe(200);
    const { slos: rows } = (await res.json()) as {
      slos: Array<{
        id: string;
        enabled: boolean;
        evaluation: {
          budgetRemaining: number;
          burnRate: number;
          exhaustionDays: number;
          computedAt: string;
        } | null;
      }>;
    };
    const row = rows.find((r) => r.id === slo.id)!;
    expect(row.enabled).toBe(true);
    expect(row.evaluation!.budgetRemaining).toBeCloseTo(0.25, 9);
    expect(row.evaluation!.burnRate).toBeCloseTo(4, 9);
    expect(row.evaluation!.exhaustionDays).toBeCloseTo(1.875, 6);
  });

  test('rejects invalid definitions with 400 and never echoes raw database text', async () => {
    const cases: Array<Record<string, unknown>> = [
      availability({ name: '' }),
      availability({ service: '' }),
      availability({ sliType: 'throughput' }),
      availability({ target: 1 }),
      availability({ target: 0 }),
      availability({ windowDays: 0 }),
      availability({ metricQuery: '' }),
      availability({ connectorType: '' }),
      // Latency needs a threshold; availability must not carry one.
      availability({ sliType: 'latency' }),
      availability({ thresholdMs: 250 }),
    ];
    for (const body of cases) {
      const res = await postSlo(orgA, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const text = await res.text();
      // No SQLSTATE, no constraint name, no connection string.
      expect(text).not.toMatch(/23514|23505|_ck\b|_uq\b|postgres:\/\//);
    }
  });

  test('rejects over-length free text and an oversized body, never a raw database error', async () => {
    const cases: Array<Record<string, unknown>> = [
      availability({ name: 'n'.repeat(201) }),
      availability({ service: 's'.repeat(201) }),
      availability({ metricQuery: 'q'.repeat(2001) }),
    ];
    for (const body of cases) {
      const res = await postSlo(orgA, body);
      expect(res.status, JSON.stringify(Object.keys(body))).toBe(400);
      expect(await res.text()).not.toMatch(/22001|23514|23505|postgres:\/\//);
    }

    // Past the body limit the request never reaches the parser, so it is a 413 rather than a 400.
    const oversized = await postSlo(orgA, availability({ metricQuery: 'q'.repeat(9_000) }));
    expect(oversized.status).toBe(413);

    // The same caps bind a patch, so an update cannot smuggle past what create refuses.
    const created = await postSlo(orgA, availability());
    const { slo } = (await created.json()) as { slo: { id: string } };
    const patched = await api.request(`/slos/${slo.id}`, {
      method: 'PATCH',
      headers: bearer(await sign(orgA)),
      body: JSON.stringify({ metricQuery: 'q'.repeat(2001) }),
    });
    expect(patched.status).toBe(400);
  });

  test('a malformed objective id is a 404 on GET, PATCH and DELETE, not a 500', async () => {
    // A non-uuid id reaches a uuid column as Postgres 22P02, which without the guard is a bare 500.
    for (const id of ['not-a-uuid', '1', '../etc', `${randomUUID()}x`]) {
      const path = `/slos/${encodeURIComponent(id)}`;
      const responses = [
        await api.request(path, { headers: bearer(await sign(orgA)) }),
        await api.request(path, {
          method: 'PATCH',
          headers: bearer(await sign(orgA)),
          body: JSON.stringify({ enabled: false }),
        }),
        await api.request(path, { method: 'DELETE', headers: bearer(await sign(orgA)) }),
      ];
      for (const res of responses) {
        expect(res.status, `${res.url} ${id}`).toBe(404);
        const text = await res.text();
        // No SQLSTATE, no driver text, no connection string.
        expect(text).not.toMatch(/22P02|invalid input syntax|uuid|postgres:\/\//i);
      }
    }
  });

  test('a duplicate name within one tenant is a 409, not a 500', async () => {
    const body = availability();
    expect((await postSlo(orgA, body)).status).toBe(201);
    const dup = await postSlo(orgA, body);
    expect(dup.status).toBe(409);
    expect(await dup.text()).not.toMatch(/23505|_uq\b/);
  });

  test('patches an objective and deletes it', async () => {
    const created = await postSlo(orgA, availability());
    const { slo } = (await created.json()) as { slo: { id: string } };

    const patched = await api.request(`/slos/${slo.id}`, {
      method: 'PATCH',
      headers: bearer(await sign(orgA)),
      body: JSON.stringify({ target: 0.99, enabled: false }),
    });
    expect(patched.status).toBe(200);
    const after = (await patched.json()) as { slo: { target: number; enabled: boolean } };
    expect(after.slo.target).toBeCloseTo(0.99, 9);
    expect(after.slo.enabled).toBe(false);

    const removed = await api.request(`/slos/${slo.id}`, {
      method: 'DELETE',
      headers: bearer(await sign(orgA)),
    });
    expect(removed.status).toBe(204);
    expect(
      (await api.request(`/slos/${slo.id}`, { headers: bearer(await sign(orgA)) })).status,
    ).toBe(404);
  });

  test('a patch that would break a constraint is a 400, not a 500', async () => {
    const created = await postSlo(orgA, availability());
    const { slo } = (await created.json()) as { slo: { id: string } };
    const res = await api.request(`/slos/${slo.id}`, {
      method: 'PATCH',
      headers: bearer(await sign(orgA)),
      body: JSON.stringify({ target: 2 }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/23514|_ck\b/);
  });

  test('C2: another tenant can neither see, fetch, patch nor delete these objectives', async () => {
    const created = await postSlo(orgA, availability({ service: 'iso-service' }));
    const { slo } = (await created.json()) as { slo: { id: string } };

    const listed = await api.request('/slos', { headers: bearer(await sign(orgB)) });
    const { slos: list } = (await listed.json()) as { slos: Array<{ id: string }> };
    expect(list.map((s) => s.id)).not.toContain(slo.id);

    expect(
      (await api.request(`/slos/${slo.id}`, { headers: bearer(await sign(orgB)) })).status,
    ).toBe(404);
    expect(
      (
        await api.request(`/slos/${slo.id}`, {
          method: 'PATCH',
          headers: bearer(await sign(orgB)),
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api.request(`/slos/${slo.id}`, {
          method: 'DELETE',
          headers: bearer(await sign(orgB)),
        })
      ).status,
    ).toBe(404);

    // Tenant A's objective survived every attempt untouched.
    const still = await api.request(`/slos/${slo.id}`, { headers: bearer(await sign(orgA)) });
    expect(still.status).toBe(200);
    expect(((await still.json()) as { slo: { enabled: boolean } }).slo.enabled).toBe(true);
  });

  test('refuses to create past the per-tenant cap, before the write', async () => {
    for (let i = 0; i < MAX_SLOS_PER_TENANT; i++) {
      await createSlo(
        app.db,
        tenantCap,
        {
          name: `cap-${i}`,
          service: 'checkout',
          sliType: 'availability',
          target: 0.999,
          windowDays: 30,
          metricQuery: 'bad_ratio',
          connectorType: 'prometheus',
        },
        MAX_SLOS_PER_TENANT,
      );
    }

    const res = await postSlo(orgCap, availability({ name: 'one-too-many' }));
    expect(res.status).toBe(400);

    const listed = await api.request('/slos', { headers: bearer(await sign(orgCap)) });
    const { slos: list } = (await listed.json()) as { slos: Array<{ name: string }> };
    // Rejected inside the write transaction, so nothing lands and there is nothing to clean up.
    expect(list).toHaveLength(MAX_SLOS_PER_TENANT);
    expect(list.map((s) => s.name)).not.toContain('one-too-many');

    // The ceiling is now the repository's, and the router must translate it rather than let it
    // surface as a 500. The message names the limit and quotes no database text.
    const body = (await (
      await postSlo(orgCap, availability({ name: 'also-too-many' }))
    ).json()) as { error: string };
    expect(body.error).toBe(`objective limit reached (max ${MAX_SLOS_PER_TENANT})`);
  }, 60_000);
});
