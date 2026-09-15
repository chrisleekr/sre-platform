import { describe, expect, test } from 'vitest';
import {
  operationalTopologyGraph,
  filterTopologyGraph,
  scopeTopologyGraph,
  topologyIncidentTitle,
  type RuntimeBinding,
  type TopologyGraph,
} from '../topology';
import type { InfraSnapshot } from '../types';

const now = Date.parse('2026-09-12T00:00:30Z');
const at = '2026-09-12T00:00:00Z';
const binding = (connectorId: string, environment: string): RuntimeBinding => ({
  id: connectorId,
  connectorId,
  serviceName: 'checkout',
  namespace: 'apps',
  labelKey: 'app',
  labelValue: 'checkout',
  environment,
  rationale: 'Confirmed application labels',
  updatedAt: at,
});
const pod = (source: string, app: string, ready: number): InfraSnapshot => ({
  dataSourceId: source,
  dataSourceName: source,
  source: 'kubernetes',
  entityId: `apps/${app}`,
  namespace: 'apps',
  labels: { app },
  kind: 'pod',
  phase: 'Running',
  metrics: { ready },
  observedAt: at,
});
const graph: TopologyGraph = {
  nodes: [
    {
      name: 'checkout',
      team: null,
      criticality: null,
      lastDeployAt: null,
      recentDeploys: [
        { sha: 'stage', status: 'success', ref: null, deployedAt: at, environment: 'staging' },
        { sha: 'prod', status: 'success', ref: null, deployedAt: at, environment: 'production' },
        { sha: 'unscoped', status: 'success', ref: null, deployedAt: at },
      ],
    },
  ],
  edges: [],
  runtimeBindings: [binding('prod-cluster', 'production'), binding('stage-cluster', 'staging')],
  infrastructure: [
    pod('prod-cluster', 'checkout', 1),
    pod('stage-cluster', 'checkout', 0),
    pod('prod-cluster', 'billing', 0),
  ],
  coverage: ['prod-cluster', 'stage-cluster'].map((dataSourceId) => ({
    dataSourceId,
    dataSourceName: dataSourceId,
    state: 'complete',
    observedAt: at,
    lastSucceededAt: at,
  })),
};

describe('confirmed runtime identity', () => {
  test('same namespaces across clusters and unrelated apps never attach by equal name', () => {
    const result = operationalTopologyGraph(scopeTopologyGraph(graph, 'production'), [], now);
    expect(result.nodes[0]?.runtime).toMatchObject({ pods: 1, healthy: 1, attention: 0 });
    expect(result.nodes[0]?.status).toBe('healthy');
    expect(result.nodes[0]?.recentDeploys.map((deploy) => deploy.sha)).toEqual(['prod']);
    const staging = operationalTopologyGraph(scopeTopologyGraph(graph, 'staging'), [], now);
    expect(staging.nodes[0]?.status).toBe('attention');
  });
  test('an equal namespace name without a confirmed binding is not service evidence', () => {
    const result = operationalTopologyGraph(
      { ...graph, runtimeBindings: [], nodes: [{ ...graph.nodes[0]!, name: 'apps' }] },
      [],
      now,
    );
    expect(result.nodes[0]?.runtime).toBeUndefined();
    expect(result.nodes[0]?.status).toBe('unknown');
  });
  test('a missing bound source cannot disappear behind another source healthy result', () => {
    const result = operationalTopologyGraph(
      {
        ...graph,
        infrastructure: [pod('prod-cluster', 'checkout', 1)],
        coverage: graph.coverage!.map((source) =>
          source.dataSourceId === 'stage-cluster' ? { ...source, state: 'unavailable' } : source,
        ),
      },
      [],
      now,
    );
    expect(result.nodes[0]?.status).toBe('unknown');
  });
  test('an unknown environment has no matching service observations', () => {
    expect(scopeTopologyGraph(graph, 'missing').nodes).toEqual([]);
  });
  test('declared relationships retain services without runtime and do not invent health', () => {
    const scoped = scopeTopologyGraph(
      {
        ...graph,
        runtimeBindings: [],
        nodes: [...graph.nodes, { ...graph.nodes[0]!, name: 'database', recentDeploys: [] }],
        edges: [
          {
            upstream: 'checkout',
            downstream: 'database',
            syncType: 'sync',
            circuitBreaker: false,
            protocol: null,
            environment: 'production',
          },
        ],
      },
      'production',
    );
    expect(scoped.nodes.map((node) => node.name)).toEqual(['checkout', 'database']);
    expect(scoped.edges).toHaveLength(1);
    expect(operationalTopologyGraph(scoped, [], now).nodes[1]?.status).toBe('unknown');
  });
  test('mention-only titles become readable incident identifiers', () => {
    expect(topologyIncidentTitle({ id: '12345678-1234', title: '<@U0123456>' })).toBe(
      'Incident 12345678',
    );
    expect(topologyIncidentTitle({ id: 'id', title: 'Checkout errors' })).toBe('Checkout errors');
  });
  test('focus includes callers and dependencies without pulling unrelated services into view', () => {
    const focused = filterTopologyGraph(
      {
        ...graph,
        nodes: ['checkout', 'database', 'frontend', 'unrelated'].map((name) => ({
          ...graph.nodes[0]!,
          name,
        })),
        edges: [
          {
            upstream: 'checkout',
            downstream: 'database',
            syncType: 'sync',
            circuitBreaker: false,
            protocol: null,
          },
          {
            upstream: 'frontend',
            downstream: 'checkout',
            syncType: 'async',
            circuitBreaker: false,
            protocol: null,
          },
        ],
      },
      '',
      { focus: 'checkout' },
    );
    expect(focused.nodes.map((node) => node.name)).toEqual(['checkout', 'database', 'frontend']);
    expect(focused.edges).toHaveLength(2);
  });
});

test('overlapping namespace and label bindings count a pod once and exclude other scopes', () => {
  const result = operationalTopologyGraph(
    {
      ...graph,
      runtimeBindings: [
        binding('prod-cluster', 'production'),
        {
          ...binding('prod-cluster', 'production'),
          id: 'whole-namespace',
          labelKey: '',
          labelValue: '',
        },
      ],
      infrastructure: [
        pod('prod-cluster', 'checkout', 1),
        pod('stage-cluster', 'checkout', 0),
        { ...pod('prod-cluster', 'checkout', 0), namespace: 'other' },
        { ...pod('prod-cluster', 'checkout', 0), kind: 'node' },
      ],
    },
    [],
    now,
  );
  expect(result.nodes[0]?.runtime).toMatchObject({
    pods: 1,
    healthy: 1,
    attention: 0,
    scopes: [{ dataSourceId: 'prod-cluster', namespace: 'apps', environment: 'production' }],
  });
  expect(result.nodes[0]?.status).toBe('healthy');
});

test('every confirmed selector must match pods before a service is healthy', () => {
  for (const missing of [
    binding('stage-cluster', 'staging'),
    { ...binding('prod-cluster', 'production'), id: 'missing-app', labelValue: 'missing' },
  ]) {
    const result = operationalTopologyGraph(
      {
        ...graph,
        runtimeBindings: [binding('prod-cluster', 'production'), missing],
        infrastructure: [pod('prod-cluster', 'checkout', 1)],
      },
      [],
      now,
    );
    expect(result.nodes[0]?.status).toBe('unknown');
    expect(result.nodes[0]?.runtime?.pods).toBe(1);
  }
});
