import { expect, test, vi } from 'vitest';
import {
  makeGrafanaConnector,
  makeStatusCakeConnector,
  makeKubernetesConnector,
  type ConnectorConfig,
} from '../index';
import { datadogTopology } from '../data-sources/datadog/topology';

const config = (type: ConnectorConfig['type']): ConnectorConfig => ({
  id: 'source',
  name: type,
  tenantId: 'tenant',
  type,
  settings: { baseUrl: 'https://provider.example', apiUrl: 'https://provider.example' },
  getCredential: async () => 'token',
});
const lookup = async () => ['93.184.216.34'];

test.each([undefined, false, true])(
  'Datadog log discovery requires explicit consent: %s',
  async (collectLogs) => {
    const logs = vi.fn(async () => ({ data: [] })),
      spans = vi.fn(async () => ({ data: [] }));
    const cfg = config('datadog');
    cfg.settings = { collectLogs, collectApm: false };
    const reader = datadogTopology(cfg, () => ({ logs, spans, catalog: vi.fn() }));
    await reader.discover({
      collections: ['logs'],
      runtimeScopes: [{ clusterId: '11111111-2222-3333-4444-555555555555', namespace: 'apps' }],
    });
    expect(logs).toHaveBeenCalledTimes(collectLogs === true ? 3 : 0);
    expect(spans).not.toHaveBeenCalled();
    logs.mockClear();
    await reader.discover({ collections: ['logs'], runtimeScopes: [] });
    expect(logs).not.toHaveBeenCalled();
  },
);

test('Grafana dashboard continuation does not query completed datasources', async () => {
  const paths: string[] = [];
  const transport = (async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return Response.json([]);
  }) as typeof fetch;
  const result = await makeGrafanaConnector(
    config('grafana'),
    transport,
    lookup,
  ).topology!.discover({ collections: ['dashboards'] });
  expect(result.collections.map((row) => row.key)).toEqual(['dashboards']);
  expect(paths).toEqual(['/api/search']);
});

test('Kubernetes continuation reads only selected resources plus cluster identity', async () => {
  const paths: string[] = [];
  const transport = (async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return Response.json(
      path.endsWith('/kube-system') ? { metadata: { uid: 'cluster' } } : { items: [] },
    );
  }) as typeof fetch;
  const result = await makeKubernetesConnector(
    config('kubernetes'),
    transport,
    lookup,
  ).topology!.discover({ collections: ['pods'] });
  expect(result.collections.map((row) => row.key)).toEqual(['pods']);
  expect(paths).toEqual(['/api/v1/namespaces/kube-system', '/api/v1/pods']);
});

test('StatusCake continuation does not repeat unrelated monitor collections', async () => {
  const paths: string[] = [];
  const transport = (async (input: Parameters<typeof fetch>[0]) => {
    paths.push(new URL(String(input)).pathname);
    return Response.json({ data: [], metadata: { page_count: 0 } });
  }) as typeof fetch;
  const result = await makeStatusCakeConnector(config('statuscake'), transport).topology!.discover({
    collections: ['ssl'],
  });
  expect(result.collections.map((row) => row.key)).toEqual(['ssl']);
  expect(paths).toEqual(['/v1/ssl']);
});

test('Datadog catalog continuation does not repeat unavailable span discovery', async () => {
  const spans = vi.fn(async () => {
    throw new Error('Unavailable spans');
  });
  const catalog = vi.fn(async () => ({ data: [], meta: { count: 0 } }));
  const result = await datadogTopology(config('datadog'), () => ({ spans, catalog })).discover({
    collections: ['catalog-services'],
  });
  expect(result.collections.map((row) => row.key)).toEqual(['catalog-services']);
  expect(spans).not.toHaveBeenCalled();
  expect(catalog).toHaveBeenCalledTimes(1);
});
