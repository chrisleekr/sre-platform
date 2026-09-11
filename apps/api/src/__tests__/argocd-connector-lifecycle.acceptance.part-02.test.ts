import { describe, expect, test } from 'vitest';

import { and, eq, isNull } from 'drizzle-orm';

import { connectorConfigs, connectorCredentialKey, withTenant } from '@sre/db';

import { ConnectorRegistry, stubConnector } from '@sre/connectors';

import { registerTestConnector } from './connector-registry';

import { createFixture } from './argocd-connector-lifecycle.acceptance.fixture';

const __fixture = createFixture();

describe('ArgoCD connector lifecycle acceptance', () => {
  test('a stale verification cannot enable a deleted and recreated connector row', async () => {
    let entered!: () => void;
    let release!: () => void;
    const probeEntered = new Promise<void>((resolve) => (entered = resolve));
    const probeRelease = new Promise<void>((resolve) => (release = resolve));
    const probingRegistry = new ConnectorRegistry();
    registerTestConnector(probingRegistry, 'argocd', (config) => ({
      ...stubConnector('argocd', config),
      probe: async () => {
        entered();
        await probeRelease;
        return {
          status: 'healthy' as const,
          reachable: true,
          authorized: true,
          warnings: [],
          checks: { canListApplications: true },
        };
      },
    }));
    const probingApi = __fixture.connectorApp(probingRegistry);
    const editingApi = __fixture.connectorApp();
    const settings = __fixture.projectSettings();
    expect(
      (
        await editingApi.request('/connectors/argocd', {
          method: 'PUT',
          headers: await __fixture.headers(),
          body: JSON.stringify({
            settings,
            credentials: __fixture.projectCredentials('old-token'),
          }),
        })
      ).status,
    ).toBe(200);

    const staleProbe = probingApi.request('/connectors/argocd/test', {
      method: 'POST',
      headers: await __fixture.headers(),
    });
    await probeEntered;
    expect(
      (
        await editingApi.request('/connectors/argocd', {
          method: 'DELETE',
          headers: await __fixture.headers(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await editingApi.request('/connectors/argocd', {
          method: 'PUT',
          headers: await __fixture.headers(),
          body: JSON.stringify({
            settings,
            credentials: __fixture.projectCredentials('replacement-token'),
          }),
        })
      ).status,
    ).toBe(200);
    release();

    expect((await staleProbe).status).toBe(409);
    const [row] = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx
        .select({
          enabled: connectorConfigs.enabled,
          lifecycleVersion: connectorConfigs.lifecycleVersion,
        })
        .from(connectorConfigs)
        .where(and(eq(connectorConfigs.type, 'argocd'), isNull(connectorConfigs.deletedAt))),
    );
    expect(row).toEqual({ enabled: false, lifecycleVersion: 0 });
    expect(
      await __fixture.secrets.get(
        __fixture.tenantId,
        connectorCredentialKey(await __fixture.activeArgoCdId()),
      ),
    ).toBe(__fixture.storedCredential('replacement-token'));
  });
});
