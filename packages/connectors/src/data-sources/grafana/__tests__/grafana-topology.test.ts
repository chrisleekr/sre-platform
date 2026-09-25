import { expect, test } from 'vitest';
import type { ConnectorConfig } from '../../../registry';
import type { HostLookup } from '../../../ssrf';
import { makeGrafanaConnector } from '../index';

const lookup: HostLookup = async () => ['93.184.216.34'];

const config: ConnectorConfig = {
  tenantId: 't1',
  type: 'grafana',
  settings: { baseUrl: 'https://grafana.example.com' },
  getCredential: async () => 'sa-token',
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Test Grafana',
};

function grafana(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const route = routes[path];
    return route ? route() : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, connector: makeGrafanaConnector(config, impl, lookup) };
}

test('a throttled dashboard read stops the page, keeps its cursor and reports rate_limited', async () => {
  const { calls, connector } = grafana({
    '/api/datasources': () => Response.json([]),
    '/api/search': () =>
      Response.json([
        { uid: 'first', title: 'First' },
        { uid: 'throttled', title: 'Throttled' },
        { uid: 'unread', title: 'Unread' },
      ]),
    '/api/dashboards/uid/first': () =>
      Response.json({ dashboard: { panels: [{ datasource: { uid: 'prom' } }] } }),
    '/api/dashboards/uid/throttled': () => new Response(null, { status: 429 }),
  });

  const result = await connector.topology!.discover({
    scans: { dashboards: { cursor: '3', incomplete: false } },
  });

  const dashboards = result.collections.find((collection) => collection.key === 'dashboards');
  expect(dashboards).toMatchObject({ issue: 'rate_limited', scan: { cursor: '3' } });
  expect(dashboards?.relations.map((relation) => relation.to.id)).toEqual(['prom']);
  expect(calls).not.toContain('/api/dashboards/uid/unread');
});

test('a throttled search reports rate_limited so discovery sets its cooldown', async () => {
  const { connector } = grafana({
    '/api/datasources': () => Response.json([]),
    '/api/search': () => new Response(null, { status: 429 }),
  });

  const result = await connector.topology!.discover();

  expect(result.collections.find((collection) => collection.key === 'dashboards')).toMatchObject({
    completeness: 'unavailable',
    issue: 'rate_limited',
  });
});
