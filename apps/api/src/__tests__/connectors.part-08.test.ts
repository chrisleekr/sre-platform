import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import { connectorConfigs, connectorCredentialKey, withTenant } from '@sre/db';

import { createFixture } from './connectors.fixture';

const __fixture = createFixture();

describe('ArgoCD access instructions route', () => {
  test('rejects malformed URL, scope, and credential types without storing state', async () => {
    const route = __fixture.makeConnApp();
    const bodies = [
      {
        settings: {
          account: 'sre-platform',
          baseUrl: 'http://argocd.example.com',
          applicationsInAnyNamespace: false,
          applications: [{ project: 'default', name: '*' }],
        },
        credential: 'token',
      },
      {
        settings: {
          account: 'sre-platform',
          baseUrl: 'https://argocd.example.com',
          applicationsInAnyNamespace: true,
          applications: [{ project: 'default', namespace: '../bad', name: '*' }],
        },
        credential: 'token',
      },
      {
        settings: {
          account: 'sre-platform',
          baseUrl: 'https://argocd.example.com',
          applicationsInAnyNamespace: false,
          applications: [{ project: 'default', name: '*' }],
        },
        credential: 7,
      },
    ];
    for (const body of bodies) {
      const response = await route.request('/connectors/argocd', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(
      await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey('argocd')),
    ).toBeNull();
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx.select().from(connectorConfigs).where(eq(connectorConfigs.type, 'argocd')),
      ),
    ).toEqual([]);
  });

  test('stores one write-only token per project and retains only selected project tokens on edit', async () => {
    const route = __fixture.makeConnApp();
    const settings = {
      baseUrl: 'https://argocd.example.com',
      accessRole: 'sre-platform-a1b2c3d4',
      applicationsInAnyNamespace: false,
      projects: [
        { project: 'payments', applications: [{ name: 'checkout' }] },
        { project: 'identity', applications: [{ name: 'login' }] },
      ],
    };
    try {
      const saved = await route.request('/connectors/argocd', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings,
          credentials: [
            { project: 'payments', token: 'payments-token' },
            { project: 'identity', token: 'identity-token' },
          ],
        }),
      });
      expect(saved.status).toBe(200);

      const listed = await route.request('/connectors', {
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      const payload = (await listed.json()) as {
        connectors: Array<{ type: string; settings: Record<string, unknown> }>;
      };
      const text = JSON.stringify(payload);
      expect(text).not.toContain('payments-token');
      expect(text).not.toContain('identity-token');
      expect(
        payload.connectors.find((connector) => connector.type === 'argocd')?.settings,
      ).toMatchObject({
        projects: [
          { project: 'payments', credentialConfigured: true },
          { project: 'identity', credentialConfigured: true },
        ],
      });

      const edited = await route.request('/connectors/argocd', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: { ...settings, projects: [settings.projects[1]] },
          credentials: [],
        }),
      });
      expect(edited.status).toBe(200);
      expect(JSON.parse((await __fixture.activeCredential('argocd')) ?? '')).toEqual({
        version: 1,
        tokens: [{ project: 'identity', token: 'identity-token' }],
      });
    } finally {
      await route.request('/connectors/argocd', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });

  test('requires a replacement token for every project when the Argo CD server changes', async () => {
    const route = __fixture.makeConnApp();
    const projects = [{ project: 'payments', applications: [{ name: '*' }] }];
    try {
      expect(
        (
          await route.request('/connectors/argocd', {
            method: 'PUT',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
            body: JSON.stringify({
              settings: {
                baseUrl: 'https://argocd.example.com',
                accessRole: 'sre-platform-a1b2c3d4',
                applicationsInAnyNamespace: false,
                projects,
              },
              credentials: [{ project: 'payments', token: 'old-token' }],
            }),
          })
        ).status,
      ).toBe(200);
      const changed = await route.request('/connectors/argocd', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: {
            baseUrl: 'https://argocd-new.example.com',
            applicationsInAnyNamespace: false,
            projects,
          },
          credentials: [],
        }),
      });
      expect(changed.status).toBe(400);
      expect(await changed.json()).toEqual({
        error: 'credential is required for ArgoCD project payments',
      });
    } finally {
      await route.request('/connectors/argocd', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });

  test('returns a dedicated AppProject role without editing global RBAC', async () => {
    const response = await __fixture.makeConnApp().request('/connectors/argocd/access', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        project: 'payments',
        role: 'sre-platform-a1b2c3d4',
        applicationsInAnyNamespace: true,
        applications: [{ namespace: 'team-a', name: 'checkout' }],
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      instructions: {
        project: 'payments',
        role: 'sre-platform-a1b2c3d4',
        identity: 'proj:payments:sre-platform-a1b2c3d4',
        policies: expect.arrayContaining([
          'p, proj:payments:sre-platform-a1b2c3d4, applications, get, payments/team-a/checkout, allow',
        ]),
      },
    });
    expect(text).not.toContain('accounts.');
    expect(text).not.toContain('argocd-rbac-cm');
  });
});

describe('kubernetes RBAC manifest route', () => {
  test('returns the RBAC YAML binding view and never granting secret reads', async () => {
    const res = await __fixture.api.request('/connectors/kubernetes/manifest', {
      headers: { authorization: `Bearer ${await __fixture.sign(__fixture.orgA, ['admin'])}` },
    });
    expect(res.status).toBe(200);
    const yaml = await res.text();
    // Default params interpolated.
    expect(yaml).toContain('name: sre-triage-reader');
    expect(yaml).toContain('namespace: sre-triage');
    // The built-in `view` ClusterRole is bound (broad reads, excludes secrets).
    expect(yaml).toContain('name: view');
    // `secrets` is never granted as a readable resource in any rule (resources are lowercase plural;
    // the token object is `kind: Secret`, singular).
    expect(yaml).not.toContain('secrets');
  });

  test('honours namespace/serviceAccount query params', async () => {
    const res = await __fixture.api.request(
      '/connectors/kubernetes/manifest?namespace=obs&serviceAccount=triage-bot',
      { headers: { authorization: `Bearer ${await __fixture.sign(__fixture.orgA, ['admin'])}` } },
    );
    expect(res.status).toBe(200);
    const yaml = await res.text();
    expect(yaml).toContain('namespace: obs');
    expect(yaml).toContain('name: triage-bot');
  });

  test('rejects an injecting namespace without leaking the raw input (400)', async () => {
    const res = await __fixture.api.request(
      `/connectors/kubernetes/manifest?namespace=${encodeURIComponent('../x')}`,
      { headers: { authorization: `Bearer ${await __fixture.sign(__fixture.orgA, ['admin'])}` } },
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('../x');
  });

  test('rejects a non-kubernetes type (400)', async () => {
    const res = await __fixture.api.request('/connectors/datadog/manifest', {
      headers: { authorization: `Bearer ${await __fixture.sign(__fixture.orgA, ['admin'])}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('kubernetes connector lifecycle', () => {
  test('keeps the CA write-only and preserves stored secrets during same-cluster edits', async () => {
    const route = __fixture.makeConnApp();
    const settings = {
      accessId: 'b1c2d3e4',
      apiUrl: 'https://k8s.lifecycle.example.com:6443',
      namespace: 'prod',
      caCert: '-----BEGIN CERTIFICATE-----\nprivate-ca\n-----END CERTIFICATE-----',
    };
    try {
      const save = await route.request('/connectors/kubernetes', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings, credential: 'stored-service-account-token' }),
      });
      expect(save.status).toBe(200);

      const listed = await route.request('/connectors', {
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      const kubernetes = (
        (await listed.json()) as {
          connectors: Array<{ type: string; settings: Record<string, unknown> }>;
        }
      ).connectors.find((connector) => connector.type === 'kubernetes');
      expect(kubernetes?.settings).toMatchObject({
        apiUrl: settings.apiUrl,
        namespace: 'prod',
        caConfigured: true,
      });
      expect(kubernetes?.settings).not.toHaveProperty('caCert');
      expect(JSON.stringify(kubernetes)).not.toContain('private-ca');

      const edit = await route.request('/connectors/kubernetes', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: { apiUrl: settings.apiUrl, namespace: 'platform' },
          enabled: false,
        }),
      });
      expect(edit.status).toBe(200);
      const rows = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .select({ settings: connectorConfigs.settings })
          .from(connectorConfigs)
          .where(and(eq(connectorConfigs.type, 'kubernetes'), isNull(connectorConfigs.deletedAt))),
      );
      expect(rows[0]?.settings).toEqual({ ...settings, namespace: 'platform' });
      expect(await __fixture.activeCredential('kubernetes')).toBe('stored-service-account-token');

      const changedServer = await route.request('/connectors/kubernetes', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: { apiUrl: 'https://new-k8s.example.com:6443', namespace: 'platform' },
          enabled: false,
        }),
      });
      expect(changedServer.status).toBe(400);
      expect(await changedServer.json()).toEqual({
        error: 'a new credential is required when the Kubernetes API URL changes',
      });
    } finally {
      await route.request('/connectors/kubernetes', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });

  test('requires distinct immutable access IDs for new Kubernetes data sources', async () => {
    const route = __fixture.makeConnApp();
    const created: string[] = [];
    try {
      const missing = await route.request('/connectors/kubernetes', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          name: 'Missing access ID',
          settings: { apiUrl: 'https://missing-id.k8s.example.com:6443', namespace: '' },
          credential: 'missing-id-token',
        }),
      });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({
        error: 'new Kubernetes data sources require a unique access ID',
      });

      const create = async (name: string, accessId: string) => {
        const response = await route.request('/connectors/kubernetes', {
          method: 'POST',
          headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
          body: JSON.stringify({
            name,
            settings: {
              accessId,
              apiUrl: `https://${accessId}.k8s.example.com:6443`,
              namespace: '',
            },
            credential: `${accessId}-token`,
            enabled: false,
          }),
        });
        return response;
      };

      const first = await create('Primary Kubernetes', 'c1d2e3f4');
      expect(first.status).toBe(200);
      const firstId = ((await first.json()) as { connectorId: string }).connectorId;
      created.push(firstId);

      const duplicate = await create('Duplicate Kubernetes', 'c1d2e3f4');
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({
        error: 'this Kubernetes access ID is already used by another source',
      });

      const changed = await route.request(`/connectors/kubernetes/${firstId}`, {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          name: 'Primary Kubernetes',
          settings: {
            accessId: 'd2e3f4a5',
            apiUrl: 'https://c1d2e3f4.k8s.example.com:6443',
            namespace: '',
          },
        }),
      });
      expect(changed.status).toBe(400);
      expect(await changed.json()).toEqual({
        error: 'the Kubernetes access ID cannot be changed; reconnect the data source instead',
      });

      const second = await create('Secondary Kubernetes', 'd2e3f4a5');
      expect(second.status).toBe(200);
      created.push(((await second.json()) as { connectorId: string }).connectorId);
    } finally {
      for (const id of created)
        await route.request(`/connectors/kubernetes/${id}`, {
          method: 'DELETE',
          headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        });
    }
  });

  test('keeps a legacy Kubernetes identity editable without assigning a new access ID', async () => {
    const route = __fixture.makeConnApp();
    const legacyId = randomUUID();
    await withTenant(__fixture.app.db, __fixture.tenantA, async (tx) => {
      await tx.insert(connectorConfigs).values({
        id: legacyId,
        tenantId: __fixture.tenantA,
        name: 'Legacy Kubernetes',
        type: 'kubernetes',
        settings: { apiUrl: 'https://legacy.k8s.example.com:6443', namespace: 'old' },
        enabled: false,
      });
      await __fixture.secrets.put(
        __fixture.tenantA,
        connectorCredentialKey(legacyId),
        'legacy-kubernetes-token',
        tx,
      );
    });
    try {
      const edited = await route.request(`/connectors/kubernetes/${legacyId}`, {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          name: 'Legacy Kubernetes renamed',
          settings: { apiUrl: 'https://legacy.k8s.example.com:6443', namespace: 'platform' },
          enabled: false,
        }),
      });
      expect(edited.status).toBe(200);
      const [row] = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .select({ name: connectorConfigs.name, settings: connectorConfigs.settings })
          .from(connectorConfigs)
          .where(eq(connectorConfigs.id, legacyId)),
      );
      expect(row).toEqual({
        name: 'Legacy Kubernetes renamed',
        settings: { apiUrl: 'https://legacy.k8s.example.com:6443', namespace: 'platform' },
      });
    } finally {
      await route.request(`/connectors/kubernetes/${legacyId}`, {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });
});
