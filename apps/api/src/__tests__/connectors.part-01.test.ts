import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { connectorConfigs, connectorCredentialKey, withTenant } from '@sre/db';

import { createFixture } from './connectors.fixture';

const __fixture = createFixture();

describe('connector config CRUD', () => {
  test('admin creates a connector; credential is encrypted-at-rest and not echoed', async () => {
    const credential = JSON.stringify({ apiKey: 'dd-api-key', appKey: 'dd-app-key' });
    const res = await __fixture.api.request('/connectors/datadog', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
      body: JSON.stringify({ settings: { site: 'datadoghq.eu' }, credential }),
    });
    expect(res.status).toBe(200);
    expect(await __fixture.activeCredential('datadog')).toBe(credential);
  });

  test('GET lists configs without the credential', async () => {
    const res = await __fixture.api.request('/connectors', {
      headers: { authorization: `Bearer ${await __fixture.sign(__fixture.orgA, ['responder'])}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectors: Array<Record<string, unknown>> };
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0]).toMatchObject({
      type: 'datadog',
      settings: { site: 'datadoghq.eu' },
      enabled: false,
    });
    expect(JSON.stringify(body)).not.toContain('dd-api-key');
  });

  test('another tenant cannot see the connector (RLS)', async () => {
    const res = await __fixture.api.request('/connectors', {
      headers: { authorization: `Bearer ${await __fixture.sign(__fixture.orgB, ['responder'])}` },
    });
    const body = (await res.json()) as { connectors: unknown[] };
    expect(body.connectors).toHaveLength(0);
  });

  test('APM opt-out and log consent survive older-client updates without rotating keys', async () => {
    const headers = __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin']));
    for (const settings of [
      { site: 'datadoghq.eu', collectApm: false, collectLogs: true },
      { site: 'datadoghq.eu' },
    ]) {
      const saved = await __fixture.api.request('/connectors/datadog', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ settings }),
      });
      expect(saved.status).toBe(200);
      const listed = await __fixture.api.request('/connectors', { headers });
      const body = (await listed.json()) as { connectors: { settings: unknown }[] };
      expect(body.connectors[0]!.settings).toMatchObject({ collectApm: false, collectLogs: true });
      expect(await __fixture.activeCredential('datadog')).toBe(
        JSON.stringify({ apiKey: 'dd-api-key', appKey: 'dd-app-key' }),
      );
    }
    const invalid = await __fixture.api.request('/connectors/datadog', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ settings: { site: 'datadoghq.eu', collectApm: 'false' } }),
    });
    expect(invalid.status).toBe(400);
    const invalidLogs = await __fixture.api.request('/connectors/datadog', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ settings: { site: 'datadoghq.eu', collectLogs: 'true' } }),
    });
    expect(invalidLogs.status).toBe(400);
  });

  test('unknown connector type is rejected', async () => {
    const res = await __fixture.api.request('/connectors/nope', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('DELETE removes the config', async () => {
    const del = await __fixture.api.request('/connectors/datadog', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await __fixture.sign(__fixture.orgA, ['admin'])}` },
    });
    expect(del.status).toBe(200);
    const res = await __fixture.api.request('/connectors', {
      headers: { authorization: `Bearer ${await __fixture.sign(__fixture.orgA, ['responder'])}` },
    });
    expect(((await res.json()) as { connectors: unknown[] }).connectors).toHaveLength(0);
  });

  test('creates, addresses, and disconnects multiple instances of one connector type', async () => {
    const firstName = `StatusCake primary ${randomUUID().slice(0, 8)}`;
    const secondName = `StatusCake secondary ${randomUUID().slice(0, 8)}`;
    const create = async (name: string, credential: string) => {
      const response = await __fixture.api.request('/connectors/statuscake', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ name, settings: {}, credential }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { connectorId: string; name: string };
    };
    const first = await create(firstName, 'statuscake-primary-token');
    const second = await create(secondName, 'statuscake-secondary-token');
    try {
      expect(first.connectorId).not.toBe(second.connectorId);
      const listing = await __fixture.api.request('/connectors', {
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      const configured = (
        (await listing.json()) as {
          connectors: Array<{ id: string; name: string; type: string }>;
        }
      ).connectors.filter((connector) => connector.type === 'statuscake');
      expect(configured).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.connectorId, name: firstName }),
          expect.objectContaining({ id: second.connectorId, name: secondName }),
        ]),
      );

      const ambiguous = await __fixture.api.request('/connectors/statuscake/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(ambiguous.status).toBe(409);
      expect(await ambiguous.json()).toEqual({
        error: 'data source ID is required when multiple connections exist',
      });

      const renamed = await __fixture.api.request(`/connectors/statuscake/${first.connectorId}`, {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ name: `${firstName} renamed`, settings: {} }),
      });
      expect(renamed.status).toBe(200);
      expect(
        await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey(first.connectorId)),
      ).toBe('statuscake-primary-token');
      expect(
        await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey(second.connectorId)),
      ).toBe('statuscake-secondary-token');
    } finally {
      for (const connector of [first, second]) {
        const disconnected = await __fixture.api.request(
          `/connectors/statuscake/${connector.connectorId}`,
          {
            method: 'DELETE',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
          },
        );
        expect(disconnected.status).toBe(200);
        expect(
          await __fixture.secrets.get(
            __fixture.tenantA,
            connectorCredentialKey(connector.connectorId),
          ),
        ).toBeNull();
      }
    }
  });

  test('requires a distinct GitHub App registration for each data source', async () => {
    const appId = `Iv1.${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const create = async (name: string, installationId: number) =>
      __fixture.api.request('/connectors/github', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          name,
          settings: { appId, installationId, eventTransport: 'direct' },
          credential: 'dedicated-private-key',
          webhookSecret: 'dedicated-webhook-secret',
        }),
      });

    const responses = await Promise.all([
      create('Primary GitHub App', 7001),
      create('Second installation, same App', 7002),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const accepted = bodies.find(
      (body): body is { connectorId: string } =>
        typeof body === 'object' && body !== null && 'connectorId' in body,
    );
    expect(bodies).toContainEqual({
      error:
        'this GitHub App is already connected; use a separate dedicated App for another data source',
    });
    expect(accepted).toBeDefined();
    const rows = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
      tx
        .select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.type, 'github'),
            isNull(connectorConfigs.deletedAt),
            sql`${connectorConfigs.settings}->>'appId' = ${appId}`,
          ),
        ),
    );
    expect(rows).toHaveLength(1);
    if (accepted) {
      const disconnected = await __fixture.api.request(
        `/connectors/github/${accepted.connectorId}`,
        {
          method: 'DELETE',
          headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        },
      );
      expect(disconnected.status).toBe(200);
      await __fixture.admin.db
        .delete(connectorConfigs)
        .where(eq(connectorConfigs.id, accepted.connectorId));
    }
  });
});
