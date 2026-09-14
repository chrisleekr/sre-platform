import assert from 'node:assert/strict';
import {
  topologyRefKey,
  type TopologyCollection,
  type TopologyDiscovery,
} from '../../../packages/contracts/src/index';
import { persistTopologyDiscovery } from '../../../packages/db/src/index';
import { readDiscoveredTopology } from '../../../packages/topology/src/discovery-repo';
import { kubernetesTopology } from '../../../packages/connectors/src/data-sources/kubernetes/topology';
import { datadogLogRelations } from '../../../packages/connectors/src/data-sources/datadog/log-topology';
import type { DemoSeedDeps, SeededConnectors } from './demo-environment';

const CLUSTER = '11111111-2222-4333-8444-555555555555';
const API = 'https://k8s.internal';
const workloads = [
  ['checkout-api', 'checkout', 'checkout-api-7d9f4b8c6-9wqmt', '10.0.1.10'],
  ['orders-service', 'orders', 'orders-service-5c4b7a9d2-lm8vz', '10.0.2.10'],
  ['inventory-service', 'orders', 'inventory-service-6f8d2c1b4-t7nrs', '10.0.2.11'],
  ['notification-worker', 'platform', 'notification-worker-84bd6e5f9-2hqxc', '10.0.3.10'],
  ['checkout-api', 'staging', 'checkout-api-staging', '10.0.4.10'],
] as const;

/** Invented provider inventory, normalized by the same adapter used in production. */
export async function demoTopologyInventory(tenantId: string, connectorId: string) {
  const metadata = (name: string, namespace: string, uid: string) => ({ name, namespace, uid });
  const pods = workloads.map(([service, namespace, name, ip]) => ({
    metadata: {
      ...metadata(name, namespace, `pod-${namespace}-${service}`),
      labels: {
        'tags.datadoghq.com/service': service,
        'tags.datadoghq.com/env': namespace === 'staging' ? 'staging' : 'production',
      },
      annotations: {
        'org.opencontainers.image.source': `https://gitlab.internal/acme/${service}`,
        'org.opencontainers.image.revision': '9c14aa2f0b7d4e1a8f3c6b52d7e0a419cc83b6d2',
      },
      ownerReferences: [
        { kind: 'Deployment', uid: `deployment-${namespace}-${service}`, controller: true },
      ],
    },
    spec: { containers: [{ name: service, ports: [{ containerPort: 8080 }] }] },
    status: { podIP: ip },
  }));
  const reader = kubernetesTopology(
    {
      id: connectorId,
      tenantId,
      type: 'kubernetes',
      name: 'Production cluster',
      settings: { apiUrl: API },
      getCredential: async () => 'demo-not-a-real-credential',
    },
    (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/kube-system')) return Response.json({ metadata: { uid: CLUSTER } });
      if (path.endsWith('/pods')) return Response.json({ items: pods });
      if (path.endsWith('/deployments'))
        return Response.json({
          items: workloads.map(([service, namespace]) => ({
            metadata: metadata(service, namespace, `deployment-${namespace}-${service}`),
          })),
        });
      if (path.endsWith('/services'))
        return Response.json({
          items: [
            {
              metadata: metadata('inventory-api', 'orders', 'service-inventory-api'),
              spec: { clusterIP: '10.96.0.20', ports: [{ port: 8080 }] },
            },
          ],
        });
      return Response.json({ items: [] });
    }) as typeof fetch,
    async () => ['93.184.216.34'],
  );
  return reader.discover();
}

/** Persist bracketing inventory observations before parsing sampled request evidence. */
export async function seedDiscoveredTopology(
  deps: Pick<DemoSeedDeps, 'appDb' | 'tenantId' | 'now'>,
  connectors: SeededConnectors,
) {
  const time = (ago: number) => new Date(deps.now.getTime() - ago).toISOString();
  const persist = async (id: string, observedAt: string, collections: TopologyCollection[]) => {
    assert.ok(
      await persistTopologyDiscovery(
        deps.appDb,
        deps.tenantId,
        { id, lifecycleVersion: 0 },
        { observedAt, collections },
      ),
      'Demo discovery must be persisted',
    );
  };
  const inventory: TopologyDiscovery = await demoTopologyInventory(
    deps.tenantId,
    connectors.kubernetes,
  );
  await persist(connectors.kubernetes, time(180_000), inventory.collections);
  await persist(connectors.kubernetes, time(30_000), inventory.collections);

  const scopes = ['checkout', 'orders', 'platform'].map((namespace) => ({
    clusterId: CLUSTER,
    namespace,
  }));
  const requests = [
    [workloads[0], '10.0.2.10:8080', 'OK'],
    [workloads[1], '10.0.2.11:8080', 'Unavailable'],
    [workloads[1], '10.0.3.10:8080', 'OK'],
    [workloads[0], '10.96.0.20:8080', 'Unavailable'],
    [workloads[0], '10.0.9.99:8080', 'Unavailable'],
  ] as const;
  const relations = requests.flatMap(([workload, peer, code]) =>
    datadogLogRelations(
      {
        attributes: {
          timestamp: time(90_000),
          tags: [
            `orch_cluster_id:${CLUSTER}`,
            `kube_namespace:${workload[1]}`,
            `pod_name:${workload[2]}`,
          ],
          attributes: { grpc: { component: 'client', code }, peer: { address: peer } },
        },
      },
      scopes,
      time(240_000),
      time(30_000),
    ),
  );
  // The Datadog reader attaches its configured site to the parser's normalized evidence.
  for (const relation of relations)
    relation.attributes = { ...relation.attributes, datadogSite: 'datadoghq.eu' };
  await persist(connectors.datadog, time(20_000), [
    {
      key: 'logs',
      completeness: 'partial',
      issue: 'sampling',
      runtimeScopes: scopes,
      entities: [],
      relations,
    },
  ]);

  // Reuse the exact source identities emitted by Kubernetes, not a second name-based catalog.
  const repositories = [
    ...new Map(
      inventory.collections
        .flatMap((c) => c.entities)
        .filter((e) => e.kind === 'repository')
        .map((e) => [topologyRefKey(e.ref), e]),
    ).values(),
  ];
  await persist(connectors.gitlab, time(30_000), [
    {
      key: 'repositories',
      completeness: 'complete',
      entities: repositories,
      relations: [],
    },
  ]);
  const application = {
    ref: {
      authority: 'argocd:https://argocd.internal',
      kind: 'Application',
      id: 'production/checkout-api',
    },
    kind: 'deployment' as const,
    name: 'checkout-api',
    scope: { project: 'production', namespace: 'argocd' },
    attributes: {},
  };
  const deployment = inventory.collections
    .flatMap((c) => c.entities)
    .find(
      (e) =>
        e.ref.kind === 'Deployment' &&
        e.name === 'checkout-api' &&
        e.scope.namespace === 'checkout',
    )!;
  await persist(connectors.argocd, time(30_000), [
    {
      key: 'production/applications',
      completeness: 'complete',
      entities: [application],
      relations: [
        {
          from: application.ref,
          to: deployment.ref,
          kind: 'manages',
          evidence: 'provider_reference',
          description: 'Argo CD tracked Kubernetes resource',
        },
      ],
    },
  ]);

  // Fail capture if real persistence or identity resolution stops producing the documented story.
  const graph = await readDiscoveredTopology(deps.appDb, deps.tenantId);
  const calls = graph.relations.filter((edge) => edge.kind === 'calls');
  assert.equal(calls.filter((edge) => edge.fromKey && edge.toKey).length, 4);
  assert.equal(calls.filter((edge) => !edge.toKey).length, 1);
  const services = new Set(
    graph.operational.subjects.filter((s) => s.kind === 'service').map((s) => s.key),
  );
  assert.equal(
    graph.operational.relations.filter(
      (edge) => edge.kind === 'calls' && services.has(edge.from) && services.has(edge.to),
    ).length,
    3,
  );
  assert.equal(
    graph.operational.subjects.filter((s) => s.kind === 'service' && s.name === 'checkout-api')
      .length,
    2,
  );
}
