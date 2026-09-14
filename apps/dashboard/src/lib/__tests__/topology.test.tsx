// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { activeIncident, blastHighlights } from '../topology';
import * as topology from '../topology';
import type { BlastRadius } from '../topology';
import type { Incident } from '../types';

function incident(over: Partial<Incident>): Incident {
  return {
    id: 'i1',
    service: 'checkout',
    severity: 'sev2',
    status: 'open',
    investigationStatus: 'queued',
    lifecycleVersion: 0,
    alertSource: 'datadog',
    rcaSummary: null,
    confidence: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('activeIncident', () => {
  test('returns the first incident with an active status', () => {
    const found = activeIncident([
      incident({ id: 'a', status: 'resolved' }),
      incident({ id: 'b', status: 'mitigated' }),
      incident({ id: 'c', status: 'open' }),
    ]);
    expect(found?.id).toBe('b');
  });

  test('returns undefined when no incident is active', () => {
    expect(activeIncident([incident({ status: 'resolved' })])).toBeUndefined();
  });

  test('activeIncidents preserves API order and excludes every terminal incident', () => {
    const rows = [
      incident({ id: 'resolved', status: 'resolved' }),
      incident({ id: 'closed', status: 'closed' }),
      incident({ id: 'open', status: 'open' }),
      incident({ id: 'mitigated', status: 'mitigated' }),
    ];

    expect(topology.activeIncidents(rows).map((row) => row.id)).toEqual(['open', 'mitigated']);
    expect(topology.activeIncidents(rows.slice(0, 1))).toEqual([]);
  });
});

describe('filterTopologyGraph', () => {
  const graph = {
    nodes: [
      {
        name: 'Checkout API',
        team: null,
        criticality: null,
        lastDeployAt: null,
        recentDeploys: [],
      },
      { name: 'Payments', team: null, criticality: null, lastDeployAt: null, recentDeploys: [] },
      { name: 'Orders', team: null, criticality: null, lastDeployAt: null, recentDeploys: [] },
    ],
    edges: [
      { upstream: 'Checkout API', downstream: 'Payments', syncType: 'sync', circuitBreaker: false },
      { upstream: 'Payments', downstream: 'Orders', syncType: 'async', circuitBreaker: false },
    ],
  };

  test('filters service names case-insensitively and retains only complete matching edges', () => {
    const filtered = topology.filterTopologyGraph(graph, 'PAY');

    expect(filtered.nodes.map((node) => node.name)).toEqual(['Payments']);
    expect(filtered.edges).toEqual([]);
  });

  test('an empty search preserves node and edge order', () => {
    const filtered = topology.filterTopologyGraph(graph, '');

    expect(filtered.nodes.map((node) => node.name)).toEqual(['Checkout API', 'Payments', 'Orders']);
    expect(filtered.edges).toEqual(graph.edges);
  });

  test('combines status and source filters without retaining partial edges', () => {
    const operational = {
      ...graph,
      nodes: [
        { ...graph.nodes[0]!, status: 'incident' as const, sources: ['incident' as const] },
        { ...graph.nodes[1]!, status: 'healthy' as const, sources: ['kubernetes' as const] },
        { ...graph.nodes[2]!, status: 'unknown' as const, sources: ['catalog' as const] },
      ],
    };

    const filtered = topology.filterTopologyGraph(operational, '', {
      status: 'healthy',
      source: 'kubernetes',
    });

    expect(filtered.nodes.map((node) => node.name)).toEqual(['Payments']);
    expect(filtered.edges).toEqual([]);
  });
});

describe('operationalTopologyGraph', () => {
  const now = Date.parse('2026-08-21T01:00:00.000Z');
  const node = (name: string) => ({
    name,
    team: null,
    criticality: null,
    lastDeployAt: null,
    recentDeploys: [],
  });
  const pod = (
    namespace: string,
    over: Partial<import('../types').InfraSnapshot> = {},
  ): import('../types').InfraSnapshot => ({
    dataSourceId: '00000000-0000-4000-8000-000000000001',
    dataSourceName: 'Primary Kubernetes',
    source: 'kubernetes',
    entityId: `${namespace}/pod-1`,
    kind: 'pod',
    namespace,
    phase: 'Running',
    metrics: { ready: 1, restartCount: 0, oomKilled: 0 },
    observedAt: '2026-08-21T00:59:30.000Z',
    ...over,
  });

  test('prioritizes incidents, then runtime issues, stale telemetry, health, and no telemetry', () => {
    const graph = topology.operationalTopologyGraph(
      {
        nodes: ['unknown', 'healthy', 'stale', 'attention', 'incident'].map(node),
        edges: [],
        runtimeBindings: ['healthy', 'stale', 'attention', 'incident'].map((name) => ({
          id: name,
          serviceName: name,
          connectorId: '00000000-0000-4000-8000-000000000001',
          namespace: name,
          labelKey: '',
          labelValue: '',
          environment: 'test',
          rationale: 'Confirmed',
          updatedAt: '2026-08-21T00:59:30Z',
        })),
        coverage: [
          {
            dataSourceId: '00000000-0000-4000-8000-000000000001',
            dataSourceName: 'Primary Kubernetes',
            state: 'complete',
            observedAt: '2026-08-21T00:59:30.000Z',
            lastSucceededAt: null,
          },
        ],
        infrastructure: [
          pod('incident'),
          pod('attention', { metrics: { ready: 1, restartCount: 4, oomKilled: 1 } }),
          pod('stale', { observedAt: '2026-08-21T00:58:00.000Z' }),
          pod('healthy', {
            phase: 'Succeeded',
            metrics: { ready: 0, restartCount: 0, oomKilled: 0 },
          }),
        ],
      },
      [incident({ service: 'incident', status: 'mitigated' })],
      now,
    );

    expect(Object.fromEntries(graph.nodes.map((item) => [item.name, item.status]))).toEqual({
      incident: 'incident',
      attention: 'attention',
      stale: 'stale',
      healthy: 'healthy',
      unknown: 'unknown',
    });
    expect(graph.nodes.map((item) => item.name)).toEqual([
      'incident',
      'attention',
      'stale',
      'healthy',
      'unknown',
    ]);
    expect(graph.nodes.find((item) => item.name === 'attention')?.runtime).toMatchObject({
      pods: 1,
      healthy: 0,
      attention: 1,
      restarts: 4,
      oomKilled: 1,
    });
  });

  test('uses the server incident source when the bounded incident list omits an active service', () => {
    const graph = topology.operationalTopologyGraph(
      {
        nodes: [{ ...node('payments'), sources: ['incident'] }],
        edges: [],
        infrastructure: [],
      },
      [],
      now,
    );

    expect(graph.nodes[0]?.status).toBe('incident');
  });

  test.each(['partial', 'unknown', 'unavailable'] as const)(
    'does not call partial evidence healthy: %s',
    (state) => {
      const graph = topology.operationalTopologyGraph(
        {
          nodes: [node('checkout')],
          edges: [],
          infrastructure: [pod('checkout')],
          runtimeBindings: [
            {
              id: 'binding',
              serviceName: 'checkout',
              connectorId: '00000000-0000-4000-8000-000000000001',
              namespace: 'checkout',
              labelKey: '',
              labelValue: '',
              environment: 'test',
              rationale: 'Confirmed',
              updatedAt: '2026-08-21T00:59:30Z',
            },
          ],
          coverage: [
            {
              dataSourceId: '00000000-0000-4000-8000-000000000001',
              dataSourceName: 'Primary Kubernetes',
              state,
              observedAt: '2026-08-21T00:59:30.000Z',
              lastSucceededAt: null,
            },
          ],
        },
        [],
        now,
      );
      expect(graph.nodes[0]?.status).toBe('unknown');
      expect(graph.nodes[0]?.runtime?.pods).toBe(1);
    },
  );
});

const dep = (name: string, over = {}) => ({
  name,
  criticality: null,
  team: null,
  hops: 1,
  ...over,
});

describe('blastHighlights', () => {
  const blast: BlastRadius = {
    service: 'checkout',
    mapped: true,
    dependents: {
      direct: [dep('orders')],
      indirect: [dep('shipping', { hops: 2 })],
      insulated: [dep('email')],
    },
    suspects: [],
    truncated: false,
  };

  test('maps the origin, direct and indirect tiers', () => {
    const m = blastHighlights(blast);
    expect(m.get('checkout')).toBe('affected');
    expect(m.get('orders')).toBe('direct');
    expect(m.get('shipping')).toBe('indirect');
    expect(m.get('email')).toBe('insulated');
  });

  test('the origin service wins over a direct/indirect tier', () => {
    const overlap: BlastRadius = {
      ...blast,
      dependents: { direct: [dep('checkout')], indirect: [], insulated: [] },
    };
    expect(blastHighlights(overlap).get('checkout')).toBe('affected');
  });

  test('returns an empty map for null', () => {
    expect(blastHighlights(null).size).toBe(0);
  });
});
