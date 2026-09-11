// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useIncidentDetail } from '../useIncidentDetail';

const originalFetch = globalThis.fetch;
const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};
const incident = {
  id: '11111111-1111-4111-8111-111111111111',
  service: 'checkout',
  severity: 'sev2',
  status: 'mitigated',
  investigationStatus: 'gathering',
  lifecycleVersion: 1,
  alertSource: 'datadog',
  title: 'Checkout latency',
  rcaSummary: null,
  confidence: null,
  createdAt: '2026-08-18T01:00:00.000Z',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useIncidentDetail', () => {
  test('loads the authenticated public incident summary', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, status: 200, json: async () => incident }) as Response,
    );

    const { result, unmount } = renderHook(() => useIncidentDetail(incident.id, opts));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(globalThis.fetch).toHaveBeenCalledWith(`http://api/incidents/${incident.id}`, {
      headers: { authorization: 'Bearer jwt', 'x-sre-session': '1' },
      credentials: 'include',
    });
    expect(result.current.incident).toEqual(incident);
    expect(result.current.error).toBeNull();
    unmount();
  });

  test('settles a 404 as not found rather than leaving the route loading', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response,
    );

    const { result, unmount } = renderHook(() => useIncidentDetail(incident.id, opts));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.incident).toBeNull();
    expect(result.current.error).toBe('not-found');
    unmount();
  });

  test('offers an explicit safe retry after a load error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => incident } as Response);
    globalThis.fetch = fetchMock;

    const { result, unmount } = renderHook(() => useIncidentDetail(incident.id, opts));
    await waitFor(() => expect(result.current.error).toBe('load-error'));

    act(() => result.current.retry());

    await waitFor(() => expect(result.current.incident).toEqual(incident));
    expect(result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
  });
});
