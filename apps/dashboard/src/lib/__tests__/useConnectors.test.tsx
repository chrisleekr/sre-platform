// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useConnectors,
  saveKubernetesConnector,
  fetchKubernetesManifest,
  discoverGitHubInstallations,
  discoverGitHubRepositories,
  disconnectKubernetesConnector,
  disconnectGitHubConnector,
  saveGitHubConnector,
  startGitHubManifest,
  completeGitHubManifest,
  testGitHubConnector,
  testKubernetesConnector,
  disconnectObservabilityConnector,
  disconnectPrometheusConnector,
  disconnectStatusCakeConnector,
  saveObservabilityConnector,
  savePrometheusConnector,
  saveStatusCakeConnector,
  testObservabilityConnector,
  testPrometheusConnector,
  testStatusCakeConnector,
} from '../useConnectors';
import type { ConnectorSummary, KubernetesTestResult } from '../connectors';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};
const SOURCE_ID = '00000000-0000-4000-8000-000000000001';
const connector: ConnectorSummary = {
  id: SOURCE_ID,
  name: 'Primary Kubernetes',
  type: 'kubernetes',
  settings: { apiUrl: 'https://k8s.example', namespace: 'prod' },
  enabled: true,
};

describe('useConnectors', () => {
  test('loads the tenant connectors with the bearer header', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ connectors: [connector] }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    const { result } = renderHook(() => useConnectors(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.connectors).toHaveLength(1);
    expect(result.current.error).toBe(false);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://api/connectors');
    expect(call[1].headers).toMatchObject({ authorization: 'Bearer jwt' });
  });

  test('refetch re-fetches the connectors', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ connectors: [] }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    const { result } = renderHook(() => useConnectors(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    result.current.refetch();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test('flags an error when the request fails', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response);
    const { result } = renderHook(() => useConnectors(opts));
    await waitFor(() => expect(result.current.error).toBe(true));
  });
});

describe('kubernetes connector mutation helpers', () => {
  test('saveKubernetesConnector POSTs a named source with enabled:false and the bearer header', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    await saveKubernetesConnector(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      {
        name: 'Primary Kubernetes',
        settings: { apiUrl: 'https://k8s.example', namespace: 'prod' },
        credential: 'tok-123',
        enabled: false,
      },
    );
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://api/connectors/kubernetes');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers).toMatchObject({ authorization: 'Bearer jwt' });
    const body = JSON.parse(call[1].body as string) as { enabled: boolean; credential: string };
    expect(body.enabled).toBe(false);
    expect(body.credential).toBe('tok-123');
  });

  test('same-cluster edits omit write-only credentials and disconnect uses DELETE', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response,
    );
    globalThis.fetch = fetchMock;

    await saveKubernetesConnector(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      {
        id: SOURCE_ID,
        name: 'Primary Kubernetes',
        settings: { apiUrl: 'https://k8s.example', namespace: 'platform' },
        enabled: false,
      },
    );
    await disconnectKubernetesConnector(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      SOURCE_ID,
    );

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({
      settings: { apiUrl: 'https://k8s.example', namespace: 'platform' },
      name: 'Primary Kubernetes',
      enabled: false,
    });
    expect(calls[0]?.[0]).toBe(`http://api/connectors/kubernetes/${SOURCE_ID}`);
    expect(calls[1]?.[0]).toBe(`http://api/connectors/kubernetes/${SOURCE_ID}`);
    expect(calls[1]?.[1].method).toBe('DELETE');
  });

  test('fetchKubernetesManifest GETs the manifest text with the query params and bearer header', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, text: async () => 'apiVersion: v1' }) as Response,
    );
    globalThis.fetch = fetchMock;
    const yaml = await fetchKubernetesManifest(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      {
        namespace: 'sre-triage',
        serviceAccount: 'sre-triage-reader',
      },
    );
    expect(yaml).toBe('apiVersion: v1');
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(
      'http://api/connectors/kubernetes/manifest?namespace=sre-triage&serviceAccount=sre-triage-reader',
    );
    expect(call[1].headers).toMatchObject({ authorization: 'Bearer jwt' });
  });

  test('testKubernetesConnector POSTs to /connectors/kubernetes/test and returns the result', async () => {
    const probe: KubernetesTestResult = {
      status: 'healthy',
      reachable: true,
      authorized: true,
      checks: { canListPods: true, secretsDenied: true },
      warnings: [],
      enabled: true,
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => probe }) as Response);
    globalThis.fetch = fetchMock;
    const res = await testKubernetesConnector(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      SOURCE_ID,
    );
    expect(res).toEqual(probe);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(`http://api/connectors/kubernetes/${SOURCE_ID}/test`);
    expect(call[1].method).toBe('POST');
    expect(call[1].headers).toMatchObject({ authorization: 'Bearer jwt' });
  });

  test('mutation helpers throw on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, text: async () => '' }) as Response);
    await expect(
      saveKubernetesConnector(
        'http://api',
        async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        {
          name: 'Kubernetes',
          settings: { apiUrl: 'https://k8s', namespace: 'p' },
          credential: 'x',
          enabled: false,
        },
      ),
    ).rejects.toThrow();
    await expect(
      fetchKubernetesManifest(
        'http://api',
        async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        {
          namespace: 'n',
          serviceAccount: 's',
        },
      ),
    ).rejects.toThrow();
    await expect(
      testKubernetesConnector(
        'http://api',
        async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        SOURCE_ID,
      ),
    ).rejects.toThrow();
    await expect(
      disconnectKubernetesConnector(
        'http://api',
        async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        SOURCE_ID,
      ),
    ).rejects.toThrow();
  });
});

describe('on-demand connector mutation helpers', () => {
  test.each([
    {
      type: 'prometheus' as const,
      save: (id?: string) =>
        savePrometheusConnector(
          'http://api',
          async () => ({ kind: 'bearer' as const, token: 'jwt' }),
          {
            ...(id ? { id } : {}),
            name: 'Primary Prometheus',
            settings: { baseUrl: 'https://prometheus.example', authType: 'bearer' },
            credential: 'prom-token',
          },
        ),
      runTest: () =>
        testPrometheusConnector(
          'http://api',
          async () => ({ kind: 'bearer' as const, token: 'jwt' }),
          SOURCE_ID,
        ),
      disconnect: () =>
        disconnectPrometheusConnector(
          'http://api',
          async () => ({ kind: 'bearer' as const, token: 'jwt' }),
          SOURCE_ID,
        ),
    },
    {
      type: 'statuscake' as const,
      save: (id?: string) =>
        saveStatusCakeConnector(
          'http://api',
          async () => ({ kind: 'bearer' as const, token: 'jwt' }),
          {
            ...(id ? { id } : {}),
            name: 'Primary StatusCake',
            credential: 'statuscake-token',
          },
        ),
      runTest: () =>
        testStatusCakeConnector(
          'http://api',
          async () => ({ kind: 'bearer' as const, token: 'jwt' }),
          SOURCE_ID,
        ),
      disconnect: () =>
        disconnectStatusCakeConnector(
          'http://api',
          async () => ({ kind: 'bearer' as const, token: 'jwt' }),
          SOURCE_ID,
        ),
    },
    ...(['datadog', 'grafana'] as const).map((type) => ({
      type,
      save: (id?: string) =>
        saveObservabilityConnector(
          'http://api',
          async () => ({ kind: 'bearer' as const, token: 'jwt' }),
          type,
          {
            ...(id ? { id } : {}),
            name: `Primary ${type}`,
            settings:
              type === 'datadog'
                ? { site: 'datadoghq.com' }
                : { baseUrl: 'https://grafana.example' },
            credential: `${type}-credential`,
          },
        ),
      runTest: () =>
        testObservabilityConnector(
          'http://api',
          async () => ({ kind: 'bearer' as const, token: 'jwt' }),
          type,
          SOURCE_ID,
        ),
      disconnect: () =>
        disconnectObservabilityConnector(
          'http://api',
          async () => ({ kind: 'bearer' as const, token: 'jwt' }),
          type,
          SOURCE_ID,
        ),
    })),
  ])('uses ID-addressed create, edit, test, and delete contracts for $type', async (provider) => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            connectorId: SOURCE_ID,
            status: 'healthy',
            reachable: true,
            authorized: true,
            warnings: [],
            enabled: true,
          }),
        }) as Response,
    );
    globalThis.fetch = fetchMock;

    await provider.save();
    await provider.save(SOURCE_ID);
    await provider.runTest();
    await provider.disconnect();

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      `http://api/connectors/${provider.type}`,
      `http://api/connectors/${provider.type}/${SOURCE_ID}`,
      `http://api/connectors/${provider.type}/${SOURCE_ID}/test`,
      `http://api/connectors/${provider.type}/${SOURCE_ID}`,
    ]);
    expect(calls.map(([, init]) => init.method)).toEqual(['POST', 'PUT', 'POST', 'DELETE']);
    for (const call of calls) {
      expect(call[1].headers).toMatchObject({ authorization: 'Bearer jwt' });
    }
    for (const call of calls.slice(0, 2)) {
      const body = JSON.parse(call[1].body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty('id');
      expect(body.enabled).toBe(false);
    }
  });
});

describe('GitHub connector mutation helpers', () => {
  test('uses the authenticated manifest start and one-time completion contracts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ actionUrl: 'https://github.com/settings/apps/new', state: 'state' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ appId: '901', appSlug: 'sre-platform-acme' }),
      } as Response);
    globalThis.fetch = fetchMock as typeof fetch;
    const start = {
      name: 'Primary GitHub',
      ownerType: 'organization' as const,
      organization: 'acme',
      deliveryMode: 'smee' as const,
      deliveryUrl: 'https://smee.io/channel',
      dashboardUrl: 'http://localhost:45173',
    };

    await startGitHubManifest(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      start,
    );
    await completeGitHubManifest(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      {
        code: 'one-time-code',
        state: 'state',
      },
    );

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      'http://api/connectors/github/manifest/start',
      'http://api/connectors/github/manifest/complete',
    ]);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual(start);
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({
      code: 'one-time-code',
      state: 'state',
    });
    expect(calls.every(([, init]) => JSON.stringify(init.headers).includes('Bearer jwt'))).toBe(
      true,
    );
  });

  test('uses the focused discovery, disabled save, test, and disconnect API contracts', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/installations'))
        return { ok: true, json: async () => ({ installations: [{ id: 101 }] }) } as Response;
      if (input.endsWith('/repositories'))
        return { ok: true, json: async () => ({ repositories: [{ id: 202 }] }) } as Response;
      if (input.endsWith('/test'))
        return {
          ok: true,
          json: async () => ({ status: 'healthy', warnings: [], enabled: true }),
        } as Response;
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await discoverGitHubInstallations(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      {
        appId: 'Iv1.test',
        credential: 'private-key',
      },
    );
    await discoverGitHubRepositories(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      {
        appId: 'Iv1.test',
        installationId: 101,
        credential: 'private-key',
      },
    );
    await saveGitHubConnector(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      {
        name: 'Primary GitHub',
        settings: { appId: 'Iv1.test', installationId: 101 },
      },
    );
    await testGitHubConnector(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      SOURCE_ID,
    );
    await disconnectGitHubConnector(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      SOURCE_ID,
    );

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      'http://api/connectors/github/installations',
      'http://api/connectors/github/repositories',
      'http://api/connectors/github',
      `http://api/connectors/github/${SOURCE_ID}/test`,
      `http://api/connectors/github/${SOURCE_ID}`,
    ]);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({
      settings: { appId: 'Iv1.test' },
      credential: 'private-key',
    });
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({
      settings: { appId: 'Iv1.test', installationId: 101 },
      credential: 'private-key',
    });
    expect(JSON.parse(calls[2]![1].body as string)).toEqual({
      settings: { appId: 'Iv1.test', installationId: 101 },
      name: 'Primary GitHub',
      enabled: false,
    });
    expect(calls[3]![1].method).toBe('POST');
    expect(calls[4]![1].method).toBe('DELETE');
    expect(calls.every(([, init]) => JSON.stringify(init.headers).includes('Bearer jwt'))).toBe(
      true,
    );
  });

  test('preserves the API-safe GitHub installation discovery reason', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error:
              'GitHub rejected this client/App ID and private key. Confirm the key was generated by the same GitHub App.',
            code: 'credentials_rejected',
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;

    await expect(
      discoverGitHubInstallations(
        'http://api',
        async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        {
          appId: 'Iv1.test',
          credential: 'write-only-private-key',
        },
      ),
    ).rejects.toThrow(
      'GitHub rejected this client/App ID and private key. Confirm the key was generated by the same GitHub App.',
    );
  });
});
