import { seedMembership } from '@sre/db/test-support';
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
  incidentFeedback,
  slos,
  resolveIncidentEntityContext,
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
import {
  verifyDiscoveredTopologyAccess,
  verifyDeclarationHistory,
  type GraphBody,
} from './topology-graph.fixture';
import { verifyTopologyIncidentSelection } from './topology-incident-selection.fixture';

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

test('selected incident overlay and dependency impact share the same scoped identity', async () => {
  await verifyTopologyIncidentSelection(
    api,
    admin.db,
    app.db,
    tenantA,
    await sign(orgA, []),
    await sign(orgB, []),
  );
});

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
    await admin.db.delete(incidentFeedback).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
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

describe('GET /topology/graph', () => {
  test('runtime mapping requires a tenant-owned source and catalog service and supports correction and removal', async () => {
    const [source] = await admin.db
      .select({ id: connectorConfigs.id })
      .from(connectorConfigs)
      .where(sql`tenant_id = ${tenantA}`);
    const token = await sign(orgA, ['responder']);
    const input = {
      connectorId: source!.id,
      serviceName: 'checkout',
      namespace: 'monitoring',
      environment: 'production',
      labelKey: '',
      labelValue: '',
      rationale: 'Operator confirmed this isolated namespace.',
    };
    const save = (body: unknown, bearer = token) =>
      api.request('/topology/runtime-bindings', {
        method: 'PUT',
        headers: { ...auth(bearer), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await save({ ...input, serviceName: 'unregistered' })).status).toBe(400);
    expect((await save({ ...input, labelKey: 'app', labelValue: '' })).status).toBe(400);
    expect((await save({ ...input, labelKey: 'team', labelValue: 'payments' })).status).toBe(400);
    const created = await save(input);
    expect(created.status).toBe(200);
    const { binding } = (await created.json()) as {
      binding: { id: string; confirmedByUserId: string };
    };
    expect(binding.confirmedByUserId).toBeTruthy();
    expect(
      (await save({ ...input, serviceName: 'conflicting-new-service', createService: true }))
        .status,
    ).toBe(409);
    expect(
      await admin.db
        .select()
        .from(services)
        .where(sql`tenant_id = ${tenantA} and name = 'conflicting-new-service'`),
    ).toEqual([]);
    const other = await sign(orgB, ['responder']);
    expect((await save(input, other)).status).toBe(400);
    const foreignDelete = await api.request(`/topology/runtime-bindings/${binding.id}`, {
      method: 'DELETE',
      headers: auth(other),
    });
    expect(foreignDelete.status).toBe(404);
    expect(await foreignDelete.json()).toEqual({
      error: 'This runtime mapping is unavailable in this workspace.',
    });
    const changed = await save({
      ...input,
      environment: 'staging',
      rationale: 'Corrected environment.',
    });
    expect(((await changed.json()) as { binding: { id: string } }).binding.id).toBe(binding.id);
    const graphResponse = await api.request('/topology/graph', { headers: auth(token) });
    const graphBody = (await graphResponse.json()) as GraphBody & {
      runtimeBindings: Array<{ id: string; environment: string }>;
    };
    expect(graphBody.runtimeBindings).toEqual([
      expect.objectContaining({ id: binding.id, environment: 'staging' }),
    ]);
    expect(graphBody.nodes.find((node) => node.name === 'checkout')?.sources).toContain(
      'kubernetes',
    );
    expect(graphBody.nodes.some((node) => node.name === 'monitoring')).toBe(false);
    expect(
      (
        await api.request(`/topology/runtime-bindings/${binding.id}`, {
          method: 'DELETE',
          headers: auth(token),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.request(`/topology/runtime-bindings/${binding.id}`, {
          method: 'DELETE',
          headers: auth(token),
        })
      ).status,
    ).toBe(404);
    const after = await api.request('/topology/graph', { headers: auth(token) });
    expect(((await after.json()) as { runtimeBindings: unknown[] }).runtimeBindings).toEqual([]);
    const atomic = await save({ ...input, serviceName: 'new-bound-service', createService: true });
    expect(atomic.status).toBe(200);
    const saved = (await atomic.json()) as { binding: { id: string } };
    expect((await save({ ...input, serviceName: 'checkout', replaceExisting: true })).status).toBe(
      200,
    );
    await api.request(`/topology/runtime-bindings/${saved.binding.id}`, {
      method: 'DELETE',
      headers: auth(token),
    });
    await admin.db
      .delete(services)
      .where(sql`tenant_id = ${tenantA} and name = 'new-bound-service'`);
  });
  test('includes active incident summaries beyond the incident queue page limit', async () => {
    const inserted = await admin.db
      .insert(incidents)
      .values(
        Array.from({ length: 105 }, () => ({
          tenantId: tenantA,
          fingerprint: randomUUID(),
          alertSource: 'test',
          service: 'monitoring',
          severity: 'sev3',
          status: 'open' as const,
        })),
      )
      .returning({ id: incidents.id });
    try {
      const response = await api.request('/topology/graph', {
        headers: auth(await sign(orgA, ['responder'])),
      });
      const body = (await response.json()) as {
        incidents: Array<{ id: string }>;
        incidentMappings: Array<{ incidentId: string }>;
      };
      expect(response.status).toBe(200);
      expect(body.incidents.map((incident) => incident.id)).toEqual(
        expect.arrayContaining(inserted.map((incident) => incident.id)),
      );
      expect(body.incidentMappings.map((mapping) => mapping.incidentId)).toEqual(
        expect.arrayContaining(inserted.map((incident) => incident.id)),
      );
    } finally {
      await admin.db.delete(incidents).where(
        sql`id in (${sql.join(
          inserted.map((incident) => sql`${incident.id}::uuid`),
          sql`, `,
        )})`,
      );
    }
  });
  test('keeps namespace inventory separate from registered services', async () => {
    const res = await api.request('/topology/graph', {
      headers: auth(await sign(orgA, ['responder'])),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphBody;

    const byName = new Map(body.nodes.map((n) => [n.name, n]));
    // listServices orders by name, so the graph nodes come back alphabetical.
    expect(body.nodes.map((n) => n.name)).toEqual(['checkout', 'orders', 'payments']);

    const checkout = byName.get('checkout')!;
    expect(checkout.criticality).toBe('tier1');
    expect(checkout.lastDeployAt).toBe(NEW.toISOString());
    // Newest-first, both deploys present.
    expect(checkout.recentDeploys.map((d) => d.sha)).toEqual([
      'sha-checkout-new',
      'sha-checkout-old',
    ]);
    expect(checkout.sources).toEqual(['catalog', 'deployment']);

    expect(byName.has('monitoring')).toBe(false);

    const orders = byName.get('orders')!;
    expect(orders.lastDeployAt).toBeNull();
    expect(orders.recentDeploys).toEqual([]);

    expect(body.edges).toEqual([
      {
        upstream: 'checkout',
        downstream: 'payments',
        syncType: 'sync',
        circuitBreaker: false,
        protocol: null,
        environment: '',
        rationale: null,
        confirmedByUserId: null,
        lastConfirmedAt: null,
      },
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
  test('service reliability exposes only this tenant enabled objectives and their supporting queries', async () => {
    const definition = {
      tenantId: tenantA,
      name: 'checkout-availability',
      service: 'checkout',
      sliType: 'availability',
      target: 0.999,
      windowDays: 30,
      metricQuery: 'sum(errors) / sum(requests)',
      connectorType: 'prometheus',
    };
    await admin.db
      .insert(slos)
      .values([definition, { ...definition, name: 'disabled-objective', enabled: false }]);
    try {
      const response = await api.request('/topology/services/checkout/reliability', {
        headers: auth(await sign(orgA, [])),
      });
      expect(await response.json()).toMatchObject({
        objectives: [
          expect.objectContaining({
            name: definition.name,
            metricQuery: definition.metricQuery,
            target: 0.999,
            evaluation: null,
          }),
        ],
      });
      const foreign = await api.request('/topology/services/checkout/reliability', {
        headers: auth(await sign(orgB, [])),
      });
      expect(await foreign.json()).toEqual({ objectives: [] });
    } finally {
      await admin.db.delete(slos).where(sql`tenant_id = ${tenantA}`);
    }
  });
  test('records scoped declarations and reconstructs their earlier version without current runtime', async () => {
    await verifyDeclarationHistory(api, await sign(orgA, []), await sign(orgB, []));
  });

  test('an incident without entity candidates can be assigned and restored with tenant isolation', async () => {
    const [incident] = await admin.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(sql`tenant_id = ${tenantA} and title = 'Monitoring unavailable'`);
    const token = await sign(orgA, ['responder']);
    const assign = (names: string[], bearer = token) =>
      api.request(`/topology/incidents/${incident!.id}/services`, {
        method: 'PUT',
        headers: { ...auth(bearer), 'content-type': 'application/json' },
        body: JSON.stringify({
          services: names,
          rationale: 'Confirmed affected application from the incident.',
        }),
      });
    expect((await assign(['checkout'], await sign(orgB, ['responder']))).status).toBe(404);
    expect((await assign(['unknown-service'])).status).toBe(404);
    expect((await assign(['checkout'])).status).toBe(200);
    const context = await resolveIncidentEntityContext(app.db, tenantA, incident!.id);
    expect(context?.observations).toEqual([]);
    expect(context?.mappings).toEqual([
      expect.objectContaining({
        serviceName: 'checkout',
        method: 'human',
        confirmedByUserId: expect.any(String),
      }),
    ]);
    const response = await api.request('/topology/graph', { headers: auth(token) });
    expect(await response.json()).toMatchObject({
      incidentMappings: [
        expect.objectContaining({ incidentId: incident!.id, services: ['checkout'] }),
      ],
    });
    expect((await assign([])).status).toBe(200);
    expect((await resolveIncidentEntityContext(app.db, tenantA, incident!.id))?.mappings).toEqual(
      [],
    );
  });
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

  test('serves discovered resources without a catalog service and does not expose another tenant inventory', async () => {
    await verifyDiscoveredTopologyAccess(
      api,
      admin.db,
      app.db,
      tenantB,
      await sign(orgB, ['responder']),
      await sign(orgA, ['responder']),
    );
  });
});
