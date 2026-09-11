// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDeployments } from '../useDeployments';
import type { Deployment } from '../types';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};

const deployments: Deployment[] = [
  {
    dataSourceName: 'Primary GitHub',
    source: 'github',
    repo: 'acme/checkout',
    ref: 'main',
    sha: 'a1b2c3d',
    status: 'success',
    transientEnvironment: false,
    deployedAt: new Date().toISOString(),
    url: 'https://github.com/acme/checkout/actions/runs/1',
  },
  {
    dataSourceName: 'Primary GitLab',
    source: 'gitlab',
    repo: 'acme/orders',
    ref: 'release',
    sha: 'e4f5a6b',
    status: 'failed',
    transientEnvironment: false,
    deployedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    dataSourceName: 'Primary GitHub',
    source: 'github',
    repo: 'acme/cart',
    ref: 'feature/x',
    sha: '0c1d2e3',
    status: 'running',
    transientEnvironment: false,
    deployedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  },
];

describe('useDeployments', () => {
  test('loads the tenant deployments', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ deployments }) }) as Response,
    );
    const { result } = renderHook(() => useDeployments(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deployments).toHaveLength(3);
    expect(result.current.error).toBe(false);
  });

  test('sends evidence filters and returns the server-wide summary', async () => {
    const summary = {
      total: 42,
      failed: 2,
      active: 3,
      environmentMissing: 10,
      latestAt: '2026-08-23T01:02:03Z',
    };
    globalThis.fetch = vi.fn(async () =>
      Response.json({ deployments: deployments.slice(0, 1), nextCursor: 'NEXT', summary }),
    );
    const { result } = renderHook(() =>
      useDeployments({
        ...opts,
        limit: 20,
        filters: {
          from: '2026-08-22T01:02:03Z',
          search: 'checkout',
          source: 'argocd',
          status: 'failed',
        },
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.summary).toEqual(summary);
    expect(result.current.nextCursor).toBe('NEXT');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://api/deployments?limit=20&from=2026-08-22T01%3A02%3A03Z&search=checkout&source=argocd&status=failed',
      { credentials: 'include', headers: { authorization: 'Bearer jwt', 'x-sre-session': '1' } },
    );
  });

  test('flags an error when the request fails', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response);
    const { result } = renderHook(() => useDeployments(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(true);
  });

  // characterization: refetch() bumps the nonce and re-fires the load, mirroring useSurfaces' refetch
  // (useSurfaces.test.tsx:48). This is what lets a failed "Load older" be retried: on failure the panel's
  // cursor is unchanged, so setCursor bails via Object.is and no fetch starts; the panel must call refetch
  // instead. RED today: useDeployments exposes no refetch, so result.current.refetch is undefined.
  test('refetch re-fetches the deployments', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ deployments: [] }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    const { result } = renderHook(() => useDeployments(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    result.current.refetch();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
