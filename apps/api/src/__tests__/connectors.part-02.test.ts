import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { connectorConfigs, connectorEventCredentialKey, withTenant } from '@sre/db';

import {
  ConnectorRegistry,
  alertmanagerEventToken,
  alertmanagerSmeeUrl,
  makePrometheusConnector,
  makeStatusCakeConnector,
  stubConnector,
} from '@sre/connectors';

import { registerTestConnector } from './connector-registry';

import { createFixture } from './connectors.fixture';

const __fixture = createFixture();

describe('on-demand connector lifecycles', () => {
  function onDemandRegistry(): ConnectorRegistry {
    const registry = new ConnectorRegistry();
    const providerFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url,
      );
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.hostname === 'prometheus.example.com') {
        expect(headers.Authorization).toBe('Bearer prom-token');
        return Response.json({ status: 'success', data: { result: [] } });
      }
      if (url.hostname === 'api.statuscake.com') {
        expect(headers.Authorization).toBe('Bearer statuscake-token');
        return Response.json({ data: [] });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    registerTestConnector(registry, 'prometheus', (config) =>
      makePrometheusConnector(config, providerFetch, async () => ['93.184.216.34']),
    );
    registerTestConnector(registry, 'statuscake', (config) =>
      makeStatusCakeConnector(config, providerFetch),
    );
    return registry;
  }

  test('Prometheus stays disabled until verified and preserves write-only credentials on edit', async () => {
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry: onDemandRegistry(),
    });
    try {
      const save = await route.request('/connectors/prometheus', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: {
            baseUrl: 'https://prometheus.example.com',
            authType: 'bearer',
            caCert: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----',
          },
          credential: JSON.stringify({ type: 'bearer', token: 'prom-token' }),
          enabled: true,
        }),
      });
      expect(save.status).toBe(200);
      let rows = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .select({ enabled: connectorConfigs.enabled })
          .from(connectorConfigs)
          .where(eq(connectorConfigs.type, 'prometheus')),
      );
      expect(rows[0]?.enabled).toBe(false);

      const listing = await route.request('/connectors', {
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      const body = (await listing.json()) as { connectors: Array<Record<string, unknown>> };
      expect(body.connectors[0]).toMatchObject({
        type: 'prometheus',
        settings: {
          baseUrl: 'https://prometheus.example.com',
          authType: 'bearer',
          caConfigured: true,
        },
        capabilities: { investigation: 'tools', polling: 'none' },
        credentialConfigured: true,
      });
      expect(body.connectors[0]).not.toHaveProperty('polling');
      expect(body.connectors[0]).not.toHaveProperty('repositoryCount');
      expect(JSON.stringify(body)).not.toContain('BEGIN CERTIFICATE');
      expect(JSON.stringify(body)).not.toContain('prom-token');

      const verified = await route.request('/connectors/prometheus/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(verified.status).toBe(200);
      expect(await verified.json()).toMatchObject({ status: 'healthy', enabled: true });

      const edit = await route.request('/connectors/prometheus', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: { baseUrl: 'https://prometheus.example.com', authType: 'bearer' },
        }),
      });
      expect(edit.status).toBe(200);
      expect(await __fixture.activeCredential('prometheus')).toBe(
        JSON.stringify({ type: 'bearer', token: 'prom-token' }),
      );
      rows = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .select({ enabled: connectorConfigs.enabled })
          .from(connectorConfigs)
          .where(eq(connectorConfigs.type, 'prometheus')),
      );
      expect(rows[0]?.enabled).toBe(false);
    } finally {
      await route.request('/connectors/prometheus', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });

  test('accepts and verifies an HTTP Prometheus endpoint', async () => {
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry: onDemandRegistry(),
    });
    const save = await route.request('/connectors/prometheus', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        name: `Private Prometheus ${randomUUID().slice(0, 8)}`,
        settings: {
          baseUrl: 'http://prometheus.example.com',
          authType: 'bearer',
          eventTransport: 'none',
        },
        credential: JSON.stringify({ type: 'bearer', token: 'prom-token' }),
        insecureHttpAcknowledged: true,
      }),
    });
    expect(save.status).toBe(200);
    const { connectorId } = (await save.json()) as { connectorId: string };
    try {
      const verified = await route.request(`/connectors/prometheus/${connectorId}/test`, {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(await verified.json()).toMatchObject({ status: 'healthy', enabled: true });
    } finally {
      await route.request(`/connectors/prometheus/${connectorId}`, {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });

  test('requires HTTP risk acknowledgement and refuses mTLS without HTTPS', async () => {
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry: onDemandRegistry(),
    });
    for (const input of [
      {
        type: 'prometheus',
        settings: {
          baseUrl: 'http://prometheus.example.com',
          authType: 'none',
          eventTransport: 'none',
        },
        credential: JSON.stringify({ type: 'none' }),
      },
      {
        type: 'grafana',
        settings: { baseUrl: 'http://grafana.example.com' },
        credential: 'grafana-service-token',
      },
    ]) {
      const response = await route.request(`/connectors/${input.type}`, {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          name: `Unacknowledged ${input.type}`,
          settings: input.settings,
          credential: input.credential,
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'HTTP transport requires explicit acknowledgement',
      });
    }

    const mtls = await route.request('/connectors/prometheus', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        name: 'Invalid HTTP mTLS',
        settings: {
          baseUrl: 'http://prometheus.example.com',
          authType: 'mtls',
          eventTransport: 'none',
        },
        credential: JSON.stringify({ type: 'mtls', cert: 'cert', key: 'key' }),
        insecureHttpAcknowledged: true,
      }),
    });
    expect(mtls.status).toBe(400);
    expect(await mtls.json()).toEqual({ error: 'invalid Prometheus settings' });
  });

  test('starts Alertmanager Smee only after verification and stops it when the draft changes', async () => {
    const replace = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry: onDemandRegistry(),
      alertmanagerSmee: { replace, stop },
    });
    const eventToken = 'alertmanager-event-token-for-tests';
    const smeeUrl = 'https://smee.io/alertmanager-test-channel';
    const save = await route.request('/connectors/prometheus', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        name: `Prometheus events ${randomUUID().slice(0, 8)}`,
        settings: {
          baseUrl: 'https://prometheus.example.com',
          authType: 'bearer',
          eventTransport: 'smee',
          alertChannel: 'C07ALERTS',
          cohortWindowSec: 120,
          smeeUrl,
        },
        credential: JSON.stringify({ type: 'bearer', token: 'prom-token' }),
        eventToken,
      }),
    });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as {
      connectorId: string;
      webhookPath: string;
      relayStatus: string;
    };
    expect(saved).toMatchObject({
      webhookPath: `/webhooks/alertmanager/${saved.connectorId}`,
      relayStatus: 'stopped',
    });
    expect(replace).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith(saved.connectorId);

    const eventCredential = await __fixture.secrets.get(
      __fixture.tenantA,
      connectorEventCredentialKey(saved.connectorId),
    );
    expect(alertmanagerEventToken(eventCredential)).toBe(eventToken);
    expect(alertmanagerSmeeUrl(eventCredential)).toBe(smeeUrl);
    const listing = await route.request('/connectors', {
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
    });
    const connector = (
      (await listing.json()) as { connectors: Array<Record<string, unknown>> }
    ).connectors.find((item) => item.id === saved.connectorId)!;
    expect(connector).toMatchObject({
      webhookPath: saved.webhookPath,
      settings: {
        eventTransport: 'smee',
        eventCredentialConfigured: true,
        smeeConfigured: true,
      },
    });
    expect(JSON.stringify(connector)).not.toContain(eventToken);
    expect(JSON.stringify(connector)).not.toContain(smeeUrl);

    stop.mockClear();
    const verified = await route.request(`/connectors/prometheus/${saved.connectorId}/test`, {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      status: 'healthy',
      enabled: true,
      relayStatus: 'connected',
    });
    expect(replace).toHaveBeenCalledWith(
      __fixture.tenantA,
      saved.connectorId,
      smeeUrl,
      saved.connectorId,
    );
    expect(stop).not.toHaveBeenCalled();

    const edit = await route.request(`/connectors/prometheus/${saved.connectorId}`, {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        settings: {
          baseUrl: 'https://prometheus.example.com',
          authType: 'bearer',
          eventTransport: 'direct',
          alertChannel: 'C07ALERTS',
          cohortWindowSec: 120,
        },
      }),
    });
    expect(edit.status).toBe(200);
    expect(stop).toHaveBeenCalledWith(saved.connectorId);
    const directCredential = await __fixture.secrets.get(
      __fixture.tenantA,
      connectorEventCredentialKey(saved.connectorId),
    );
    expect(alertmanagerEventToken(directCredential)).toBe(eventToken);
    expect(alertmanagerSmeeUrl(directCredential)).toBeNull();

    stop.mockClear();
    const disableEvents = await route.request(`/connectors/prometheus/${saved.connectorId}`, {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        settings: {
          baseUrl: 'https://prometheus.example.com',
          authType: 'bearer',
          eventTransport: 'none',
          cohortWindowSec: 120,
        },
      }),
    });
    expect(disableEvents.status).toBe(200);
    expect(stop).toHaveBeenCalledWith(saved.connectorId);
    expect(
      await __fixture.secrets.get(
        __fixture.tenantA,
        connectorEventCredentialKey(saved.connectorId),
      ),
    ).toBeNull();

    const disconnected = await route.request(`/connectors/prometheus/${saved.connectorId}`, {
      method: 'DELETE',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
    });
    expect(disconnected.status).toBe(200);
    expect(
      await __fixture.secrets.get(
        __fixture.tenantA,
        connectorEventCredentialKey(saved.connectorId),
      ),
    ).toBeNull();
  });

  test('keeps Alertmanager Smee stopped after a failed Prometheus verification', async () => {
    const registry = new ConnectorRegistry();
    registerTestConnector(registry, 'prometheus', (config) => ({
      ...stubConnector('prometheus', config),
      probe: async () => ({
        status: 'unhealthy' as const,
        reachable: false,
        authorized: false,
        warnings: ['prometheus did not respond'],
      }),
    }));
    const replace = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry,
      alertmanagerSmee: { replace, stop },
    });
    const save = await route.request('/connectors/prometheus', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        name: `Unavailable Prometheus ${randomUUID().slice(0, 8)}`,
        settings: {
          baseUrl: 'https://prometheus-unavailable.example.com',
          authType: 'none',
          eventTransport: 'smee',
          alertChannel: 'C07ALERTS',
          cohortWindowSec: 120,
          smeeUrl: 'https://smee.io/alertmanager-unavailable',
        },
        credential: JSON.stringify({ type: 'none' }),
        eventToken: 'alertmanager-event-token-for-failed-probe',
      }),
    });
    const saved = (await save.json()) as { connectorId: string };
    stop.mockClear();

    const verified = await route.request(`/connectors/prometheus/${saved.connectorId}/test`, {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      status: 'unhealthy',
      enabled: false,
      relayStatus: 'stopped',
    });
    expect(replace).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith(saved.connectorId);

    await route.request(`/connectors/prometheus/${saved.connectorId}`, {
      method: 'DELETE',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
    });
  });

  test('persists Alertmanager relay startup failure and clears it after a successful retry', async () => {
    const replace = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Smee unavailable'))
      .mockResolvedValue(undefined);
    const stop = vi.fn(async () => {});
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry: onDemandRegistry(),
      alertmanagerSmee: { replace, stop },
    });
    const save = await route.request('/connectors/prometheus', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        name: `Prometheus relay retry ${randomUUID().slice(0, 8)}`,
        settings: {
          baseUrl: 'https://prometheus.example.com',
          authType: 'bearer',
          eventTransport: 'smee',
          alertChannel: 'C07ALERTS',
          cohortWindowSec: 120,
          smeeUrl: 'https://smee.io/alertmanager-retry',
        },
        credential: JSON.stringify({ type: 'bearer', token: 'prom-token' }),
        eventToken: 'alertmanager-event-token-for-relay-retry',
      }),
    });
    const saved = (await save.json()) as { connectorId: string };
    try {
      const failed = await route.request(`/connectors/prometheus/${saved.connectorId}/test`, {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(await failed.json()).toMatchObject({
        status: 'healthy',
        enabled: true,
        relayStatus: 'failed',
      });
      expect((await __fixture.activeConnector('prometheus')).eventFailureCategory).toBe(
        'relay_unreachable',
      );

      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .update(connectorConfigs)
          .set({ eventFailureCategory: 'invalid_payload' })
          .where(eq(connectorConfigs.id, saved.connectorId)),
      );
      const recovered = await route.request(`/connectors/prometheus/${saved.connectorId}/test`, {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(await recovered.json()).toMatchObject({ relayStatus: 'connected' });
      expect((await __fixture.activeConnector('prometheus')).eventFailureCategory).toBe(
        'invalid_payload',
      );

      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .update(connectorConfigs)
          .set({ eventFailureCategory: 'relay_unreachable' })
          .where(eq(connectorConfigs.id, saved.connectorId)),
      );
      const relayRecovered = await route.request(
        `/connectors/prometheus/${saved.connectorId}/test`,
        {
          method: 'POST',
          headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        },
      );
      expect(await relayRecovered.json()).toMatchObject({ relayStatus: 'connected' });
      expect((await __fixture.activeConnector('prometheus')).eventFailureCategory).toBeNull();
    } finally {
      await route.request(`/connectors/prometheus/${saved.connectorId}`, {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });

  test('StatusCake verifies before enabling and incomplete connectors cannot be configured', async () => {
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry: onDemandRegistry(),
    });
    try {
      const save = await route.request('/connectors/statuscake', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings: {}, credential: 'statuscake-token', enabled: true }),
      });
      expect(save.status).toBe(200);
      const verified = await route.request('/connectors/statuscake/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(await verified.json()).toMatchObject({ status: 'healthy', enabled: true });

      const aws = await route.request('/connectors/aws', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings: {}, credential: 'unused' }),
      });
      expect(aws.status).toBe(400);
      expect(await aws.json()).toEqual({ error: 'connector type is not available' });
    } finally {
      await route.request('/connectors/statuscake', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });

  test('requires explicit acknowledgement before disabling Prometheus TLS verification', async () => {
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry: onDemandRegistry(),
    });
    const response = await route.request('/connectors/prometheus', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        settings: {
          baseUrl: 'https://prometheus.example.com',
          authType: 'none',
          insecureSkipTLSVerify: true,
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'insecure TLS requires explicit acknowledgement',
    });
  });
});
