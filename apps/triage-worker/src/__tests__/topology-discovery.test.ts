import { readFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import type { IDataSourceConnector } from '@sre/connectors';
import { makePrometheusConnector } from '@sre/connectors';
import type { Job } from '@sre/queue';
import type { TopologyScanProgress } from '@sre/contracts';
import { makeTopologyDiscoveryHandler, runTopologyDiscoveryConsumer } from '../topology-discovery';
import { PollScheduler } from '../poller';

const connector = (
  discover: NonNullable<IDataSourceConnector['topology']>['discover'] = vi.fn(async () => ({
    observedAt: '2099-01-01T00:00:00Z',
    collections: [],
  })),
): IDataSourceConnector => ({
  id: 'source',
  name: 'Source',
  type: 'prometheus',
  generation: { id: 'source', lifecycleVersion: 7 },
  capabilities: {
    availability: 'ready',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'tools',
    polling: 'none',
    events: 'none',
  },
  topology: { discover },
  snapshot: vi.fn(),
  tools: () => [],
  probe: vi.fn(),
  fetchTriageContext: vi.fn(),
});
const job = {
  type: 'topology.discover',
  tenantId: 'tenant',
  payload: { connectorId: 'source' },
} as Job;

test('a saved rate limit defers subsequent discovery without reading the provider again', async () => {
  const discover = vi.fn(async () => ({
    observedAt: new Date().toISOString(),
    collections: [
      {
        key: 'logs',
        completeness: 'unavailable' as const,
        issue: 'rate_limited' as const,
        retryAfterMs: 600_000,
        entities: [],
        relations: [],
      },
    ],
  }));
  const active = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    defer = vi.fn(),
    persist = vi.fn(async () => true);
  const handler = makeTopologyDiscoveryHandler({
    connectorProvider: () => async () => [connector(discover)],
    cooldown: { active, defer },
    persist,
    failed: vi.fn(),
  });
  await handler(job);
  await handler(job);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(defer).toHaveBeenCalledWith('tenant', 'source', 600_000);
});

test('preserves events arriving during discovery while stamping the attempt with its start time', async () => {
  vi.useFakeTimers();
  const start = Date.UTC(2026, 8, 12);
  try {
    vi.setSystemTime(start);
    const persist = vi.fn(async () => true);
    const failed = vi.fn();
    const source = connector(async () => {
      vi.setSystemTime(start + 100);
      return {
        observedAt: new Date().toISOString(),
        collections: [
          {
            key: 'events',
            completeness: 'partial',
            relations: [],
            entities: [
              {
                ref: { authority: 'source', kind: 'service', id: 'api' },
                kind: 'service',
                name: 'api',
                scope: {},
                attributes: {},
                evidenceAt: new Date().toISOString(),
              },
            ],
          },
        ],
      };
    });
    await makeTopologyDiscoveryHandler({
      connectorProvider: () => async () => [source],
      persist,
      failed,
    })(job);
    expect(persist).toHaveBeenCalledWith('tenant', source.generation, {
      observedAt: new Date(start).toISOString(),
      collections: [
        expect.objectContaining({
          entities: [expect.objectContaining({ evidenceAt: new Date(start + 100).toISOString() })],
        }),
      ],
    });
    expect(failed).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test.each([400, 422])(
  'records HTTP %s as a rejected query, not a network outage',
  async (status) => {
    const failed = vi.fn(),
      persist = vi.fn();
    await makeTopologyDiscoveryHandler({
      connectorProvider: () => async () => [
        connector(async () => {
          throw Object.assign(new Error('private provider response must not be retained'), {
            status,
          });
        }),
      ],
      failed,
      persist,
    })(job);
    expect(failed).toHaveBeenCalledWith(
      'tenant',
      { id: 'source', lifecycleVersion: 7 },
      expect.any(Date),
      'request_rejected',
    );
    expect(persist).not.toHaveBeenCalled();
  },
);

test('continuations yield to the queue only after saved progress and stop on rate limits or batch bounds', async () => {
  for (const scenario of ['progress', 'stale', 'same-page', 'rate-limited', 'batch-bound']) {
    const continueScan = vi.fn(async () => {});
    const source = connector(async () => ({
      observedAt: new Date().toISOString(),
      collections: [
        {
          key: 'repositories',
          completeness: 'partial',
          entities: [],
          relations: [],
          issue: scenario === 'rate-limited' ? 'rate_limited' : 'limit',
          scan: { cursor: 'next', incomplete: false },
        },
      ],
    }));
    await makeTopologyDiscoveryHandler({
      connectorProvider: () => async () => [source],
      scans: async (): Promise<Record<string, TopologyScanProgress>> =>
        scenario === 'same-page' ? { repositories: { cursor: 'next', incomplete: false } } : {},
      persist: async () => scenario !== 'stale',
      failed: vi.fn(),
      continueScan,
    })({
      ...job,
      payload: { connectorId: 'source', pageCount: scenario === 'batch-bound' ? 20 : 0 },
    });
    if (scenario === 'progress')
      expect(continueScan).toHaveBeenCalledWith('tenant', 'source', 1, ['repositories']);
    else expect(continueScan).not.toHaveBeenCalled();
  }
});

test('continues only progressing collections and leaves failed or completed reads for the periodic pass', async () => {
  const continueScan = vi.fn(async () => {});
  const discover = vi.fn(async () => ({
    observedAt: new Date().toISOString(),
    collections: [
      {
        key: 'repositories',
        completeness: 'partial' as const,
        issue: 'limit' as const,
        entities: [],
        relations: [],
        scan: { cursor: 'next', incomplete: false },
      },
      {
        key: 'service-declarations',
        completeness: 'unavailable' as const,
        issue: 'unreachable' as const,
        entities: [],
        relations: [],
        scan: { cursor: 'failed', incomplete: true },
      },
      {
        key: 'complete',
        completeness: 'complete' as const,
        entities: [],
        relations: [],
        scan: { cursor: null, incomplete: false },
      },
    ],
  }));
  const handler = makeTopologyDiscoveryHandler({
    connectorProvider: () => async () => [connector(discover)],
    persist: async () => true,
    failed: vi.fn(),
    continueScan,
  });
  await handler(job);
  expect(continueScan).toHaveBeenCalledWith('tenant', 'source', 1, ['repositories']);
  await handler({
    ...job,
    payload: { connectorId: 'source', collections: ['repositories'], pageCount: 1 },
  });
  expect(discover).toHaveBeenLastCalledWith({ scans: undefined, collections: ['repositories'] });
});

test('an actual provider response limit is persisted as a limit without replacing prior inventory', async () => {
  const source = makePrometheusConnector(
    {
      id: 'source',
      tenantId: 'tenant',
      name: 'Prometheus',
      type: 'prometheus',
      settings: { baseUrl: 'https://metrics.example' },
      getCredential: async () => JSON.stringify({ type: 'none' }),
    },
    (async (_input: Parameters<typeof fetch>[0]) =>
      new Response('not parsed', {
        headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
      })) as typeof fetch,
    async () => ['93.184.216.34'],
  );
  const failed = vi.fn(),
    persist = vi.fn(async () => true);
  await makeTopologyDiscoveryHandler({
    connectorProvider: () => async () => [
      { ...source, generation: { id: 'source', lifecycleVersion: 7 } },
    ],
    failed,
    persist,
  })(job);
  expect(failed).toHaveBeenCalledWith(
    'tenant',
    { id: 'source', lifecycleVersion: 7 },
    expect.any(Date),
    'limit',
  );
  expect(persist).not.toHaveBeenCalled();
});

test('inventory discovery is scheduled even when metric snapshot polling is unsupported', async () => {
  const dispatch = { enqueue: vi.fn(async () => 'job') };
  const scheduler = new PollScheduler({
    jobType: 'topology.discover',
    guard: async () => true,
    dispatch,
    connectorProvider: () => async () => [connector()],
    listTenants: async () => [{ id: 'tenant' }],
  });
  expect(await scheduler.tick()).toBe(1);
  expect(dispatch.enqueue).toHaveBeenCalledWith({
    tenantId: 'tenant',
    type: 'topology.discover',
    payload: { connectorId: 'source' },
  });
});

test('loads the captured generation checkpoint before asking the adapter for its next page', async () => {
  const discover = vi.fn(async () => ({ observedAt: '2099-01-01T00:00:00Z', collections: [] }));
  const scans = vi.fn(async () => ({ dashboards: { cursor: '3', incomplete: false } }));
  await makeTopologyDiscoveryHandler({
    connectorProvider: () => async () => [connector(discover)],
    scans,
    persist: async () => true,
    failed: vi.fn(),
  })(job);
  expect(scans).toHaveBeenCalledWith('tenant', { id: 'source', lifecycleVersion: 7 });
  expect(discover).toHaveBeenCalledWith({
    scans: { dashboards: { cursor: '3', incomplete: false } },
  });
});
test('persists the captured generation using worker read time, not an untrusted future timestamp', async () => {
  const persist = vi.fn<Parameters<typeof makeTopologyDiscoveryHandler>[0]['persist']>(
      async () => true,
    ),
    failed = vi.fn();
  await makeTopologyDiscoveryHandler({
    connectorProvider: () => async () => [connector()],
    persist,
    failed,
  })(job);
  expect(persist).toHaveBeenCalledWith(
    'tenant',
    { id: 'source', lifecycleVersion: 7 },
    expect.objectContaining({ collections: [] }),
  );
  expect(Date.parse(persist.mock.calls[0]![2].observedAt)).toBeLessThanOrEqual(Date.now());
  expect(failed).not.toHaveBeenCalled();
});
test('provider failure records unavailable evidence, while persistence failure is not blamed on the provider', async () => {
  const failed = vi.fn(),
    persist = vi.fn(async () => true);
  await makeTopologyDiscoveryHandler({
    connectorProvider: () => async () => [
      connector(
        vi.fn(async () => {
          throw new Error('sensitive provider detail');
        }),
      ),
    ],
    persist,
    failed,
  })(job);
  expect(failed).toHaveBeenCalledWith(
    'tenant',
    { id: 'source', lifecycleVersion: 7 },
    expect.any(Date),
    'unreachable',
  );
  expect(persist).not.toHaveBeenCalled();
  failed.mockClear();
  await expect(
    makeTopologyDiscoveryHandler({
      connectorProvider: () => async () => [connector()],
      persist: async () => {
        throw new Error('database unavailable');
      },
      failed,
    })(job),
  ).rejects.toThrow('database unavailable');
  expect(failed).not.toHaveBeenCalled();
});

test.each(['permission_denied', 'unreachable', 'invalid_response'] as const)(
  'continues an advanced partial cursor despite a child %s issue',
  async (issue) => {
    const continueScan = vi.fn(async () => {});
    const source = connector(async () => ({
      observedAt: new Date().toISOString(),
      collections: [
        {
          key: 'applications',
          completeness: 'partial',
          issue,
          entities: [],
          relations: [],
          scan: { cursor: '25', incomplete: true },
        },
      ],
    }));
    await makeTopologyDiscoveryHandler({
      connectorProvider: () => async () => [source],
      persist: async () => true,
      failed: vi.fn(),
      continueScan,
    })(job);
    expect(continueScan).toHaveBeenCalledWith('tenant', 'source', 1, ['applications']);
  },
);

test('the independent discovery consumer does not hold up a snapshot poll', async () => {
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = new Error('test consumer finished');
  const process = vi
    .fn()
    .mockImplementationOnce(async (_name, handler) => {
      await handler(job);
      return 1;
    })
    .mockRejectedValue(stop);
  const pending = runTopologyDiscoveryConsumer({ process }, async () => blocked);
  const settled = expect(pending).rejects.toBe(stop);
  const poll = vi.fn(async () => 'snapshot refreshed');
  expect(await poll()).toBe('snapshot refreshed');
  expect(process).toHaveBeenCalledTimes(1);
  expect(process).toHaveBeenCalledWith('topology-worker', expect.any(Function), { count: 1 });
  finish();
  await settled;
});

test('passes only the current connector generation to persisted cluster identity lookup', async () => {
  const source = { ...connector(), type: 'kubernetes' as const };
  const clusterAuthority = vi.fn(async () => 'kubernetes-cluster:pinned');
  await makeTopologyDiscoveryHandler({
    connectorProvider: () => async () => [source],
    persist: async () => true,
    failed: vi.fn(),
    clusterAuthority,
  })(job);
  expect(clusterAuthority).toHaveBeenCalledWith('tenant', 'source', 7);
  expect(source.topology!.discover).toHaveBeenCalledWith({
    scans: undefined,
    clusterAuthority: 'kubernetes-cluster:pinned',
  });
});

test('production wiring dispatches and consumes discovery independently from snapshot polling', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  expect(source).toMatch(
    /const topologyQueue = new Queue[\s\S]*?stream: 'sre:jobs:topology',[\s\S]*?group: 'topology'/,
  );
  expect(source).toMatch(
    /const topology = makeTopologyDiscoveryRuntime\(\{[^}]*dispatch: topologyQueue/,
  );
  expect(source).toContain('void runTopologyDiscoveryConsumer(topologyQueue, topology.handler)');
  const poll = source.match(/const polled = await pollQueue.process([\s\S]*?)const classified/);
  expect(poll).not.toBeNull();
  expect(poll![1]).toContain('await topologyQueue.enqueue');
  expect(poll![1]).not.toContain('topology.handler');
});
