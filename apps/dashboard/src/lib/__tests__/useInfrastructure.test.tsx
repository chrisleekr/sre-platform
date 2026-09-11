// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useInfrastructure } from '../useInfrastructure';
import type { InfraSnapshot } from '../types';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};

const snapshots: InfraSnapshot[] = [
  {
    dataSourceId: '00000000-0000-4000-8000-000000000001',
    dataSourceName: 'Primary AWS',
    source: 'aws',
    entityId: 'checkout-svc',
    metrics: { cpu: 0.42 },
    observedAt: new Date().toISOString(),
  },
  {
    dataSourceId: '00000000-0000-4000-8000-000000000001',
    dataSourceName: 'Primary AWS',
    source: 'aws',
    entityId: 'orders-db',
    metrics: { connections: 87 },
    observedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    dataSourceId: '00000000-0000-4000-8000-000000000002',
    dataSourceName: 'Primary Kubernetes',
    source: 'kubernetes',
    entityId: 'cart-pod',
    metrics: {},
    observedAt: new Date().toISOString(),
    error: 'scrape failed',
  },
];

describe('useInfrastructure', () => {
  test('loads the tenant infrastructure snapshots', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ infrastructure: snapshots }) }) as Response,
    );
    const { result } = renderHook(() => useInfrastructure(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshots).toHaveLength(3);
    expect(result.current.error).toBe(false);
  });

  test('flags an error when the request fails', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
    );
    const { result } = renderHook(() => useInfrastructure(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.errorStatus).toBe(500);
  });

  test('retains the last-good snapshots and reports a failed background refresh', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1)
        return { ok: true, json: async () => ({ infrastructure: snapshots }) } as Response;
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    });

    const { result, unmount } = renderHook(() => useInfrastructure({ ...opts, pollMs: 20 }));
    await waitFor(() => expect(result.current.snapshots).toHaveLength(3));
    await waitFor(() => expect(result.current.backgroundError).toBe(true));

    expect(result.current.snapshots).toHaveLength(3);
    expect(result.current.errorStatus).toBe(503);
    unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test('re-polls infrastructure on the configured interval', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ infrastructure: snapshots }) }) as Response,
    );
    globalThis.fetch = fetchMock;

    const { unmount } = renderHook(() => useInfrastructure({ ...opts, pollMs: 20 }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
