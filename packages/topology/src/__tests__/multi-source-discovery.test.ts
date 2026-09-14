import { expect, test } from 'vitest';
import {
  makeKubernetesConnector,
  makePrometheusConnector,
  makeDatadogConnector,
  type ConnectorConfig,
  type IDataSourceConnector,
} from '@sre/connectors';
import { topologyRefKey } from '@sre/contracts';
import { resolveDiscoveredTopology } from '../discovery';
import { discoveredOperationalTopology } from '../operational';
import { discoveredBlastRadius } from '../discovered-impact';

const lookup = async () => ['93.184.216.34'];
const at = new Date(Date.now() - 1000).toISOString();
const config = (
  type: ConnectorConfig['type'],
  settings: Record<string, unknown>,
): ConnectorConfig => ({
  id: `source-${type}`,
  name: type,
  tenantId: 'tenant',
  type,
  settings,
  getCredential: async () =>
    type === 'datadog'
      ? JSON.stringify({ apiKey: 'api', appKey: 'app' })
      : type === 'prometheus'
        ? JSON.stringify({ type: 'none' })
        : 'token',
});
const metadata = (name: string, uid: string) => ({ name, uid, namespace: 'production' });
const k8s = makeKubernetesConnector(
  config('kubernetes', { apiUrl: 'https://k8s.example' }),
  (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/kube-system')) return Response.json({ metadata: { uid: 'cluster-one' } });
    const items = path.endsWith('/deployments')
      ? [{ metadata: metadata('api-deployment', 'deployment-uid') }]
      : path.endsWith('/replicasets')
        ? [
            {
              metadata: {
                ...metadata('api-rs', 'rs-uid'),
                ownerReferences: [{ uid: 'deployment-uid', kind: 'Deployment', controller: true }],
              },
            },
          ]
        : path.endsWith('/pods')
          ? [
              {
                metadata: {
                  ...metadata('api-pod', 'pod-uid'),
                  ownerReferences: [{ uid: 'rs-uid', kind: 'ReplicaSet', controller: true }],
                },
              },
            ]
          : [];
    return Response.json({ items });
  }) as typeof fetch,
  lookup,
);
const prom = makePrometheusConnector(
  config('prometheus', { baseUrl: 'https://prom.example' }),
  (async () =>
    Response.json({
      status: 'success',
      data: {
        activeTargets: [
          {
            scrapePool: 'api',
            scrapeUrl: 'https://api.example/metrics',
            labels: { job: 'scrape-name-not-service' },
            discoveredLabels: {
              __meta_kubernetes_pod_uid: 'pod-uid',
              __meta_kubernetes_namespace: 'production',
            },
          },
        ],
      },
    })) as unknown as typeof fetch,
  lookup,
);
const dd = makeDatadogConnector(config('datadog', {}), (async () =>
  Response.json({
    data: [
      {
        attributes: {
          service: 'checkout',
          env: 'production',
          trace_id: 'trace',
          span_id: '1',
          parent_id: '0',
          start_timestamp: at,
          attributes: { 'k8s.pod.uid': 'pod-uid', 'k8s.namespace.name': 'production' },
        },
      },
      {
        attributes: {
          service: 'payments',
          env: 'production',
          trace_id: 'trace',
          span_id: '2',
          parent_id: '1',
          start_timestamp: at,
        },
      },
    ],
  })) as unknown as typeof fetch);

async function discover(connectors: IDataSourceConnector[]) {
  const collections = await Promise.all(
    connectors.map(async (connector) => {
      const result = await connector.topology!.discover();
      return result.collections.map((collection) => ({
        ...collection,
        connectorId: connector.id,
        connectorName: connector.name,
        connectorType: connector.type,
        observedAt: result.observedAt,
        attemptedAt: result.observedAt,
        issue: collection.issue ?? null,
        entities: collection.entities.map((value) => ({
          value,
          observedAt: value.evidenceAt ?? result.observedAt,
        })),
        relations: collection.relations.map((value) => ({
          value,
          observedAt: value.evidenceAt ?? result.observedAt,
        })),
      }));
    }),
  );
  return resolveDiscoveredTopology(collections.flat());
}

test('resolves catalog dependency references through exact IDs while keeping same-name APM identities distinct', async () => {
  const connector = makeDatadogConnector(config('datadog', {}), (async (input) => {
    const path = new URL(String(input)).pathname;
    const data = path.endsWith('/entity')
      ? ['checkout', 'payments'].map((name) => ({
          id: `catalog-${name}`,
          attributes: { name, kind: 'service', namespace: 'platform', tags: ['env:production'] },
        }))
      : path.endsWith('/relation')
        ? [
            {
              attributes: {
                type: 'RelationTypeDependsOn',
                from: { name: 'checkout', kind: 'service', namespace: 'platform' },
                to: { name: 'payments', kind: 'service', namespace: 'platform' },
              },
              relationships: {},
            },
          ]
        : [{ attributes: { service: 'checkout', env: 'production', start_timestamp: at } }];
    return Response.json({ data, meta: { count: data.length } });
  }) as typeof fetch);
  const graph = await discover([connector]);
  const operational = discoveredOperationalTopology(graph);
  expect(operational.subjects.filter((item) => item.name === 'checkout')).toHaveLength(2);
  const origin = graph.entities.find((item) => item.ref.id === 'catalog-payments')!;
  const caller = graph.entities.find((item) => item.ref.id === 'catalog-checkout')!;
  const relation = operational.relations.find((item) => item.kind === 'depends_on')!;
  expect(relation).toMatchObject({ from: caller.key, to: origin.key, evidence: 'declared' });
  const impact = discoveredBlastRadius(
    operational,
    operational.subjects.find((item) => item.key === origin.key)!,
    { services: [], edges: [] },
  );
  expect(impact.dependents.unclassified?.map((item) => item.subjectKey)).toEqual([caller.key]);
});

test('real adapters correlate telemetry and scrape targets to the same pod without catalog or manual mapping', async () => {
  const graph = await discover([k8s, prom, dd]);
  const pod = graph.entities.find((entity) => entity.attributes.uid === 'pod-uid')!;
  const monitor = graph.relations.find(
    (relation) => relation.kind === 'monitors' && relation.to.authority === 'kubernetes-object',
  )!;
  const association = graph.relations.find((relation) => relation.kind === 'runs_on')!;
  expect(monitor.toKey).toBe(pod.key);
  expect(association.toKey).toBe(pod.key);
  expect(association.stale).toBe(false);
  const operational = discoveredOperationalTopology(graph);
  expect(
    operational.subjects
      .filter((subject) => ['workload', 'service'].includes(subject.kind))
      .map((subject) => [subject.kind, subject.name]),
  ).toEqual([
    ['workload', 'api-deployment'],
    ['service', 'checkout'],
    ['service', 'payments'],
  ]);
  const workload = operational.subjects.find((subject) => subject.kind === 'workload')!;
  expect(workload.resourceKeys).toHaveLength(3);
  expect([...new Set(workload.sources.map((source) => source.connectorType))].sort()).toEqual([
    'datadog',
    'kubernetes',
    'prometheus',
  ]);
  const checkout = operational.subjects.find((subject) => subject.name === 'checkout')!;
  expect(checkout.resourceKeys).toEqual([pod.key]);
  expect(operational.relations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        from: checkout.key,
        to: workload.key,
        kind: 'runs_on',
        stale: false,
      }),
      expect.objectContaining({ from: checkout.key, kind: 'calls', stale: false }),
    ]),
  );
});

test('telemetry-only services and workload-only discovery both remain useful', async () => {
  expect(
    discoveredOperationalTopology(await discover([dd])).subjects.map((subject) => subject.name),
  ).toEqual(['checkout', 'payments']);
  const standalone = discoveredOperationalTopology(await discover([k8s]));
  expect(standalone.subjects.map((subject) => subject.name)).toEqual(['api-deployment']);
  expect(standalone.relations).toEqual([]);
});

test('pod service tags reach operational topology and exact monitoring links without a manual catalog', async () => {
  const tagged = makeKubernetesConnector(
    config('kubernetes', { apiUrl: 'https://k8s.example' }),
    (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/kube-system')) return Response.json({ metadata: { uid: 'cluster-one' } });
      return Response.json({
        items: path.endsWith('/pods')
          ? [
              {
                metadata: {
                  ...metadata('api-pod', 'pod-uid'),
                  labels: {
                    'tags.datadoghq.com/service': 'checkout',
                    'tags.datadoghq.com/env': 'production',
                  },
                },
              },
            ]
          : [],
      });
    }) as typeof fetch,
    lookup,
  );
  const graph = await discover([tagged, prom, dd]);
  const operational = discoveredOperationalTopology(graph);
  const key = graph.entities.find((item) => item.ref.kind === 'datadog-declared-service')!.key;
  const declaration = operational.subjects.find((item) => item.key === key)!;
  const pod = graph.entities.find((item) => item.attributes.uid === 'pod-uid')!;
  expect(declaration).toMatchObject({
    name: 'checkout',
    kind: 'service',
    scope: {
      cluster: 'kubernetes-cluster:cluster-one',
      namespace: 'production',
      environment: 'production',
    },
  });
  expect(declaration.resourceKeys).toEqual([pod.key]);
  expect(
    graph.relations.find((item) => item.kind === 'monitors' && item.toKey === pod.key),
  ).toBeDefined();
  expect(operational.relations.find((item) => item.from === declaration.key)).toMatchObject({
    kind: 'runs_on',
    evidence: 'declared',
    stale: false,
  });
  // Shared pod placement does not prove that provider service identities are equivalent.
  expect(operational.subjects.filter((item) => item.name === 'checkout')).toHaveLength(2);
  const impact = discoveredBlastRadius(operational, declaration, { services: [], edges: [] });
  expect(Object.values(impact.dependents).flat()).toEqual([]);
  expect(
    operational.relations
      .filter((item) => item.kind === 'calls')
      .some((item) => item.from === declaration.key || item.to === declaration.key),
  ).toBe(false);
});

test('an identical pod UID reported by different clusters makes the unscoped reference ambiguous', async () => {
  const graph = await discover([k8s, prom, dd]);
  const original = graph.entities.find((entity) => entity.attributes.uid === 'pod-uid')!;
  const other = {
    ...original,
    ref: { ...original.ref, authority: 'kubernetes-cluster:other' },
    scope: { ...original.scope, cluster: 'kubernetes-cluster:other' },
  };
  const expanded = resolveDiscoveredTopology([
    {
      connectorId: 'combined-fixture',
      connectorName: 'Discovery',
      connectorType: 'test',
      key: 'all',
      completeness: 'complete',
      observedAt: at,
      attemptedAt: at,
      issue: null,
      entities: [...graph.entities, { ...other, key: topologyRefKey(other.ref) }].map((value) => ({
        value,
        observedAt: at,
      })),
      relations: graph.relations.map((value) => ({ value, observedAt: at })),
    },
  ]);
  expect(expanded.relations.find((relation) => relation.kind === 'runs_on')?.toKey).toBeNull();
  expect(expanded.conflicts).toEqual(
    expect.arrayContaining([expect.objectContaining({ reason: 'ambiguous_reference' })]),
  );
});

test('inferred ownership and runtime associations cannot silently become verified runtime grouping', async () => {
  const graph = await discover([k8s, dd]);
  graph.relations = graph.relations.map((relation) =>
    relation.kind === 'owns' || relation.kind === 'runs_on'
      ? { ...relation, evidence: 'inferred' }
      : relation,
  );
  const operational = discoveredOperationalTopology(graph);
  expect(operational.subjects.filter((subject) => subject.kind === 'workload')).toHaveLength(3);
  expect(operational.subjects.find((subject) => subject.name === 'checkout')?.resourceKeys).toEqual(
    [],
  );
});
