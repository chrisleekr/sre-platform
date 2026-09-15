import { expect, test, vi } from 'vitest';
import {
  makeDatadogConnector,
  makePrometheusConnector,
  makeStatusCakeConnector,
  makeGrafanaConnector,
  type ConnectorConfig,
} from '../index';

const lookup = async () => ['93.184.216.34'];

test('observability discovery reports oversized responses as limits, not empty successful inventories', async () => {
  const { fetchImpl } = transport(
    () =>
      new Response('not parsed', {
        headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
      }),
  );
  for (const source of [
    makePrometheusConnector(
      config('prometheus', { baseUrl: 'https://prom.example' }),
      fetchImpl,
      lookup,
    ),
  ]) {
    await expect(source.topology!.discover()).rejects.toMatchObject({ issue: 'limit' });
  }
  for (const source of [
    makeDatadogConnector(config('datadog'), fetchImpl),
    makeGrafanaConnector(
      config('grafana', { baseUrl: 'https://grafana.example' }),
      fetchImpl,
      lookup,
    ),
    makeStatusCakeConnector(config('statuscake'), fetchImpl),
  ]) {
    const result = await source.topology!.discover();
    expect(result.collections.length).toBeGreaterThan(0);
    expect(
      result.collections.every((c) => c.issue === 'limit' && c.completeness === 'unavailable'),
    ).toBe(true);
  }
});

test('StatusCake shares the deadline across pages but not across scheduled discoveries', async () => {
  vi.useFakeTimers();
  try {
    const { fetchImpl, calls } = transport(() => {
      vi.setSystemTime(Date.now() + 46000);
      return { data: [{ id: 'one', name: 'First monitor' }], metadata: { page_count: 2 } };
    });
    const source = makeStatusCakeConnector(config('statuscake'), fetchImpl);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await source.topology!.discover();
      expect(calls).toHaveLength(attempt);
      expect(result.collections[0]).toMatchObject({ completeness: 'partial', issue: 'limit' });
      expect(result.collections[0]?.entities).toHaveLength(1);
      expect(
        result.collections
          .slice(1)
          .every((c) => c.completeness === 'unavailable' && c.issue === 'limit'),
      ).toBe(true);
    }
  } finally {
    vi.useRealTimers();
  }
});
const at = new Date(Date.now() - 5000).toISOString();
const config = (
  type: ConnectorConfig['type'],
  settings: Record<string, unknown> = {},
): ConnectorConfig => ({
  id: `source-${type}`,
  tenantId: 'tenant',
  name: type,
  type,
  settings,
  getCredential: async () =>
    type === 'datadog'
      ? JSON.stringify({ apiKey: 'api-key', appKey: 'app-key' })
      : type === 'prometheus'
        ? JSON.stringify({ type: 'none' })
        : 'private-api-token',
});
function transport(handler: (url: URL) => unknown | Response) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const value = handler(url);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const span = (
  service: string,
  spanId: string,
  parentId = '0',
  env = 'prod',
  trace = 'trace-one',
) => ({
  attributes: {
    service,
    span_id: spanId,
    parent_id: parentId,
    trace_id: trace,
    env,
    start_timestamp: at,
    attributes: { 'k8s.pod.uid': `uid-${service}`, 'k8s.namespace.name': env },
  },
});

test('Datadog discovers services and only paired cross-service calls, keeping environments distinct', async () => {
  const { fetchImpl, calls } = transport(() => ({
    data: [
      span('checkout', '1'),
      span('payments', '2', '1'),
      span('other', '3', 'missing'),
      span('checkout', '4', '2', 'staging'),
      span('noise', '5', '1', 'prod', 'other-trace'),
    ],
  }));
  const result = await makeDatadogConnector(
    config('datadog', { site: 'ap2.datadoghq.com' }),
    fetchImpl,
  ).topology!.discover();
  const collection = result.collections[0]!;
  expect(collection).toMatchObject({ completeness: 'partial', issue: 'sampling' });
  expect(collection.entities).toHaveLength(5);
  const callsGraph = collection.relations.filter((r) => r.kind === 'calls');
  expect(callsGraph).toHaveLength(2);
  expect(callsGraph[0]).toMatchObject({
    attributes: { traceId: 'trace-one', parentSpanId: '1', childSpanId: '2' },
    evidenceAt: at,
  });
  expect(callsGraph[1]?.scope).toEqual({ callerEnvironment: 'prod', calleeEnvironment: 'staging' });
  expect(collection.relations.filter((r) => r.kind === 'runs_on')).toHaveLength(5);
  expect(calls[0]?.url.href).toBe('https://api.ap2.datadoghq.com/api/v2/spans/events/search');
  expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
  expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
    data: { attributes: { page: { limit: 200 } } },
  });
});

test('Datadog rejects ambiguous span identities and never creates a call from a shared trace alone', async () => {
  const { fetchImpl } = transport(() => ({
    data: [
      span('first', '1'),
      span('conflicting', '1'),
      span('child', '2', '1'),
      span('unpaired', '3'),
    ],
  }));
  const result = await makeDatadogConnector(config('datadog'), fetchImpl).topology!.discover();
  expect(result.collections[0]?.relations.filter((r) => r.kind === 'calls')).toEqual([]);
});

test('Prometheus targets remain monitors, including secret-bearing scrape URLs without disclosing them', async () => {
  const { fetchImpl, calls } = transport(() => ({
    status: 'success',
    data: {
      activeTargets: [
        {
          scrapePool: 'api',
          scrapeUrl: 'https://api.example/metrics',
          labels: { job: 'api', service: 'not-proof' },
          health: 'up',
          discoveredLabels: {
            __meta_kubernetes_pod_uid: 'pod-uid',
            __meta_kubernetes_namespace: 'production',
          },
        },
        {
          scrapePool: 'private',
          scrapeUrl: 'https://api.example/metrics?access_token=do-not-store',
          labels: { job: 'private' },
          health: 'down',
        },
      ],
    },
  }));
  const result = await makePrometheusConnector(
    config('prometheus', { baseUrl: 'https://prom.example' }),
    fetchImpl,
    lookup,
  ).topology!.discover();
  const collection = result.collections[0]!;
  expect(collection.completeness).toBe('complete');
  expect(collection.entities.filter((e) => e.kind === 'monitor')).toHaveLength(2);
  expect(collection.entities.some((e) => e.kind === 'service')).toBe(false);
  expect(collection.relations).toHaveLength(2);
  expect(collection.relations.find((r) => r.to.authority === 'kubernetes-object')?.to.id).toBe(
    JSON.stringify(['production', 'pod-uid']),
  );
  expect(JSON.stringify(result)).not.toContain('do-not-store');
  expect(calls[0]?.url.pathname).toBe('/api/v1/targets');
  expect(calls[0]?.url.searchParams.get('state')).toBe('active');
});

test('StatusCake follows bounded pagination and never projects heartbeat write credentials', async () => {
  const { fetchImpl, calls } = transport((url) => {
    const kind = url.pathname.split('/').at(-1),
      page = Number(url.searchParams.get('page'));
    const data =
      kind === 'uptime'
        ? [
            {
              id: String(page),
              name: `Monitor ${page}`,
              website_url: `https://api.example/${page}`,
              status: 'up',
            },
          ]
        : kind === 'heartbeat'
          ? [
              {
                id: 'heartbeat',
                name: 'Worker',
                url: 'https://push.statuscake.com/?PK=never-retain-this',
              },
            ]
          : [];
    return { data, metadata: { page, page_count: kind === 'uptime' ? 2 : 1 } };
  });
  const result = await makeStatusCakeConnector(
    config('statuscake'),
    fetchImpl,
  ).topology!.discover();
  expect(
    result.collections
      .find((c) => c.key === 'uptime')
      ?.entities.filter((e) => e.kind === 'monitor'),
  ).toHaveLength(2);
  expect(result.collections.find((c) => c.key === 'heartbeat')?.relations).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('never-retain-this');
  expect(calls).toHaveLength(5);
  expect(
    calls.every(
      (c) =>
        c.url.origin === 'https://api.statuscake.com' &&
        !c.init?.method &&
        c.init?.redirect === 'error',
    ),
  ).toBe(true);
});

test('Grafana contributes dashboard and backend references without querying a datasource or retaining secrets', async () => {
  const { fetchImpl, calls } = transport((url) => {
    if (url.pathname === '/api/datasources')
      return [
        {
          uid: 'prom',
          name: 'Metrics',
          type: 'prometheus',
          url: 'https://prom.example',
          secureJsonData: { password: 'never-retain-this' },
        },
      ];
    if (url.pathname === '/api/search') return [{ uid: 'api', title: 'API Overview' }];
    return {
      dashboard: {
        panels: [
          { datasource: { uid: 'prom' }, targets: [{ expr: 'secret-looking-query-not-needed' }] },
          { panels: [{ datasource: { uid: '$datasource' } }] },
        ],
      },
    };
  });
  const result = await makeGrafanaConnector(
    config('grafana', { baseUrl: 'https://grafana.example' }),
    fetchImpl,
    lookup,
  ).topology!.discover();
  expect(result.collections.find((c) => c.key === 'dashboards')?.relations).toHaveLength(1);
  expect(result.collections.flatMap((c) => c.relations).every((r) => r.kind === 'reads_from')).toBe(
    true,
  );
  expect(calls.map((c) => c.url.pathname)).toEqual([
    '/api/datasources',
    '/api/search',
    '/api/dashboards/uid/api',
  ]);
  expect(JSON.stringify(result)).not.toContain('never-retain-this');
  expect(JSON.stringify(result)).not.toContain('secret-looking-query-not-needed');
});

test('permission failure retains precise status instead of being classified as a network failure', async () => {
  const { fetchImpl } = transport(() => new Response('', { status: 403 }));
  const datadog = await makeDatadogConnector(config('datadog'), fetchImpl).topology!.discover();
  expect(datadog.collections).toHaveLength(5);
  expect(
    datadog.collections.every(
      (collection) =>
        collection.completeness === 'unavailable' && collection.issue === 'permission_denied',
    ),
  ).toBe(true);
  await expect(
    makePrometheusConnector(
      config('prometheus', { baseUrl: 'https://prom.example' }),
      fetchImpl,
      lookup,
    ).topology!.discover(),
  ).rejects.toMatchObject({ status: 403 });
  const result = await makeStatusCakeConnector(
    config('statuscake'),
    fetchImpl,
  ).topology!.discover();
  expect(
    result.collections.every(
      (c) => c.completeness === 'unavailable' && c.issue === 'permission_denied',
    ),
  ).toBe(true);
});

test('Datadog APM preserves a provider cooldown longer than the default', async () => {
  const { fetchImpl, calls } = transport(
    () =>
      new Response('', {
        status: 429,
        headers: { 'retry-after': '900' },
      }),
  );
  const result = await makeDatadogConnector(config('datadog'), fetchImpl).topology!.discover();
  expect(result.collections[0]).toMatchObject({
    key: 'apm',
    issue: 'rate_limited',
    retryAfterMs: 900_000,
  });
  expect(calls).toHaveLength(1);
});

test.each([401, 403])('Grafana classifies HTTP %s at every collection read', async (status) => {
  for (const path of ['/api/datasources', '/api/search', '/api/dashboards/uid/api']) {
    const { fetchImpl } = transport((url) => {
      if (url.pathname === path) return new Response('', { status });
      if (url.pathname === '/api/search') return [{ uid: 'api', title: 'API' }];
      return [];
    });
    const result = await makeGrafanaConnector(
      config('grafana', { baseUrl: 'https://grafana.example' }),
      fetchImpl,
      lookup,
    ).topology!.discover();
    expect(
      result.collections.find(
        (c) => c.key === (path === '/api/datasources' ? 'datasources' : 'dashboards'),
      ),
    ).toMatchObject({
      issue: 'permission_denied',
      completeness: path.includes('/uid/') ? 'partial' : 'unavailable',
    });
  }
});

test.each([
  {},
  { status: 'success', data: { activeTargets: {} } },
  { status: 'error', data: { activeTargets: [] } },
])('Prometheus reports malformed targets as invalid evidence: %j', async (payload) => {
  const { fetchImpl } = transport(() => payload);
  const result = await makePrometheusConnector(
    config('prometheus', { baseUrl: 'https://prom.example' }),
    fetchImpl,
    lookup,
  ).topology!.discover();
  expect(result.collections).toEqual([
    {
      key: 'targets',
      completeness: 'unavailable',
      issue: 'invalid_response',
      entities: [],
      relations: [],
    },
  ]);
});
