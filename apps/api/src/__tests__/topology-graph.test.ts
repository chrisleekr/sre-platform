import { seedMembership } from '@sre/db/test-support';
// GET /topology/graph composes current service sources while keeping registered edges authoritative;
// GET /topology/blast-radius?service= (computeBlastRadius wrapper). RLS-scoped; both are reads open to
// any authed tenant member. Mirrors topology.test.ts's JWT + two-tenant harness.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import {
  makeDb,
  makeSecretStore,
  tenants,
  services,
  serviceDependencies,
  deployments,
  connectorConfigs,
  incidents,
  memberships,
  tenantIdentityBindings,
  users,
  upsertService,
  addDependency,
  upsertDeployments,
  type DbHandle,
} from '@sre/db';
import type { NormalizedSnapshot } from '@sre/connectors';
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
const runtimeSnapshots = new Map<string, NormalizedSnapshot[]>();

function sign(org: string, _perms: string[]): Promise<string> {
  return new SignJWT({ sub: org })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

const OLD = new Date('2026-07-03T00:00:00Z');
const NEW = new Date('2026-07-03T02:00:00Z');

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
  await seedMembership(admin.db, { issuer: ISSUER, subject: orgA }, tenantA);
  await seedMembership(admin.db, { issuer: ISSUER, subject: orgB }, tenantB);
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
    cache: {
      get: async (tenantId, source) =>
        source === 'kubernetes' ? (runtimeSnapshots.get(tenantId) ?? []) : [],
      set: async () => {},
    },
    settings: { list: async () => [], set: async () => 1 },
  });
  await admin.db.insert(connectorConfigs).values({
    tenantId: tenantA,
    name: 'Topology Kubernetes',
    type: 'kubernetes',
    settings: {},
    enabled: true,
  });

  runtimeSnapshots.set(tenantA, [
    {
      tenantId: tenantA,
      source: 'kubernetes',
      entityId: 'monitoring/prometheus-0',
      metrics: { ready: 1, restartCount: 2, oomKilled: 0 },
      metadata: {
        kind: 'pod',
        namespace: 'monitoring',
        phase: 'Running',
        containers: [{ name: 'prometheus', ready: true, restartCount: 2 }],
        ignoredSecretLikeField: 'must-not-cross-the-api',
      },
      observedAt: NEW,
    },
    {
      tenantId: tenantA,
      source: 'kubernetes',
      entityId: 'cluster/nodes',
      metrics: {},
      metadata: { kind: 'node', error: 'node read denied', rawError: 'private detail' },
      observedAt: NEW,
    },
  ]);
  await admin.db.insert(incidents).values({
    tenantId: tenantA,
    fingerprint: `topology-${randomUUID()}`,
    alertSource: 'slack',
    service: 'monitoring',
    severity: 'sev2',
    status: 'mitigated',
    investigationStatus: 'gathering',
    title: 'Monitoring unavailable',
  });

  // Tenant A graph: checkout (tier1) depends on payments (tier2); orders (tier3) has no deploys.
  for (const [name, criticality, team] of [
    ['checkout', 'tier1', 'payments'],
    ['payments', 'tier2', 'payments'],
    ['orders', 'tier3', null],
  ] as const) {
    await upsertService(app.db, tenantA, { name, team, criticality });
  }
  await addDependency(app.db, tenantA, { upstream: 'checkout', downstream: 'payments' });

  // Two checkout deploys, one payments deploy. orders: none.
  await upsertDeployments(app.db, tenantA, [
    {
      source: 'gitlab',
      repo: 'acme/checkout',
      ref: 'main',
      sha: 'sha-checkout-old',
      service: 'checkout',
      status: 'success',
      deployedAt: OLD,
    },
    {
      source: 'gitlab',
      repo: 'acme/checkout',
      ref: 'main',
      sha: 'sha-checkout-new',
      service: 'checkout',
      status: 'success',
      deployedAt: NEW,
    },
    {
      source: 'gitlab',
      repo: 'acme/payments',
      ref: 'main',
      sha: 'sha-payments',
      service: 'payments',
      status: 'success',
      deployedAt: OLD,
    },
  ]);
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(deployments).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(connectorConfigs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
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

interface GraphNode {
  name: string;
  team: string | null;
  criticality: string | null;
  lastDeployAt: string | null;
  recentDeploys: { sha: string; deployedAt: string }[];
  sources: string[];
}
interface GraphBody {
  nodes: GraphNode[];
  edges: { upstream: string; downstream: string; syncType: string; circuitBreaker: boolean }[];
  infrastructure: Array<{
    entityId: string;
    kind?: string;
    namespace?: string;
    error?: string;
    [key: string]: unknown;
  }>;
}

describe('GET /topology/graph', () => {
  test('composes catalog, runtime, incident, and deployment services with registered edges', async () => {
    const res = await api.request('/topology/graph', {
      headers: auth(await sign(orgA, ['responder'])),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphBody;

    const byName = new Map(body.nodes.map((n) => [n.name, n]));
    // listServices orders by name, so the graph nodes come back alphabetical.
    expect(body.nodes.map((n) => n.name)).toEqual(['checkout', 'monitoring', 'orders', 'payments']);

    const checkout = byName.get('checkout')!;
    expect(checkout.criticality).toBe('tier1');
    expect(checkout.lastDeployAt).toBe(NEW.toISOString());
    // Newest-first, both deploys present.
    expect(checkout.recentDeploys.map((d) => d.sha)).toEqual([
      'sha-checkout-new',
      'sha-checkout-old',
    ]);
    expect(checkout.sources).toEqual(['catalog', 'deployment']);

    const monitoring = byName.get('monitoring')!;
    expect(monitoring.sources).toEqual(['kubernetes', 'incident']);
    expect(monitoring.team).toBeNull();
    expect(monitoring.recentDeploys).toEqual([]);

    const orders = byName.get('orders')!;
    expect(orders.lastDeployAt).toBeNull();
    expect(orders.recentDeploys).toEqual([]);

    expect(body.edges).toEqual([
      { upstream: 'checkout', downstream: 'payments', syncType: 'sync', circuitBreaker: false },
    ]);
    expect(body.infrastructure).toHaveLength(2);
    expect(body.infrastructure[0]).toMatchObject({
      entityId: 'monitoring/prometheus-0',
      kind: 'pod',
      namespace: 'monitoring',
    });
    expect(body.infrastructure[0]).not.toHaveProperty('tenantId');
    expect(body.infrastructure[0]).not.toHaveProperty('ignoredSecretLikeField');
    expect(body.infrastructure[1]).toMatchObject({
      entityId: 'cluster/nodes',
      kind: 'node',
      error: 'node read denied',
    });
    expect(body.infrastructure[1]).not.toHaveProperty('rawError');
  });

  test('RLS: another tenant sees an empty graph', async () => {
    const res = await api.request('/topology/graph', {
      headers: auth(await sign(orgB, ['responder'])),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphBody;
    expect(body.nodes).toEqual([]);
    expect(body.edges).toEqual([]);
    expect(body.infrastructure).toEqual([]);
  });
});

describe('GET /topology/blast-radius', () => {
  test('returns the blast radius for a service (payments failure impacts checkout)', async () => {
    const res = await api.request('/topology/blast-radius?service=payments', {
      headers: auth(await sign(orgA, ['responder'])),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      service: string;
      mapped: boolean;
      dependents: { direct: { name: string }[] };
    };
    expect(body.service).toBe('payments');
    expect(body.mapped).toBe(true);
    expect(body.dependents.direct.map((d) => d.name)).toContain('checkout');
  });

  test('400 when service query param is missing', async () => {
    const res = await api.request('/topology/blast-radius', {
      headers: auth(await sign(orgA, ['responder'])),
    });
    expect(res.status).toBe(400);
  });
});
