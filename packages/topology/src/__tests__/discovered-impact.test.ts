import { expect, test } from 'vitest';
import type { OperationalTopology, TopologySubject } from '@sre/contracts';
import { selectTopologySubject } from '../selection';
import { discoveredBlastRadius, type DeclaredImpactEdge } from '../discovered-impact';

const service = (
  name: string,
  environment = 'production',
  key = `${name}:${environment}`,
): TopologySubject => ({
  key,
  name,
  kind: 'service',
  scope: { environment },
  resourceKeys: [],
  sources: [],
  stale: false,
});
const call = (
  from: TopologySubject,
  to: TopologySubject,
  overrides: Partial<OperationalTopology['relations'][number]> = {},
): OperationalTopology['relations'][number] => ({
  from: from.key,
  to: to.key,
  kind: 'calls',
  evidence: 'observed',
  evidenceKeys: [`${from.key}->${to.key}`],
  stale: false,
  ...overrides,
});
const none = { services: [], edges: [] };

test('selects exact scoped identities and rejects ambiguous names, conflicts and incompatible explicit keys', () => {
  const prod = service('checkout'),
    dev = service('checkout', 'development');
  const graph = { subjects: [prod, dev], relations: [] };
  expect(selectTopologySubject(graph, { name: 'checkout' }).status).toBe('ambiguous');
  expect(
    selectTopologySubject(graph, { name: 'checkout', scope: { environment: 'production' } }),
  ).toEqual({ status: 'resolved', subject: prod });
  expect(
    selectTopologySubject(graph, { key: dev.key, scope: { environment: 'production' } }).status,
  ).toBe('unmapped');
  expect(
    selectTopologySubject(
      { subjects: [{ ...prod, identityConflict: true }], relations: [] },
      { key: prod.key },
    ).status,
  ).toBe('ambiguous');
});

test('excludes monitoring, stale and inferred links from service-call exposure', () => {
  const api = service('api'),
    queue = service('queue'),
    worker = service('worker');
  const graph = {
    subjects: [api, queue, worker],
    relations: [
      call(api, queue),
      call(worker, queue, { kind: 'monitors' }),
      call(worker, queue, { evidence: 'inferred' }),
      call(worker, queue, { stale: true }),
    ],
  };
  const result = discoveredBlastRadius(graph, queue, none);
  expect(result.dependents.unclassified).toEqual([
    expect.objectContaining({
      name: 'api',
      subjectKey: api.key,
      scope: { environment: 'production' },
      hops: 1,
      evidenceKeys: [`${api.key}->${queue.key}`],
    }),
  ]);
  expect(result.dependents.direct).toEqual([]);
  expect(result.note).toContain('2 stale, inferred, ambiguous or non-service');
  expect(discoveredBlastRadius(graph, api, none).suspects).toEqual([
    expect.objectContaining({ subjectKey: queue.key, syncType: 'unknown' }),
  ]);
});

test('declared dependencies contribute possible exposure without inventing calls or sync semantics', () => {
  const api = service('api'),
    database = service('database'),
    other = service('api', 'staging');
  const graph = {
    subjects: [api, database, other],
    relations: [call(api, database, { kind: 'depends_on', evidence: 'declared' })],
  };
  const result = discoveredBlastRadius(graph, database, none);
  expect(result.dependents.unclassified?.map((item) => item.subjectKey)).toEqual([api.key]);
  expect(result.dependents.direct).toEqual([]);
  expect(result.note).toContain('dependency declarations, not observed outages');
  expect(graph.relations[0]!.kind).toBe('depends_on');
  expect(discoveredBlastRadius(graph, api, none).suspects[0]?.syncType).toBe('unknown');
});

test('preserves explicit cross-environment calls without connecting same-name peers', () => {
  const prod = service('api'),
    dev = service('api', 'development'),
    caller = service('caller', 'development');
  const result = discoveredBlastRadius(
    { subjects: [prod, dev, caller], relations: [call(caller, prod)] },
    prod,
    none,
  );
  expect(result.dependents.unclassified?.map((entry) => entry.subjectKey)).toEqual([caller.key]);
  expect(result.dependents.unclassified?.[0]?.scope).toEqual({ environment: 'development' });
});

test('incorporates scoped human declarations, including callers beyond an observed cross-environment edge', () => {
  const origin = service('database'),
    caller = service('api', 'development');
  const declared: DeclaredImpactEdge = {
    id: 'declaration',
    upstream: 'worker',
    downstream: 'api',
    environment: 'development',
    syncType: 'async',
    circuitBreaker: true,
  };
  const graph = { subjects: [origin, caller], relations: [call(caller, origin)] };
  const result = discoveredBlastRadius(graph, origin, {
    services: [{ name: 'worker', team: 'ops', criticality: 'tier1' }],
    edges: [declared],
  });
  expect(result.dependents.insulated).toEqual([
    expect.objectContaining({
      name: 'worker',
      scope: { environment: 'development' },
      hops: 2,
      team: 'ops',
      evidenceKeys: expect.arrayContaining(['catalog-dependency:declaration']),
    }),
  ]);
  const worker = {
    ...service('worker', 'development'),
    key: result.dependents.insulated[0]!.subjectKey!,
  };
  const direct = discoveredBlastRadius(
    { ...graph, subjects: [...graph.subjects, worker] },
    worker,
    { services: [], edges: [declared] },
  );
  expect(direct.suspects[0]?.syncType).toBe('async');
});

test('a catalog declaration cannot bridge an ambiguous same-name identity', () => {
  const origin = service('db'),
    one = service('api', 'production', 'account-one'),
    two = service('api', 'production', 'account-two');
  const result = discoveredBlastRadius({ subjects: [origin, one, two], relations: [] }, origin, {
    services: [{ name: 'api', team: null, criticality: null }],
    edges: [
      {
        id: 'd',
        upstream: 'api',
        downstream: 'db',
        environment: 'production',
        syncType: 'sync',
        circuitBreaker: false,
      },
    ],
  });
  expect(Object.values(result.dependents).flat()).toEqual([]);
  expect(result.note).toContain('1 stale, inferred, ambiguous or non-service');
});

test('bounds cyclic traversal and reports only genuinely missing paths at the depth boundary', () => {
  const a = service('a'),
    b = service('b'),
    c = service('c');
  const graph = { subjects: [a, b, c], relations: [call(a, b), call(b, c), call(c, a)] };
  const result = discoveredBlastRadius(graph, c, none, 1);
  expect(result.truncated).toBe(true);
  expect(result.dependents.unclassified?.map((entry) => entry.name)).toEqual(['b']);
  expect(
    discoveredBlastRadius({ ...graph, relations: [...graph.relations, call(a, c)] }, c, none, 1)
      .truncated,
  ).toBe(false);
  expect(discoveredBlastRadius(graph, c, none, 10).dependents.unclassified).toHaveLength(2);
});

test.each([false, true])(
  'discovered catalog services retain metadata with declared edges: %s',
  (withDeclaration) => {
    const api = service('api'),
      database = service('database');
    const graph = { subjects: [api, database], relations: [call(api, database)] };
    const declared = {
      services: [
        { name: 'api', team: 'payments', criticality: 'tier1' },
        { name: 'database', team: 'storage', criticality: 'tier0' },
      ],
      edges: withDeclaration
        ? [
            {
              id: 'edge',
              upstream: 'api',
              downstream: 'database',
              environment: 'production',
              syncType: 'sync',
              circuitBreaker: false,
            },
          ]
        : [],
    };
    const result = discoveredBlastRadius(graph, database, declared);
    expect(Object.values(result.dependents).flat()).toEqual([
      expect.objectContaining({ subjectKey: api.key, team: 'payments', criticality: 'tier1' }),
    ]);
    expect(discoveredBlastRadius(graph, api, declared).suspects).toEqual([
      expect.objectContaining({ subjectKey: database.key, criticality: 'tier0' }),
    ]);
  },
);

test('the omission note includes fresh calls to non-service subjects', () => {
  const api = service('api');
  const endpoint = { ...service('endpoint'), kind: 'endpoint' as const };
  const result = discoveredBlastRadius(
    { subjects: [api, endpoint], relations: [call(api, endpoint)] },
    api,
    none,
  );
  expect(result.suspects).toEqual([]);
  expect(result.note).toContain(
    '1 stale, inferred, ambiguous or non-service dependency relationships were excluded',
  );
});
