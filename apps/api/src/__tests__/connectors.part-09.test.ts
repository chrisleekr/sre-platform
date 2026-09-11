import { describe, expect, test, vi } from 'vitest';

import { eq } from 'drizzle-orm';

import { connectorConfigs, withTenant } from '@sre/db';

import { createFixture } from './connectors.fixture';

const __fixture = createFixture();

describe('kubernetes test-connection route', () => {
  test('reachable + pods-listable + secrets-denied flips enabled true', async () => {
    await __fixture.saveK8s(__fixture.orgA, {
      settings: __fixture.K8S_SETTINGS,
      credential: 'sa-token',
    });
    const res = await __fixture
      .makeConnApp(__fixture.fakeApiserver({ api: 200, pods: 200, secrets: 403 }))
      .request('/connectors/kubernetes/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
      });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      reachable: boolean;
      authorized: boolean;
      checks?: { canListPods: boolean; secretsDenied: boolean };
      warnings: string[];
      enabled: boolean;
    };
    expect(body).toMatchObject({
      status: 'healthy',
      reachable: true,
      authorized: true,
      enabled: true,
      checks: { canListPods: true, secretsDenied: true },
    });
    expect(body.warnings).toHaveLength(0);
    expect(await __fixture.k8sEnabled(__fixture.orgA)).toBe(true);
  });

  test('pods 403 leaves enabled false and warns to apply RBAC', async () => {
    await __fixture.saveK8s(__fixture.orgA, {
      settings: __fixture.K8S_SETTINGS,
      credential: 'sa-token',
    });
    const res = await __fixture
      .makeConnApp(__fixture.fakeApiserver({ api: 200, pods: 403, secrets: 403 }))
      .request('/connectors/kubernetes/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
      });
    const body = (await res.json()) as {
      status: string;
      checks?: { canListPods: boolean };
      enabled: boolean;
      warnings: string[];
    };
    expect(body).toMatchObject({
      status: 'unhealthy',
      enabled: false,
      checks: { canListPods: false },
    });
    expect(body.warnings.join(' ')).toContain('pod read');
    expect(await __fixture.k8sEnabled(__fixture.orgA)).toBe(false);
  });

  test('a re-test that now fails flips a previously-enabled connector back to disabled', async () => {
    await __fixture.saveK8s(__fixture.orgA, {
      settings: __fixture.K8S_SETTINGS,
      credential: 'sa-token',
    });
    // First probe passes and enables the connector.
    await __fixture
      .makeConnApp(__fixture.fakeApiserver({ api: 200, pods: 200, secrets: 403 }))
      .request('/connectors/kubernetes/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
      });
    expect(await __fixture.k8sEnabled(__fixture.orgA)).toBe(true);
    // A later probe fails (pods 403); the persisted row must flip back to disabled, not stay enabled.
    const res = await __fixture
      .makeConnApp(__fixture.fakeApiserver({ api: 200, pods: 403, secrets: 403 }))
      .request('/connectors/kubernetes/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
      });
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
    expect(await __fixture.k8sEnabled(__fixture.orgA)).toBe(false);
  });

  test('readable secrets warns and clears secretsDenied but still enables when pods list', async () => {
    await __fixture.saveK8s(__fixture.orgA, {
      settings: __fixture.K8S_SETTINGS,
      credential: 'sa-token',
    });
    const res = await __fixture
      .makeConnApp(__fixture.fakeApiserver({ api: 200, pods: 200, secrets: 200 }))
      .request('/connectors/kubernetes/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
      });
    const body = (await res.json()) as {
      status: string;
      checks?: { secretsDenied: boolean };
      enabled: boolean;
      warnings: string[];
    };
    expect(body).toMatchObject({
      status: 'healthy',
      enabled: true,
      checks: { secretsDenied: false },
    });
    expect(body.warnings.join(' ')).toContain('secret');
    expect(await __fixture.k8sEnabled(__fixture.orgA)).toBe(true);
  });

  test('an unreachable api server reports reachable false and does not enable', async () => {
    await __fixture.saveK8s(__fixture.orgA, {
      settings: __fixture.K8S_SETTINGS,
      credential: 'sa-token',
    });
    const res = await __fixture
      .makeConnApp(__fixture.fakeApiserver('throw'))
      .request('/connectors/kubernetes/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
      });
    const body = (await res.json()) as { status: string; reachable: boolean; enabled: boolean };
    expect(body).toMatchObject({ status: 'unhealthy', reachable: false, enabled: false });
    expect(await __fixture.k8sEnabled(__fixture.orgA)).toBe(false);
  });

  test('tenant B cannot test or flip tenant A: its own row is absent (400)', async () => {
    await __fixture.saveK8s(__fixture.orgA, {
      settings: __fixture.K8S_SETTINGS,
      credential: 'sa-token',
    });
    // orgB has no kubernetes connector; RLS scopes the read to B's own (empty) row.
    const res = await __fixture
      .makeConnApp(__fixture.fakeApiserver({ api: 200, pods: 200, secrets: 403 }))
      .request('/connectors/kubernetes/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgB, ['admin'])),
      });
    expect(res.status).toBe(400);
    // A's connector is untouched by B's attempt.
    expect(await __fixture.k8sEnabled(__fixture.orgA)).toBe(false);
  });

  test('rejects a new config without a service account token', async () => {
    const res = await __fixture.api.request('/connectors/kubernetes', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgB, ['admin'])),
      body: JSON.stringify({ settings: __fixture.K8S_SETTINGS, enabled: false }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'credential is required' });
    expect(await __fixture.k8sEnabled(__fixture.orgB)).toBeUndefined();
  });

  test('rejects an unknown connector type (400)', async () => {
    const res = await __fixture.makeConnApp().request('/connectors/bogus/test', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
    });
    expect(res.status).toBe(400);
  });

  test('rejects an incomplete connector type before saving it', async () => {
    const put = await __fixture.api.request('/connectors/confluence', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
      body: JSON.stringify({ settings: {}, credential: 'x' }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: 'connector type is not available' });
  });

  test('does not persist the built-in network probe as a tenant data source', async () => {
    const response = await __fixture.api.request('/connectors/networkprobe', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({ name: 'Network probe', settings: {} }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'built-in connector types are not tenant-configurable',
    });
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx.select().from(connectorConfigs).where(eq(connectorConfigs.type, 'networkprobe')),
      ),
    ).toEqual([]);
  });

  test('POST /:type/test flips enabled on a healthy kubernetes probe', async () => {
    await __fixture.saveK8s(__fixture.orgA, {
      settings: __fixture.K8S_SETTINGS,
      credential: 'sa-token',
    });
    const connector = await __fixture.activeConnector('kubernetes');
    const deleteSnapshot = vi.fn(async () => {});
    const res = await __fixture
      .makeConnApp(
        __fixture.fakeApiserver({ api: 200, pods: 200, secrets: 403 }),
        undefined,
        __fixture.secrets,
        { cache: { get: async () => [], set: async () => {}, delete: deleteSnapshot } },
      )
      .request(`/connectors/kubernetes/${connector.id}/test`, {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
      });
    const body = (await res.json()) as { status: string; enabled: boolean };
    expect(body.status).toBe('healthy');
    expect(body.enabled).toBe(true);
    expect(deleteSnapshot).toHaveBeenCalledWith(__fixture.tenantA, 'kubernetes', {
      id: connector.id,
      lifecycleVersion: connector.lifecycleVersion,
    });
  });

  test('POST /:type/test returns not_applicable and does not change enabled for a stub connector', async () => {
    await __fixture.saveDatadog(__fixture.orgA);
    const res = await __fixture.makeConnApp().request('/connectors/datadog/test', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA, ['admin'])),
    });
    const body = (await res.json()) as { status: string; enabled?: boolean };
    expect(body.status).toBe('not_applicable');
    expect(body.enabled).toBeUndefined();
    // Ready outbound sources remain disabled until a real connector verifies them.
    expect(await __fixture.connectorEnabled(__fixture.orgA, 'datadog')).toBe(false);
  });

  test('a first-class Datadog source cannot be saved without both credentials', async () => {
    const put = await __fixture.api.request('/connectors/datadog', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgB, ['admin'])),
      body: JSON.stringify({ settings: { site: 'datadoghq.com' } }),
    });
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: 'credential is required' });
  });
});
