import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectorConfigs, persistTopologyDiscovery, type Db } from '@sre/db';
import type { makeApp } from '../app';

export interface GraphNode {
  name: string;
  team: string | null;
  criticality: string | null;
  lastDeployAt: string | null;
  recentDeploys: { sha: string; deployedAt: string }[];
  sources: string[];
}
export interface GraphBody {
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

/** Exercise discovery through the authenticated graph endpoint using the shared two-tenant harness. */
export async function verifyDiscoveredTopologyAccess(
  api: ReturnType<typeof makeApp>,
  admin: Db,
  app: Db,
  tenantId: string,
  ownToken: string,
  otherToken: string,
) {
  const id = randomUUID();
  await admin
    .insert(connectorConfigs)
    .values({ id, tenantId, type: 'prometheus', name: 'Telemetry' });
  await persistTopologyDiscovery(
    app,
    tenantId,
    { id, lifecycleVersion: 0 },
    {
      observedAt: new Date().toISOString(),
      collections: [
        {
          key: 'targets',
          completeness: 'complete',
          relations: [],
          entities: [
            {
              ref: { authority: `connector:${id}`, kind: 'endpoint', id: 'target-one' },
              kind: 'endpoint',
              name: 'External API',
              scope: {},
              attributes: {},
            },
          ],
        },
      ],
    },
  );
  const own = await api.request('/topology/graph', {
    headers: { authorization: `Bearer ${ownToken}` },
  });
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({
    nodes: [],
    discovery: {
      entities: [
        expect.objectContaining({
          name: 'External API',
          sources: [expect.objectContaining({ connectorId: id })],
        }),
      ],
    },
  });
  const foreign = await api.request('/topology/graph', {
    headers: { authorization: `Bearer ${otherToken}` },
  });
  expect(JSON.stringify(await foreign.json())).not.toContain('External API');
}

async function verifyCanonicalHistory(
  api: ReturnType<typeof makeApp>,
  token: string,
  before: string,
  oldGraph: GraphBody & { historicalAt: string },
) {
  const auth = (value: string) => ({ authorization: `Bearer ${value}` });
  const bareYear = await api.request('/topology/graph?at=2020', { headers: auth(token) });
  expect(bareYear.status).toBe(200);
  expect(await bareYear.json()).toMatchObject({ historicalAt: '2020-01-01T00:00:00.000Z' });
  const offset = before.replace('Z', '+00:00');
  const equivalent = await api.request(`/topology/graph?at=${encodeURIComponent(offset)}`, {
    headers: auth(token),
  });
  expect(equivalent.status).toBe(200);
  expect(await equivalent.json()).toEqual(oldGraph);
}

export async function verifyDeclarationHistory(
  api: ReturnType<typeof makeApp>,
  token: string,
  otherToken: string,
) {
  const auth = (value: string) => ({ authorization: `Bearer ${value}` });
  const input = {
    upstream: 'checkout',
    downstream: 'orders',
    environment: 'production',
    protocol: 'HTTPS',
    rationale: 'Verified in deployment configuration.',
    syncType: 'sync',
    circuitBreaker: false,
  };
  const save = (body: unknown) =>
    api.request('/topology/dependencies', {
      method: 'PUT',
      headers: { ...auth(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await save(input)).status).toBe(200);
  const historyResponse = await api.request('/topology/history', { headers: auth(token) });
  const before = (
    (await historyResponse.json()) as {
      changes: Array<{
        upstream: string;
        downstream: string;
        environment: string;
        validFrom: string;
      }>;
    }
  ).changes.find(
    (row) => row.downstream === 'orders' && row.environment === 'production',
  )!.validFrom;
  expect(
    (await save({ ...input, syncType: 'async', rationale: 'Now delivered asynchronously.' }))
      .status,
  ).toBe(200);
  const old = await api.request(`/topology/graph?at=${encodeURIComponent(before)}`, {
    headers: auth(token),
  });
  const oldGraph = (await old.json()) as GraphBody & { historicalAt: string };
  expect(oldGraph.historicalAt).toBe(before);
  await verifyCanonicalHistory(api, token, before, oldGraph);
  expect(oldGraph.infrastructure).toEqual([]);
  expect(oldGraph.edges).toContainEqual(
    expect.objectContaining({
      upstream: 'checkout',
      downstream: 'orders',
      syncType: 'sync',
      rationale: input.rationale,
      confirmedByUserId: expect.any(String),
    }),
  );
  const prod = await api.request('/topology/blast-radius?service=orders&environment=production', {
    headers: auth(token),
  });
  expect(await prod.json()).toMatchObject({
    dependents: { indirect: [expect.objectContaining({ name: 'checkout' })] },
  });
  const stage = await api.request('/topology/blast-radius?service=orders&environment=staging', {
    headers: auth(token),
  });
  expect(await stage.json()).toMatchObject({
    dependents: { direct: [], indirect: [], insulated: [] },
  });
  const foreign = await api.request(`/topology/graph?at=${encodeURIComponent(before)}`, {
    headers: auth(otherToken),
  });
  expect(await foreign.json()).toMatchObject({ nodes: [], edges: [] });
  expect(
    (await api.request('/topology/graph?at=not-a-date', { headers: auth(token) })).status,
  ).toBe(400);
}
