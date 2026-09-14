import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  connectorConfigs,
  persistTopologyDiscovery,
  listTopologyDiscovery,
  type DbHandle,
} from '@sre/db';
import { topologyRefKey, type TopologyEntity } from '@sre/contracts';
import { datadogLogRelations } from '../../../connectors/src/data-sources/datadog/log-topology';
import { readDiscoveredTopology } from '../discovery-repo';

const tenantId = randomUUID(),
  runtime = randomUUID(),
  logs = randomUUID(),
  cluster = randomUUID();
let admin: DbHandle, app: DbHandle;
const base = Date.now() - 120_000;
const time = (offset: number) => new Date(base + offset).toISOString();
const scopes = [{ clusterId: cluster, namespace: 'apps' }];
const pod = (id: string, name: string, ip: string): TopologyEntity => ({
  ref: { authority: `kubernetes-cluster:${cluster}`, kind: 'Pod', id },
  kind: 'workload',
  name,
  scope: { cluster: `kubernetes-cluster:${cluster}`, namespace: 'apps' },
  attributes: { uid: id },
  network: { addresses: [ip], ports: [8080] },
});
const caller = pod('caller', 'caller', '10.0.0.1'),
  target = pod('original', 'server', '10.0.0.2');
const inventory = (entities: TopologyEntity[], offset: number) =>
  persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: runtime, lifecycleVersion: 0 },
    {
      observedAt: time(offset),
      collections: [
        {
          key: 'pods',
          completeness: 'complete',
          scan: { cursor: null, incomplete: false },
          entities,
          relations: [],
        },
      ],
    },
  );
beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Traffic persistence' });
  await admin.db.insert(connectorConfigs).values([
    { id: runtime, tenantId, type: 'kubernetes', name: 'Runtime' },
    { id: logs, tenantId, type: 'datadog', name: 'Logs' },
  ]);
});
afterAll(async () => {
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await Promise.all([admin.close(), app.close()]);
});

test('resolves persisted log times through replacement and IP reuse without moving historical ownership', async () => {
  await inventory([caller, target], 0);
  await inventory([caller, target], 30_000);
  const rows = await listTopologyDiscovery(app.db, tenantId);
  expect(
    rows.find((row) => row.collection.key === 'pods')!.collection.entities[0]!.firstObservedAt,
  ).toBe(time(0));
  const relation = (offset: number, namespace = 'apps') =>
    datadogLogRelations(
      {
        attributes: {
          timestamp: time(offset),
          tags: [`orch_cluster_id:${cluster}`, `kube_namespace:${namespace}`, 'pod_name:caller'],
          attributes: {
            grpc: { component: 'client', code: 'OK' },
            peer: { address: '10.0.0.2:8080' },
          },
        },
      },
      [{ clusterId: cluster, namespace }],
      time(-1000),
      time(90_000),
    );
  await persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: logs, lifecycleVersion: 0 },
    {
      observedAt: time(40_000),
      collections: [
        {
          key: 'logs',
          completeness: 'partial',
          runtimeScopes: scopes,
          entities: [],
          relations: relation(15_000),
        },
      ],
    },
  );
  let graph = await readDiscoveredTopology(app.db, tenantId);
  expect(graph.relations.find((r) => r.kind === 'calls')).toMatchObject({
    fromKey: topologyRefKey(caller.ref),
    toKey: topologyRefKey(target.ref),
    stale: false,
  });
  const replacement = pod('replacement', 'server', '10.0.0.2');
  await inventory([caller, replacement], 60_000);
  graph = await readDiscoveredTopology(app.db, tenantId);
  expect(graph.relations.find((r) => r.kind === 'calls')).toMatchObject({
    toKey: topologyRefKey(target.ref),
    stale: true,
  });
  expect(graph.relations.find((r) => r.kind === 'calls')!.toKey).not.toBe(
    topologyRefKey(replacement.ref),
  );
  await inventory(
    [caller, { ...replacement, network: { addresses: ['10.0.0.3'], ports: [8080] } }],
    70_000,
  );
  const facts = (await listTopologyDiscovery(app.db, tenantId)).find(
    (row) => row.collection.key === 'pods',
  )!.collection.entities;
  expect(facts.find((f) => f.value.ref.id === 'replacement')).toMatchObject({
    firstObservedAt: time(70_000),
    history: [{ observedAt: time(60_000) }],
  });
  await persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: logs, lifecycleVersion: 0 },
    {
      observedAt: time(80_000),
      collections: [
        {
          key: 'logs',
          completeness: 'partial',
          runtimeScopes: scopes,
          entities: [],
          relations: relation(65_000),
        },
      ],
    },
  );
  graph = await readDiscoveredTopology(app.db, tenantId);
  expect(graph.relations.find((r) => r.evidenceAt === time(65_000))?.toKey).toBeNull();
});

test('multi-page completion preserves continuous bindings from earlier pages', async () => {
  const isolated = randomUUID();
  await admin.db
    .insert(connectorConfigs)
    .values({ id: isolated, tenantId, type: 'kubernetes', name: 'Paged' });
  const persist = (entities: TopologyEntity[], offset: number, cursor: string | null) =>
    persistTopologyDiscovery(
      app.db,
      tenantId,
      { id: isolated, lifecycleVersion: 0 },
      {
        observedAt: time(offset),
        collections: [
          {
            key: 'pods',
            completeness: cursor ? 'partial' : 'complete',
            scan: { cursor, incomplete: false },
            entities,
            relations: [],
          },
        ],
      },
    );
  await persist([caller, target], 0, null);
  await persist([caller], 20_000, 'next');
  await persist([target], 30_000, null);
  const row = (await listTopologyDiscovery(app.db, tenantId)).find(
    (row) => row.collection.connectorId === isolated && row.collection.key === 'pods',
  )!;
  expect(row.collection.entities).toHaveLength(2);
  expect(
    row.collection.entities.every((fact) => fact.firstObservedAt === time(0) && !fact.retired),
  ).toBe(true);
  expect(row.collection.entities.find((fact) => fact.value.ref.id === 'caller')!.observedAt).toBe(
    time(20_000),
  );
});

test('filters previously stored logs outside the current namespace admission', async () => {
  const relation = datadogLogRelations(
    {
      attributes: {
        timestamp: time(90_000),
        tags: [`orch_cluster_id:${cluster}`, 'kube_namespace:other', 'pod_name:private'],
        attributes: {
          grpc: { component: 'client', code: 'OK' },
          peer: { address: '10.0.0.2:8080' },
        },
      },
    },
    [{ clusterId: cluster, namespace: 'other' }],
    time(0),
    time(100_000),
  );
  await persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: logs, lifecycleVersion: 0 },
    {
      observedAt: time(100_000),
      collections: [
        {
          key: 'logs',
          completeness: 'partial',
          runtimeScopes: [...scopes, { clusterId: cluster, namespace: 'other' }],
          entities: [],
          relations: relation,
        },
      ],
    },
  );
  expect(JSON.stringify(await readDiscoveredTopology(app.db, tenantId))).not.toContain('private');
  await persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: logs, lifecycleVersion: 0 },
    {
      observedAt: time(110_000),
      collections: [
        {
          key: 'logs',
          completeness: 'partial',
          runtimeScopes: scopes,
          entities: [],
          relations: [],
        },
      ],
    },
  );
  expect(JSON.stringify(await listTopologyDiscovery(app.db, tenantId))).not.toContain('private');
});
