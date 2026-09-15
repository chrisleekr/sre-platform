import { useOperationalTopology } from '../useOperationalTopology';
import { useTopologyImpact } from '../useTopologyImpact';
// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useTopology,
  fetchBlastRadius,
  saveTopologyDependency,
  saveTopologyService,
} from '../useTopology';
import type { TopologyGraph, BlastRadius } from '../topology';
import { discoveryFixture } from '../../components/__tests__/topology-discovery.fixture';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
  pollMs: 10_000,
};
const graph: TopologyGraph = {
  nodes: [
    {
      name: 'checkout',
      team: 'payments',
      criticality: 'tier1',
      lastDeployAt: new Date().toISOString(),
      recentDeploys: [],
    },
  ],
  edges: [{ upstream: 'checkout', downstream: 'orders', syncType: 'sync', circuitBreaker: false }],
};

describe('useTopology', () => {
  test('preserves automatic identity, relationship and coverage evidence without a catalog', async () => {
    const discovery = discoveryFixture();
    globalThis.fetch = vi.fn(async () => Response.json({ nodes: [], edges: [], discovery }));
    const { result } = renderHook(() => useTopology(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.graph.discovery).toEqual(discovery);
    expect(result.current.graph.nodes).toEqual([]);
  });
  test('a failed historical read never substitutes a previously loaded live graph', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(graph))
      .mockResolvedValue(Response.json({}, { status: 503 }));
    const { result, rerender } = renderHook(({ at }) => useTopology({ ...opts, at }), {
      initialProps: { at: '' },
    });
    await waitFor(() => expect(result.current.graph.nodes).toHaveLength(1));
    rerender({ at: '2026-09-01T00:00:00.000Z' });
    expect(result.current.graph.nodes).toEqual([]);
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.graph.nodes).toEqual([]);
    expect(result.current.graph.historicalAt).toBe('2026-09-01T00:00:00.000Z');
  });
  test('loads the tenant service graph', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => graph }) as Response);
    const { result } = renderHook(() => useTopology(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.graph.nodes).toHaveLength(1);
    expect(result.current.graph.edges).toHaveLength(1);
    expect(result.current.error).toBe(false);
  });

  test('flags an error but retains the last-good graph on a failed poll', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: true, json: async () => graph } as Response;
      return { ok: false, json: async () => ({}) } as Response; // subsequent polls fail
    });
    globalThis.fetch = fetchMock;
    const { result, unmount } = renderHook(() =>
      useTopology({
        apiBaseUrl: 'http://api',
        getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        pollMs: 20,
      }),
    );
    // First load succeeds.
    await waitFor(() => expect(result.current.graph.nodes).toHaveLength(1));
    // A later poll fails -> error flips true, but the good graph is retained (not blanked).
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.graph.nodes).toHaveLength(1);
    unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test('re-polls on the interval', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => graph }) as Response);
    globalThis.fetch = fetchMock;
    const { unmount } = renderHook(() =>
      useTopology({
        apiBaseUrl: 'http://api',
        getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        pollMs: 20,
      }),
    );
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    // Stop the interval and drain the in-flight poll before teardown (jsdom teardown flake):
    // a late fetch settling after jsdom teardown throws "window is not defined" and fails the run.
    unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test('refetches the graph on demand after a catalog update', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => graph }) as Response);
    globalThis.fetch = fetchMock;
    const { result, unmount } = renderHook(() => useTopology(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.refetch());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    unmount();
  });
});

describe('topology catalog mutations', () => {
  test('saves a service and dependency through authenticated tenant routes', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        ({ ok: true, json: async () => ({}) }) as Response,
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await saveTopologyService(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      {
        name: 'checkout api',
        team: 'payments',
        criticality: 'tier1',
      },
    );
    await saveTopologyDependency(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      {
        upstream: 'web',
        downstream: 'checkout api',
        syncType: 'sync',
        circuitBreaker: true,
      },
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://api/topology/services/checkout%20api',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('http://api/topology/dependencies');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      upstream: 'web',
      downstream: 'checkout api',
    });
  });

  test('surfaces the sanitized API error for a rejected relationship', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({ error: 'both services must be registered' }),
        }) as Response,
    );
    await expect(
      saveTopologyDependency(
        'http://api',
        async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        {
          upstream: 'web',
          downstream: 'missing',
          syncType: 'sync',
          circuitBreaker: false,
        },
      ),
    ).rejects.toThrow('both services must be registered');
  });
});

describe('fetchBlastRadius', () => {
  const blast: BlastRadius = {
    service: 'checkout',
    mapped: true,
    dependents: { direct: [], indirect: [], insulated: [] },
    suspects: [],
    truncated: false,
  };

  test('requests the service blast radius and returns it', async () => {
    const fetchMock = vi.fn(
      async (_url: string) => ({ ok: true, json: async () => blast }) as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await fetchBlastRadius(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      'checkout',
    );
    expect(result.service).toBe('checkout');
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/topology/blast-radius?service=checkout');
  });

  test('throws on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response);
    await expect(
      fetchBlastRadius(
        'http://api',
        async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        'checkout',
      ),
    ).rejects.toThrow();
  });
});

test('operational health is reused across unrelated renders and ages on the clock', () => {
  vi.useFakeTimers();
  const observedAt = new Date().toISOString();
  const input: TopologyGraph = {
    ...graph,
    infrastructure: [
      {
        dataSourceId: 'cluster',
        dataSourceName: 'Cluster',
        source: 'kubernetes',
        entityId: 'apps/checkout',
        namespace: 'apps',
        kind: 'pod',
        metrics: { ready: 1 },
        observedAt,
      },
    ],
    runtimeBindings: [
      {
        id: 'binding',
        serviceName: 'checkout',
        connectorId: 'cluster',
        namespace: 'apps',
        labelKey: '',
        labelValue: '',
        environment: 'production',
        rationale: 'Confirmed',
        updatedAt: observedAt,
      },
    ],
    coverage: [
      {
        dataSourceId: 'cluster',
        dataSourceName: 'Cluster',
        state: 'complete',
        observedAt,
        lastSucceededAt: observedAt,
      },
    ],
  };
  const { result, rerender, unmount } = renderHook(() => useOperationalTopology(input, ''));
  const first = result.current;
  expect(first.nodes[0]?.status).toBe('healthy');
  rerender();
  expect(result.current).toBe(first);
  act(() => vi.advanceTimersByTime(90_000));
  expect(result.current.nodes[0]?.status).toBe('stale');
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('impact refreshes for evidence changes even when subject and relation counts stay equal', async () => {
  const discovery = discoveryFixture();
  const input = { ...graph, discovery };
  const blast = {
    service: 'checkout',
    mapped: true,
    dependents: { direct: [], indirect: [], insulated: [] },
    suspects: [],
    truncated: false,
  };
  const fetchMock = vi.fn(async () => Response.json(blast));
  globalThis.fetch = fetchMock;
  const { result, rerender } = renderHook(
    ({ value }) => useTopologyImpact('http://api', opts.getCredentials, value, 'checkout'),
    { initialProps: { value: input } },
  );
  await waitFor(() => expect(result.current.result).not.toBeNull());
  rerender({ value: { ...input } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const changed = {
    ...input,
    discovery: {
      ...discovery,
      operational: {
        ...discovery.operational,
        relations: discovery.operational.relations.map((relation, index) =>
          index ? relation : { ...relation, stale: !relation.stale },
        ),
      },
    },
  };
  rerender({ value: changed });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.loading).toBe(false));
});
