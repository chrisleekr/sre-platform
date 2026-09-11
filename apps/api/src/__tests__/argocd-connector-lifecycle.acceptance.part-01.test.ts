import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { eq } from 'drizzle-orm';

import { connectorConfigs, connectorCredentialKey, withTenant } from '@sre/db';

import { ConnectorRegistry, stubConnector } from '@sre/connectors';

import { registerTestConnector } from './connector-registry';

import { createFixture } from './argocd-connector-lifecycle.acceptance.fixture';

const __fixture = createFixture();

describe('ArgoCD connector lifecycle acceptance', () => {
  test.each([
    'https://user:password@argocd.internal.example',
    'https://argocd.internal.example?token=secret',
    'https://argocd.internal.example#secret',
  ])('rejects credentials or opaque data in the ArgoCD URL: %s', async (baseUrl) => {
    const api = __fixture.connectorApp();
    const response = await api.request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        settings: __fixture.projectSettings(baseUrl),
        credentials: __fixture.projectCredentials('must-not-be-stored'),
      }),
    });
    expect(response.status).toBe(400);
    expect(
      await __fixture.secrets.get(__fixture.tenantId, connectorCredentialKey('argocd')),
    ).toBeNull();
    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select({ id: connectorConfigs.id }).from(connectorConfigs),
    );
    expect(rows).toEqual([]);
  });

  test.each([
    {
      settings: {
        baseUrl: `https://${'a'.repeat(2048)}.example`,
        applicationsInAnyNamespace: false,
        projects: [{ project: 'payments', applications: [{ name: 'checkout' }] }],
      },
      credentials: __fixture.projectCredentials('token'),
    },
    {
      settings: {
        baseUrl: 'https://argocd.internal.example',
        applicationsInAnyNamespace: false,
        projects: [{ project: 'a'.repeat(254), applications: [{ name: 'checkout' }] }],
      },
      credentials: [{ project: 'a'.repeat(254), token: 'token' }],
    },
    {
      settings: {
        baseUrl: 'https://argocd.internal.example',
        applicationsInAnyNamespace: true,
        projects: [
          {
            project: 'payments',
            applications: [{ namespace: 'a'.repeat(64), name: 'checkout' }],
          },
        ],
      },
      credentials: __fixture.projectCredentials('token'),
    },
    {
      settings: __fixture.projectSettings(),
      credentials: __fixture.projectCredentials('x'.repeat(64 * 1024 + 1)),
    },
  ])('rejects oversized ArgoCD fields before persistence', async (body) => {
    const response = await __fixture.connectorApp().request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(
      await __fixture.secrets.get(__fixture.tenantId, connectorCredentialKey('argocd')),
    ).toBeNull();
  });

  test('requires typed allowlisted settings and an explicit insecure-TLS acknowledgement', async () => {
    const api = __fixture.connectorApp();
    const rejected = await api.request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        settings: __fixture.projectSettings('https://argocd.internal.example', {
          insecureSkipTLSVerify: true,
        }),
        credentials: __fixture.projectCredentials('argocd-token-must-not-be-stored'),
      }),
    });
    expect(rejected.status).toBe(400);
    expect(
      await __fixture.secrets.get(__fixture.tenantId, connectorCredentialKey('argocd')),
    ).toBeNull();

    const saved = await api.request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        settings: __fixture.projectSettings('https://argocd.internal.example', {
          accessRole: 'sre-platform-a1b2c3d4',
          insecureSkipTLSVerify: true,
          ignored: 'must-not-be-projected',
        }),
        insecureTlsAcknowledged: true,
        credentials: __fixture.projectCredentials('argocd-token-write-only'),
      }),
    });
    expect(saved.status).toBe(200);

    const listed = await api.request('/connectors', { headers: await __fixture.headers() });
    const text = await listed.text();
    expect(JSON.parse(text)).toMatchObject({
      connectors: [
        {
          type: 'argocd',
          enabled: false,
          credentialConfigured: true,
          settings: {
            baseUrl: 'https://argocd.internal.example',
            accessRole: 'sre-platform-a1b2c3d4',
            applicationsInAnyNamespace: false,
            projects: [
              {
                project: 'payments',
                applications: [{ name: 'checkout' }],
                credentialConfigured: true,
              },
            ],
            insecureSkipTLSVerify: true,
          },
        },
      ],
    });
    expect(text).not.toContain('argocd-token-write-only');
    expect(text).not.toContain('must-not-be-projected');
    expect(text).not.toContain('insecureTlsAcknowledged');
  });

  test('requires distinct immutable access roles for new ArgoCD data sources', async () => {
    const api = __fixture.connectorApp();
    const { accessRole: _accessRole, ...missingRole } = __fixture.projectSettings();
    const missing = await api.request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        settings: missingRole,
        credentials: __fixture.projectCredentials('missing-role-token'),
      }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: 'new ArgoCD data sources require a unique access role',
    });

    const first = await api.request('/connectors/argocd', {
      method: 'POST',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        name: 'Primary Argo CD',
        settings: __fixture.projectSettings(),
        credentials: __fixture.projectCredentials('primary-role-token'),
      }),
    });
    expect(first.status).toBe(200);
    const firstId = ((await first.json()) as { connectorId: string }).connectorId;

    const duplicate = await api.request('/connectors/argocd', {
      method: 'POST',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        name: 'Duplicate Argo CD',
        settings: __fixture.projectSettings(),
        credentials: __fixture.projectCredentials('duplicate-role-token'),
      }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: 'this ArgoCD access role is already used by another source',
    });

    const changed = await api.request(`/connectors/argocd/${firstId}`, {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        name: 'Primary Argo CD',
        settings: __fixture.projectSettings('https://argocd.internal.example', {
          accessRole: 'sre-platform-e5f6a7b8',
        }),
      }),
    });
    expect(changed.status).toBe(400);
    expect(await changed.json()).toEqual({
      error: 'the ArgoCD access role cannot be changed; reconnect the data source instead',
    });

    const second = await api.request('/connectors/argocd', {
      method: 'POST',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        name: 'Secondary Argo CD',
        settings: __fixture.projectSettings('https://argocd.internal.example', {
          accessRole: 'sre-platform-e5f6a7b8',
        }),
        credentials: __fixture.projectCredentials('secondary-role-token'),
      }),
    });
    expect(second.status).toBe(200);
  });

  test('keeps a legacy shared ArgoCD role editable without persisting it as a new identity', async () => {
    const api = __fixture.connectorApp();
    const legacyId = randomUUID();
    const { accessRole: _accessRole, ...legacySettings } = __fixture.projectSettings();
    await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) => {
      await tx.insert(connectorConfigs).values({
        id: legacyId,
        tenantId: __fixture.tenantId,
        name: 'Legacy Argo CD',
        type: 'argocd',
        settings: legacySettings,
        enabled: false,
      });
      await __fixture.secrets.put(
        __fixture.tenantId,
        connectorCredentialKey(legacyId),
        __fixture.storedCredential('legacy-role-token'),
        tx,
      );
    });

    const edited = await api.request(`/connectors/argocd/${legacyId}`, {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        name: 'Legacy Argo CD renamed',
        settings: { ...legacySettings, labelSelector: 'team=payments', accessRole: 'sre-platform' },
      }),
    });
    expect(edited.status).toBe(200);
    const [row] = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx
        .select({ name: connectorConfigs.name, settings: connectorConfigs.settings })
        .from(connectorConfigs)
        .where(eq(connectorConfigs.id, legacyId)),
    );
    expect(row?.name).toBe('Legacy Argo CD renamed');
    expect(row?.settings).toMatchObject({ labelSelector: 'team=payments' });
    expect(row?.settings).not.toHaveProperty('accessRole');
  });

  test('preserves an omitted token, rejects a blank replacement, and rotates an explicit token', async () => {
    let probedCa: unknown;
    const connectorRegistry = new ConnectorRegistry();
    registerTestConnector(connectorRegistry, 'argocd', (config) => ({
      ...stubConnector('argocd', config),
      probe: async () => {
        probedCa = config.settings.caCert;
        return {
          status: 'unhealthy' as const,
          reachable: false,
          authorized: false,
          warnings: [],
        };
      },
    }));
    const api = __fixture.connectorApp(connectorRegistry);
    const settings = __fixture.projectSettings();
    expect(
      (
        await api.request('/connectors/argocd', {
          method: 'PUT',
          headers: await __fixture.headers(),
          body: JSON.stringify({
            settings,
            credentials: __fixture.projectCredentials('argocd-token-original'),
          }),
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await api.request('/connectors/argocd', {
          method: 'PUT',
          headers: await __fixture.headers(),
          body: JSON.stringify({ settings: { ...settings, caCert: 'CA PEM' } }),
        })
      ).status,
    ).toBe(200);
    expect(
      await __fixture.secrets.get(
        __fixture.tenantId,
        connectorCredentialKey(await __fixture.activeArgoCdId()),
      ),
    ).toBe(__fixture.storedCredential('argocd-token-original'));
    expect(
      (
        await api.request('/connectors/argocd/test', {
          method: 'POST',
          headers: await __fixture.headers(),
        })
      ).status,
    ).toBe(200);
    expect(probedCa).toBe('CA PEM');
    const listedAfterCa = await api.request('/connectors', { headers: await __fixture.headers() });
    const listedText = await listedAfterCa.text();
    expect(JSON.parse(listedText)).toMatchObject({
      connectors: [{ settings: { caConfigured: true } }],
    });
    expect(listedText).not.toContain('CA PEM');

    const blank = await api.request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        settings,
        credentials: __fixture.projectCredentials('   '),
      }),
    });
    expect(blank.status).toBe(400);
    expect(
      await __fixture.secrets.get(
        __fixture.tenantId,
        connectorCredentialKey(await __fixture.activeArgoCdId()),
      ),
    ).toBe(__fixture.storedCredential('argocd-token-original'));

    const rotated = await api.request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        settings,
        credentials: __fixture.projectCredentials('argocd-token-rotated'),
      }),
    });
    expect(rotated.status).toBe(200);
    expect(
      await __fixture.secrets.get(
        __fixture.tenantId,
        connectorCredentialKey(await __fixture.activeArgoCdId()),
      ),
    ).toBe(__fixture.storedCredential('argocd-token-rotated'));

    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx
        .select({ enabled: connectorConfigs.enabled })
        .from(connectorConfigs)
        .where(eq(connectorConfigs.type, 'argocd')),
    );
    expect(rows).toEqual([{ enabled: false }]);
  });

  test('rejects an ArgoCD request body over 256 KiB before parsing or persistence', async () => {
    const response = await __fixture.connectorApp().request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({ padding: 'x'.repeat(256 * 1024) }),
    });
    expect(response.status).toBe(400);
    expect(
      await __fixture.secrets.get(__fixture.tenantId, connectorCredentialKey('argocd')),
    ).toBeNull();
  });

  test('never reuses a stored token after the normalized ArgoCD base URL changes', async () => {
    let probed: { baseUrl: unknown; credential: string } | undefined;
    const connectorRegistry = new ConnectorRegistry();
    registerTestConnector(connectorRegistry, 'argocd', (config) => ({
      ...stubConnector('argocd', config),
      probe: async () => {
        probed = {
          baseUrl: config.settings.baseUrl,
          credential: await config.getCredential(),
        };
        return {
          status: 'unhealthy' as const,
          reachable: false,
          authorized: false,
          warnings: [],
        };
      },
    }));
    const api = __fixture.connectorApp(connectorRegistry);
    const original = __fixture.projectSettings('https://argocd.internal.example/root');
    expect(
      (
        await api.request('/connectors/argocd', {
          method: 'PUT',
          headers: await __fixture.headers(),
          body: JSON.stringify({
            settings: original,
            credentials: __fixture.projectCredentials('origin-bound-token'),
          }),
        })
      ).status,
    ).toBe(200);

    const rejected = await api.request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        settings: { ...original, baseUrl: 'https://attacker.example/other-root' },
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: expect.stringMatching(/credential.*project payments/),
    });

    expect(
      (
        await api.request('/connectors/argocd/test', {
          method: 'POST',
          headers: await __fixture.headers(),
        })
      ).status,
    ).toBe(200);
    expect(probed).toEqual({
      baseUrl: 'https://argocd.internal.example/root',
      credential: __fixture.storedCredential('origin-bound-token'),
    });
  });

  test('rejects a concurrent ArgoCD verification instead of queueing it', async () => {
    let entered!: () => void;
    let release!: () => void;
    const probeEntered = new Promise<void>((resolve) => (entered = resolve));
    const probeRelease = new Promise<void>((resolve) => (release = resolve));
    const connectorRegistry = new ConnectorRegistry();
    registerTestConnector(connectorRegistry, 'argocd', (config) => ({
      ...stubConnector('argocd', config),
      probe: async () => {
        entered();
        await probeRelease;
        return {
          status: 'healthy' as const,
          reachable: true,
          authorized: true,
          warnings: [],
        };
      },
    }));
    const api = __fixture.connectorApp(connectorRegistry);
    const settings = __fixture.projectSettings();
    expect(
      (
        await api.request('/connectors/argocd', {
          method: 'PUT',
          headers: await __fixture.headers(),
          body: JSON.stringify({
            settings,
            credentials: __fixture.projectCredentials('argocd-token'),
          }),
        })
      ).status,
    ).toBe(200);

    const first = api.request('/connectors/argocd/test', {
      method: 'POST',
      headers: await __fixture.headers(),
    });
    await probeEntered;
    const concurrent = await api.request('/connectors/argocd/test', {
      method: 'POST',
      headers: await __fixture.headers(),
    });
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({ error: expect.stringMatching(/in progress/) });
    const concurrentDelete = await api.request('/connectors/argocd', {
      method: 'DELETE',
      headers: await __fixture.headers(),
    });
    expect(concurrentDelete.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  test('a stale verification cannot overwrite a concurrent edit from another router', async () => {
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
    const original = __fixture.projectSettings('https://argocd-original.internal.example');
    const replacement = {
      ...original,
      baseUrl: 'https://argocd-replacement.internal.example',
    };

    expect(
      (
        await editingApi.request('/connectors/argocd', {
          method: 'PUT',
          headers: await __fixture.headers(),
          body: JSON.stringify({
            settings: original,
            credentials: __fixture.projectCredentials('argocd-token-original'),
            enabled: false,
          }),
        })
      ).status,
    ).toBe(200);

    const staleProbe = probingApi.request('/connectors/argocd/test', {
      method: 'POST',
      headers: await __fixture.headers(),
    });
    await probeEntered;
    const edit = editingApi.request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        settings: replacement,
        credentials: __fixture.projectCredentials('argocd-token-replacement'),
        enabled: false,
      }),
    });
    const editCompletedBeforeRelease = await Promise.race([
      Promise.resolve(edit).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    release();
    const [probeResponse, editResponse] = await Promise.all([staleProbe, edit]);
    const [row] = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx
        .select({ settings: connectorConfigs.settings, enabled: connectorConfigs.enabled })
        .from(connectorConfigs)
        .where(eq(connectorConfigs.type, 'argocd')),
    );

    expect({
      editCompletedBeforeRelease,
      probeStatus: probeResponse.status,
      editStatus: editResponse.status,
      row,
      credential: await __fixture.secrets.get(
        __fixture.tenantId,
        connectorCredentialKey(await __fixture.activeArgoCdId()),
      ),
    }).toEqual({
      editCompletedBeforeRelease: true,
      probeStatus: 409,
      editStatus: 200,
      row: { settings: replacement, enabled: false },
      credential: __fixture.storedCredential('argocd-token-replacement'),
    });
  });
});
