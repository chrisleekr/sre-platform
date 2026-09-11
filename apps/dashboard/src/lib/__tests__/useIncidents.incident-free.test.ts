// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useIncidents } from '../useIncidents';

const originalFetch = globalThis.fetch;
const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
  state: 'open' as const,
};
const incident = {
  id: 'incident-1',
  service: 'checkout',
  severity: 'sev2',
  status: 'open',
  alertSource: 'datadog',
  rcaSummary: null,
  confidence: null,
  createdAt: '2026-09-02T11:00:00.000Z',
};
const running = {
  state: 'running' as const,
  asOf: '2026-09-02T12:00:00.000Z',
  startedAt: '2026-09-02T10:00:00.000Z',
  qualifyingActiveCount: 0,
  scope: { severities: ['sev1', 'sev2'] as ['sev1', 'sev2'] },
  lastIncident: { id: 'resolved-1', title: 'Checkout recovered', severity: 'sev2' },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useIncidents incident-free status', () => {
  test('C1/C10 preserves the server-authoritative status DTO from the open queue response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ incidents: [incident], incidentFreeStatus: running }),
        }) as Response,
    );

    const { result } = renderHook(() => useIncidents(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(
      (
        result.current as typeof result.current & {
          incidentFreeStatus: typeof running;
        }
      ).incidentFreeStatus,
    ).toEqual(running);
  });

  test('C4 invalidates a cached running streak after a failed refresh while retaining queue rows', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? ({
            ok: true,
            json: async () => ({ incidents: [incident], incidentFreeStatus: running }),
          } as Response)
        : ({ ok: false, status: 503, json: async () => ({}) } as Response);
    });

    const { result, unmount } = renderHook(() => useIncidents({ ...opts, pollMs: 20 }));
    await waitFor(() => expect(result.current.backgroundError).toBe(true));
    const state = result.current as typeof result.current & {
      incidentFreeStatus: { state: string; startedAt: string | null };
    };

    expect(state.incidents).toEqual([incident]);
    expect(state.incidentFreeStatus).toMatchObject({ state: 'unavailable', startedAt: null });
    expect(state.incidentFreeStatus).not.toMatchObject({
      state: 'running',
      startedAt: running.startedAt,
    });
    unmount();
    await act(async () => Promise.resolve());
  });
});
