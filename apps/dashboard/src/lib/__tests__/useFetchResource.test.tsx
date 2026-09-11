// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useFetchResource } from '../useFetchResource';
import { clearSessionFailure, getSessionFailure } from '../../session-failure';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  clearSessionFailure();
  vi.restoreAllMocks();
});

// A fetch whose responses resolve only when we call resolveNext(), so we can inspect the renders BETWEEN a
// path change and the next fetch settling — the stale window the race lived in.
function deferredFetch() {
  const resolvers: Array<(body: unknown) => void> = [];
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        resolvers.push((body: unknown) =>
          resolve({ ok: true, json: async () => body } as Response),
        );
      }),
  );
  return { fetchMock, resolveNext: (body: unknown) => resolvers.shift()!(body) };
}

const selectPage = (b: unknown): number => (b as { page: number }).page;

describe('useFetchResource path-change loading gate (race)', () => {
  test('every render still showing the STALE page after a path change is gated as loading; then it advances', async () => {
    const { fetchMock, resolveNext } = deferredFetch();
    globalThis.fetch = fetchMock;

    // Record the (loading, data) each render returns, so we can inspect the stale window directly.
    const seen: { loading: boolean; data: number }[] = [];
    const base = {
      apiBaseUrl: 'http://api',
      getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      initial: 0,
      select: selectPage,
    };
    const { result, rerender } = renderHook(
      (p: string) => {
        const r = useFetchResource<number>({ ...base, path: p });
        seen.push({ loading: r.loading, data: r.data });
        return r;
      },
      { initialProps: '/x?cursor=1' },
    );

    // Initial load settles → page 1.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveNext({ page: 1 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe(1);

    // Change the path (a new cursor). The load effect fires post-commit, so there is a render where `data`
    // is STILL page 1 while the new fetch is in flight. That render MUST read loading=true so a per-page
    // consumer (IncidentsPanel's append effect) skips it. Without the gate, the pre-effect render shows
    // loading=false with stale data — the bug this locks.
    seen.length = 0;
    rerender('/x?cursor=2');
    const staleRenders = seen.filter((s) => s.data === 1);
    expect(staleRenders.length).toBeGreaterThan(0);
    expect(staleRenders.every((s) => s.loading === true)).toBe(true);

    // New fetch settles → data advances to page 2, loading clears.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveNext({ page: 2 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe(2);
  });
});

describe('useFetchResource failed response status', () => {
  test('exposes an HTTP failure status without changing the existing error contract (C4)', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403 }) as Response);

    const { result } = renderHook(() =>
      useFetchResource<number>({
        apiBaseUrl: 'http://api',
        getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        path: '/platform-settings',
        initial: 0,
        select: selectPage,
      }),
    );

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.errorStatus).toBe(403);
    expect(result.current.data).toBe(0);
  });

  test('keeps a network failure distinct from an HTTP response (C4)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    });

    const { result } = renderHook(() =>
      useFetchResource<number>({
        apiBaseUrl: 'http://api',
        getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        path: '/platform-settings',
        initial: 0,
        select: selectPage,
      }),
    );

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.errorStatus).toBeNull();
  });

  test('moves an API-rejected session into recovery', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401 }) as Response);

    const { result } = renderHook(() =>
      useFetchResource<number>({
        apiBaseUrl: 'http://api',
        getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        path: '/incidents',
        initial: 0,
        select: selectPage,
      }),
    );

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.errorStatus).toBe(401);
    expect(getSessionFailure()).toBe('unauthorized');
  });

  test('moves a token acquisition failure into recovery without issuing a request', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() =>
      useFetchResource<number>({
        apiBaseUrl: 'http://api',
        getCredentials: async () => {
          throw { error: 'missing_refresh_token' };
        },
        path: '/incidents',
        initial: 0,
        select: selectPage,
      }),
    );

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSessionFailure()).toBe('token-unavailable');
  });

  test('keeps a transient token failure local and retryable', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() =>
      useFetchResource<number>({
        apiBaseUrl: 'http://api',
        getCredentials: async () => {
          throw { error: 'timeout' };
        },
        path: '/incidents',
        initial: 0,
        select: selectPage,
      }),
    );

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSessionFailure()).toBeNull();
  });
});

describe('useFetchResource polling serialization', () => {
  test('skips poll ticks while the prior request is in flight and cannot apply responses out of order', async () => {
    const { fetchMock, resolveNext } = deferredFetch();
    globalThis.fetch = fetchMock;
    const getCredentials = async () => ({ kind: 'bearer' as const, token: 'jwt' });
    const { result, unmount } = renderHook(() =>
      useFetchResource<number>({
        apiBaseUrl: 'http://api',
        getCredentials,
        path: '/incidents?state=open',
        initial: 0,
        select: selectPage,
        pollMs: 10,
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveNext({ page: 1 });
    await waitFor(() => expect(result.current.data).toBe(1));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveNext({ page: 2 });
    await waitFor(() => expect(result.current.data).toBe(2));
    unmount();
  });
});
