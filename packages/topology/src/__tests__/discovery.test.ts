import { expect, test } from 'vitest';
import { topologyRefKey, type TopologyEntity, type TopologyRelation } from '@sre/contracts';
import { resolveDiscoveredTopology } from '../discovery';
import { discoveredOperationalTopology } from '../operational';
import { discoveredBlastRadius } from '../discovered-impact';

const now = Date.now();
const at = new Date(now).toISOString();
const entity = (id: string, cluster = 'one'): TopologyEntity => ({
  ref: { authority: cluster, kind: 'Deployment', id },
  kind: 'workload',
  name: 'api',
  scope: { namespace: 'production' },
  attributes: { uid: id },
});
function collection(id: string, entities: TopologyEntity[], relations: TopologyRelation[] = []) {
  return {
    connectorId: id,
    connectorName: id,
    connectorType: 'test',
    key: 'resources',
    observedAt: at,
    attemptedAt: at,
    completeness: 'complete' as const,
    issue: null,
    entities: entities.map((value) => ({ value, observedAt: at })),
    relations: relations.map((value) => ({ value, observedAt: at })),
  };
}
test('same scoped resource deduplicates across connectors but same names and labels do not', () => {
  const workload = entity('uid');
  const graph = resolveDiscoveredTopology(
    [
      collection('first', [workload]),
      collection('second', [workload, entity('uid', 'other-cluster')]),
    ],
    now,
  );
  expect(graph.entities).toHaveLength(2);
  expect(graph.entities.find((e) => e.ref.authority === 'one')?.sources).toHaveLength(2);
});

test('coverage exposes safe scan progress without leaking provider cursors', () => {
  const input = {
    ...collection('source', []),
    scan: { cursor: 'private-provider-cursor', incomplete: false },
  };
  const graph = resolveDiscoveredTopology([input], now);
  expect(graph.coverage[0]).toMatchObject({ hasMore: true, scanHasGaps: false });
  expect(JSON.stringify(graph)).not.toContain('private-provider-cursor');
});

test.each([false, true])(
  'one live source keeps a shared identity fresh regardless of retired source order: %s',
  (reverse) => {
    const workload = entity('shared');
    const live = collection('live', [workload]),
      retired = {
        ...collection('retired', [workload]),
        entities: [{ value: workload, observedAt: at, retired: true }],
      };
    const graph = resolveDiscoveredTopology(reverse ? [retired, live] : [live, retired], now);
    expect(graph.entities[0]!.stale).toBe(false);
  },
);

test('retired resource aliases cannot shadow a live replacement routing target', () => {
  const alias = { authority: 'cluster-api', kind: 'Service', id: 'apps/api' };
  const old = { ...entity('old'), kind: 'endpoint' as const, aliases: [alias] },
    current = { ...entity('new'), kind: 'endpoint' as const, aliases: [alias] };
  const slice = entity('slice');
  const data = collection(
    'kubernetes',
    [old, current, slice],
    [
      {
        from: alias,
        to: slice.ref,
        kind: 'routes_to',
        evidence: 'provider_reference',
        description: 'Current routing',
      },
    ],
  );
  const graph = resolveDiscoveredTopology(
    [
      {
        ...data,
        entities: data.entities.map((fact) => ({ ...fact, retired: fact.value.ref.id === 'old' })),
      },
    ],
    now,
  );
  expect(graph.relations[0]!.fromKey).toBe(topologyRefKey(current.ref));
  expect(graph.conflicts).toEqual([]);
});

test('joins a unique alternate locator and preserves typed relations and both sources', () => {
  const workload = entity('uid');
  const locator = { authority: 'api-server', kind: 'resource', id: 'deployment/production/api' };
  workload.aliases = [locator];
  const app: TopologyEntity = { ...entity('app'), kind: 'deployment', name: 'GitOps application' };
  const argoWorkload = { ...workload, ref: locator, aliases: [] };
  const graph = resolveDiscoveredTopology(
    [
      collection('k8s', [workload]),
      collection(
        'argo',
        [app, argoWorkload],
        [
          {
            from: app.ref,
            to: locator,
            kind: 'manages',
            evidence: 'provider_reference',
            description: 'Resource tree',
          },
        ],
      ),
    ],
    now,
  );
  expect(graph.entities).toHaveLength(2);
  expect(graph.entities.find((e) => e.ref.id === 'uid')?.sources.map((s) => s.connectorId)).toEqual(
    ['k8s', 'argo'],
  );
  expect(graph.relations[0]).toMatchObject({
    kind: 'manages',
    toKey: topologyRefKey(workload.ref),
    stale: false,
  });
  expect(graph.relations.some((r) => r.kind === 'calls')).toBe(false);
});

test('recreated UIDs sharing a locator remain ambiguous until complete inventory retires the old instance', () => {
  const locator = { authority: 'api-server', kind: 'resource', id: 'deployment/production/api' };
  const first = { ...entity('old'), aliases: [locator] },
    second = { ...entity('new'), aliases: [locator] };
  const relation: TopologyRelation = {
    from: first.ref,
    to: locator,
    kind: 'manages',
    evidence: 'provider_reference',
    description: 'Ambiguous',
  };
  const graph = resolveDiscoveredTopology([collection('k8s', [first, second], [relation])], now);
  expect(graph.entities).toHaveLength(2);
  expect(graph.relations[0]?.toKey).toBeNull();
  expect(graph.conflicts).toEqual([{ ref: locator, reason: 'ambiguous_reference' }]);
});

test('conflicting UIDs and environment scope cannot be bridged by an alias', () => {
  const locator = { authority: 'api-server', kind: 'resource', id: 'api' };
  const workload = { ...entity('uid'), aliases: [locator] };
  const other = { ...entity('other-uid'), ref: locator, scope: { namespace: 'staging' } };
  const graph = resolveDiscoveredTopology(
    [collection('k8s', [workload]), collection('argo', [other])],
    now,
  );
  expect(graph.entities).toHaveLength(2);
  expect(graph.conflicts).toHaveLength(1);
});

test('cyclic aliases do not erase entities', () => {
  const a = entity('a'),
    b = entity('b');
  a.aliases = [b.ref];
  b.aliases = [a.ref];
  const graph = resolveDiscoveredTopology([collection('cycle', [a, b])], now);
  expect(graph.entities).toHaveLength(2);
  expect(graph.conflicts).toHaveLength(2);
});

test('failure and retained old observations never report fresh relationships', () => {
  const a = entity('a'),
    b = entity('b');
  const input = collection(
    'source',
    [a, b],
    [{ from: a.ref, to: b.ref, kind: 'calls', evidence: 'observed', description: 'Trace' }],
  );
  input.entities[1]!.observedAt = new Date(now - 700_000).toISOString();
  const graph = resolveDiscoveredTopology([input], now);
  expect(graph.entities.find((e) => e.ref.id === 'b')?.stale).toBe(true);
  expect(graph.relations[0]?.stale).toBe(true);
  const failed = resolveDiscoveredTopology([{ ...input, completeness: 'unavailable' }], now);
  expect(failed.entities.every((e) => e.stale)).toBe(true);
});

test.each([
  [0, false],
  [-600_000, false],
  [-600_001, true],
  [1, true],
  [86_400_000, true],
])('freshness uses a bounded past observation window (%i ms)', (offset, stale) => {
  const input = collection('source', [entity('api')]);
  input.entities[0]!.observedAt = new Date(now + offset).toISOString();
  expect(resolveDiscoveredTopology([input], now).entities[0]?.stale).toBe(stale);
});

test.each(['entity', 'relation'])(
  'future %s evidence cannot enter current dependency impact',
  (target) => {
    const caller = { ...entity('caller'), name: 'caller', kind: 'service' as const },
      dependency = { ...entity('dependency'), name: 'dependency', kind: 'service' as const };
    const input = collection(
      'source',
      [caller, dependency],
      [
        {
          from: caller.ref,
          to: dependency.ref,
          kind: 'calls',
          evidence: 'observed',
          description: 'Trace',
        },
      ],
    );
    const fact = target === 'entity' ? input.entities[0]! : input.relations[0]!;
    fact.observedAt = new Date(now + 86_400_000).toISOString();
    const graph = resolveDiscoveredTopology([input], now);
    expect(graph.relations[0]?.stale).toBe(true);
    expect(graph.relations[0]?.sources).toHaveLength(1);
    const operational = discoveredOperationalTopology(graph);
    expect(operational.relations[0]?.stale).toBe(true);
    const impact = discoveredBlastRadius(
      operational,
      operational.subjects.find((subject) => subject.name === 'dependency')!,
      { services: [], edges: [] },
    );
    expect(impact.dependents.unclassified).toEqual([]);
    expect(impact.note).toContain('1 stale, inferred or ambiguous');
  },
);

test('a fresh name-only locator cannot refresh a stale UID-backed resource incarnation', () => {
  const original = entity('uid');
  const locator = { authority: 'api-server', kind: 'resource', id: 'deployment/production/api' };
  original.aliases = [locator];
  const source = collection('runtime', [original]);
  source.entities[0]!.observedAt = new Date(now - 700_000).toISOString();
  const declaration = { ...original, ref: locator, aliases: [], attributes: {} };
  const graph = resolveDiscoveredTopology([source, collection('deployment', [declaration])], now);
  expect(graph.entities).toHaveLength(2);
  expect(graph.entities.find((e) => e.attributes.uid === 'uid')?.stale).toBe(true);
  expect(graph.conflicts).toHaveLength(1);
});

test.each([false, true])(
  'traffic endpoints use the canonical alias identity in either collection order: %s',
  (reverse) => {
    const locator = { authority: 'inventory', kind: 'Pod', id: 'pod-locator' };
    const pod: TopologyEntity = {
      ref: { authority: 'cluster', kind: 'Pod', id: 'pod-uid' },
      aliases: [locator],
      kind: 'workload',
      name: 'pod',
      scope: { cluster: 'kubernetes-cluster:one', namespace: 'apps' },
      attributes: { uid: 'pod-uid' },
      network: { addresses: ['10.0.0.1'], ports: [8080] },
    };
    const alias = { ...pod, ref: locator, aliases: [] };
    const target = entity('target');
    const traffic: TopologyRelation = {
      from: { authority: 'kubernetes-traffic:one', kind: 'pod_address', id: '["10.0.0.1"]' },
      to: target.ref,
      kind: 'calls',
      evidence: 'observed',
      description: 'Observed traffic',
    };
    const inventory = collection('canonical', [pod, target]);
    const sampled = {
      ...collection('sampled', [alias], [traffic]),
      entities: [
        { value: alias, observedAt: at, firstObservedAt: new Date(now - 1000).toISOString() },
      ],
    };
    const graph = resolveDiscoveredTopology(
      reverse ? [sampled, inventory] : [inventory, sampled],
      now,
    );
    expect(graph.entities.map((e) => e.key)).not.toContain(topologyRefKey(locator));
    expect(graph.relations[0]).toMatchObject({
      fromKey: topologyRefKey(pod.ref),
      toKey: topologyRefKey(target.ref),
      stale: false,
    });
    expect(discoveredOperationalTopology(graph).relations).toEqual([
      expect.objectContaining({
        from: topologyRefKey(pod.ref),
        to: topologyRefKey(target.ref),
        kind: 'calls',
      }),
    ]);
  },
);
