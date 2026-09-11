import { describe, expect, test } from 'vitest';

import { connectorCredentialKey } from '@sre/db';

import { ConnectorRegistry, makeDatadogConnector, makeGrafanaConnector } from '@sre/connectors';

import { registerTestConnector } from './connector-registry';

import { createFixture } from './connectors.fixture';

const __fixture = createFixture();

describe('observability connector lifecycles', () => {
  test('creates, verifies, edits, and disconnects Datadog and Grafana independently', async () => {
    const providerFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url,
      );
      const headers = init?.headers as Record<string, string> | undefined;
      if (url.hostname === 'api.datadoghq.eu') {
        expect(headers).toMatchObject({
          'DD-API-KEY': 'dd-api-key',
          'DD-APPLICATION-KEY': 'dd-app-key',
        });
        return Response.json({ valid: true });
      }
      if (url.hostname === 'grafana.example.com') {
        expect(headers?.Authorization).toBe('Bearer grafana-service-token');
        return Response.json({ id: 1, name: 'Main Org.' });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const registry = new ConnectorRegistry();
    registerTestConnector(registry, 'datadog', (config) =>
      makeDatadogConnector(config, providerFetch),
    );
    registerTestConnector(registry, 'grafana', (config) =>
      makeGrafanaConnector(config, providerFetch, async () => ['93.184.216.34']),
    );
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, { registry });
    const created: Array<{ type: 'datadog' | 'grafana'; id: string }> = [];
    try {
      const datadog = await route.request('/connectors/datadog', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          name: 'EU Datadog',
          settings: { site: 'datadoghq.eu' },
          credential: JSON.stringify({ apiKey: 'dd-api-key', appKey: 'dd-app-key' }),
        }),
      });
      expect(datadog.status).toBe(200);
      const datadogId = ((await datadog.json()) as { connectorId: string }).connectorId;
      created.push({ type: 'datadog', id: datadogId });

      const grafana = await route.request('/connectors/grafana', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          name: 'Platform Grafana',
          settings: { baseUrl: 'http://grafana.example.com' },
          credential: 'grafana-service-token',
          insecureHttpAcknowledged: true,
        }),
      });
      expect(grafana.status).toBe(200);
      const grafanaId = ((await grafana.json()) as { connectorId: string }).connectorId;
      created.push({ type: 'grafana', id: grafanaId });

      for (const connector of created) {
        const verified = await route.request(`/connectors/${connector.type}/${connector.id}/test`, {
          method: 'POST',
          headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        });
        expect(verified.status).toBe(200);
        expect(await verified.json()).toMatchObject({
          status: 'healthy',
          reachable: true,
          authorized: true,
          enabled: true,
        });
      }

      const renamed = await route.request(`/connectors/grafana/${grafanaId}`, {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          name: 'Operations Grafana',
          settings: { baseUrl: 'http://grafana.example.com' },
          insecureHttpAcknowledged: true,
        }),
      });
      expect(renamed.status).toBe(200);
      expect(
        await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey(grafanaId)),
      ).toBe('grafana-service-token');

      const listing = await route.request('/connectors', {
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      const body = (await listing.json()) as {
        connectors: Array<{ id: string; name: string; type: string; enabled: boolean }>;
      };
      expect(body.connectors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: datadogId, name: 'EU Datadog', enabled: true }),
          expect.objectContaining({ id: grafanaId, name: 'Operations Grafana', enabled: false }),
        ]),
      );
    } finally {
      for (const connector of created) {
        await route.request(`/connectors/${connector.type}/${connector.id}`, {
          method: 'DELETE',
          headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        });
      }
    }
    for (const connector of created)
      expect(
        await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey(connector.id)),
      ).toBeNull();
  });
});
