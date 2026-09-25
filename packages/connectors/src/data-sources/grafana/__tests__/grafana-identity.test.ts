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

function grafana(user: () => Response) {
  const paths: string[] = [];
  const impl = (async (url: string) => {
    paths.push(new URL(String(url)).pathname);
    return user();
  }) as unknown as typeof fetch;
  return { paths, connector: makeGrafanaConnector(config, impl, lookup) };
}

test('reads the login Grafana logs for this connection', async () => {
  const { paths, connector } = grafana(() =>
    Response.json({ login: 'sa-1-homelab', name: 'homelab', uid: 'sa-1' }),
  );
  expect(await connector.identity!()).toBe('sa-1-homelab');
  expect(paths).toEqual(['/api/user']);
});

test('only a service-account login is reported, never a person', async () => {
  expect(await grafana(() => Response.json({ login: 'alice' })).connector.identity!()).toBeNull();
  expect(await grafana(() => Response.json({ name: 'no login' })).connector.identity!()).toBeNull();
});

test('an unreadable credential exposes no identity lookup', () => {
  const impl = (async () => Response.json({ login: 'sa-1-x' })) as unknown as typeof fetch;
  const connector = makeGrafanaConnector(
    { ...config, credentialStatus: 'unavailable' },
    impl,
    lookup,
  );
  expect(connector.identity).toBeUndefined();
});

test('a rejected credential surfaces as an error', async () => {
  await expect(
    grafana(() => new Response(null, { status: 401 })).connector.identity!(),
  ).rejects.toBeDefined();
});
