// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useIncidents } from '../useIncidents';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};
const incident = {
  id: '1',
  service: 'checkout',
  severity: 'sev2',
  status: 'open',
  alertSource: 'datadog',
  rcaSummary: null,
  confidence: null,
  createdAt: 't',
};

describe('useIncidents', () => {
  test('loads the tenant incidents', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ incidents: [incident] }) }) as Response,
    );
    const { result } = renderHook(() => useIncidents(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.incidents).toHaveLength(1);
    expect(result.current.error).toBe(false);
  });

  test('flags an error when the request fails', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response);
    const { result } = renderHook(() => useIncidents(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(true);
  });

  test('C17 polls the mounted Open scope and exposes a newly created incident within the configured interval', async () => {
    const nextIncident = { ...incident, id: '2', service: 'payments' };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return {
        ok: true,
        json: async () => ({ incidents: call === 1 ? [incident] : [incident, nextIncident] }),
      } as Response;
    });
    globalThis.fetch = fetchMock;
    const pollingOpts = {
      ...opts,
      state: 'open' as const,
      pollMs: 20,
    } as Parameters<typeof useIncidents>[0] & { pollMs: number };
    const { result, unmount } = renderHook(() => useIncidents(pollingOpts));

    await waitFor(() => expect(result.current.incidents).toHaveLength(2));
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test('includes the requested sort in the request path', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request) =>
        ({ ok: true, json: async () => ({ incidents: [incident] }) }) as Response,
    );
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useIncidents({ ...opts, state: 'closed', sort: 'oldest' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/incidents?state=closed&sort=oldest');
  });

  test('includes incident search and severity filters in the request path', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request) =>
        ({ ok: true, json: async () => ({ incidents: [incident] }) }) as Response,
    );
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() =>
      useIncidents({
        ...opts,
        state: 'all',
        query: 'checkout api',
        severity: 'sev2',
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/incidents?state=all&query=checkout+api&severity=sev2',
    );
  });

  test('C17 retains the last-good Open rows when a background poll fails', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, json: async () => ({ incidents: [incident] }) } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
    const pollingOpts = {
      ...opts,
      state: 'open' as const,
      pollMs: 20,
    } as Parameters<typeof useIncidents>[0] & { pollMs: number };
    const { result, unmount } = renderHook(() => useIncidents(pollingOpts));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.incidents).toEqual([incident]);
    expect(result.current.backgroundError).toBe(true);
    unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test('C17 keeps the Closed archive one-shot even when a poll interval is supplied', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ incidents: [incident] }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    const closedOpts = {
      ...opts,
      state: 'closed' as const,
      pollMs: 20,
    } as Parameters<typeof useIncidents>[0] & { pollMs: number };
    const { result, unmount } = renderHook(() => useIncidents(closedOpts));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('a failed Open-to-Closed scope switch is foreground even when prior counts exist', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('state=open')) {
        return {
          ok: true,
          json: async () => ({ incidents: [incident], counts: { open: 1, closed: 1 } }),
        } as Response;
      }
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const { result, rerender, unmount } = renderHook(
      ({ state }: { state: 'open' | 'closed' }) => useIncidents({ ...opts, state, pollMs: 30_000 }),
      { initialProps: { state: 'open' as 'open' | 'closed' } },
    );
    await waitFor(() => expect(result.current.counts).toEqual({ open: 1, closed: 1 }));

    rerender({ state: 'closed' });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.backgroundError).toBe(false);
    unmount();
  });

  test('a failed Closed pagination request is foreground after page one succeeded', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes('cursor=')) {
        return {
          ok: true,
          json: async () => ({
            incidents: [{ ...incident, status: 'resolved' }],
            counts: { open: 0, closed: 2 },
            nextCursor: 'CUR2',
          }),
        } as Response;
      }
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const { result, rerender, unmount } = renderHook(
      ({ cursor }: { cursor?: string }) => useIncidents({ ...opts, state: 'closed', cursor }),
      { initialProps: { cursor: undefined as string | undefined } },
    );
    await waitFor(() => expect(result.current.nextCursor).toBe('CUR2'));

    rerender({ cursor: 'CUR2' });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.backgroundError).toBe(false);
    unmount();
  });
});
