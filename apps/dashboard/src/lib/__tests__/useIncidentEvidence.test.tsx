// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useIncidentEvidence } from '../useIncidentEvidence';

const originalFetch = globalThis.fetch;
const incidentId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};
const evidence = {
  id: evidenceId,
  tool: 'query_metrics',
  outcome: 'data',
  latencyMs: 12,
  recordedAt: '2026-08-21T00:00:00.000Z',
  hasOutput: true,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useIncidentEvidence', () => {
  test('allows a failed evidence detail request to be retried', async () => {
    let detailCalls = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (!url.endsWith(`/${evidenceId}`))
        return {
          ok: true,
          json: async () => ({ evidence: [evidence], nextCursor: null }),
        } as Response;
      detailCalls += 1;
      if (detailCalls === 1) return { ok: false, status: 503 } as Response;
      return {
        ok: true,
        json: async () => ({ ...evidence, input: { service: 'checkout' }, output: { cpu: 0.9 } }),
      } as Response;
    });

    const { result, unmount } = renderHook(() => useIncidentEvidence(incidentId, opts));
    await waitFor(() => expect(result.current.evidence).toHaveLength(1));

    act(() => result.current.loadDetail(evidenceId));
    await waitFor(() => {
      expect(detailCalls).toBe(1);
      expect(evidenceId in result.current.details).toBe(false);
      expect(result.current.detailErrors[evidenceId]).toBe(true);
    });

    act(() => result.current.loadDetail(evidenceId));
    await waitFor(() =>
      expect(result.current.details[evidenceId]).toMatchObject({ output: { cpu: 0.9 } }),
    );
    expect(detailCalls).toBe(2);
    expect(result.current.detailErrors[evidenceId]).toBe(false);
    unmount();
  });

  test('distinguishes an unavailable evidence ledger from an empty ledger and retries', async () => {
    let requests = 0;
    globalThis.fetch = vi.fn(async () => {
      requests += 1;
      if (requests === 1) return { ok: false, status: 503 } as Response;
      return {
        ok: true,
        json: async () => ({ evidence: [], nextCursor: null }),
      } as Response;
    });

    const { result, unmount } = renderHook(() => useIncidentEvidence(incidentId, opts));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBe(false));
    expect(result.current.evidence).toEqual([]);
    expect(requests).toBe(2);
    unmount();
  });

  test('restores a failed pagination cursor so loading older evidence can be retried', async () => {
    let pageCalls = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (!url.includes('before='))
        return {
          ok: true,
          json: async () => ({ evidence: [evidence], nextCursor: 'older-page' }),
        } as Response;
      pageCalls += 1;
      if (pageCalls === 1) return { ok: false, status: 503 } as Response;
      return {
        ok: true,
        json: async () => ({
          evidence: [{ ...evidence, id: '33333333-3333-4333-8333-333333333333' }],
          nextCursor: null,
        }),
      } as Response;
    });

    const { result, unmount } = renderHook(() => useIncidentEvidence(incidentId, opts));
    await waitFor(() => expect(result.current.nextCursor).toBe('older-page'));

    act(() => result.current.loadOlder());
    await waitFor(() => {
      expect(result.current.nextCursor).toBe('older-page');
      expect(result.current.paginationError).toBe(true);
    });

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.evidence).toHaveLength(2));
    expect(result.current.nextCursor).toBeNull();
    expect(result.current.paginationError).toBe(false);
    expect(pageCalls).toBe(2);
    unmount();
  });

  test('a refresh merges the newest page without dropping loaded older evidence', async () => {
    const older = { ...evidence, id: '33333333-3333-4333-8333-333333333333' };
    let newestPageCalls = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('before=older-page'))
        return {
          ok: true,
          json: async () => ({ evidence: [older], nextCursor: null }),
        } as Response;
      newestPageCalls += 1;
      return {
        ok: true,
        json: async () => ({
          evidence: [{ ...evidence, outcome: newestPageCalls === 1 ? 'data' : 'no_data' }],
          nextCursor: newestPageCalls === 1 ? 'older-page' : 'shifted-page',
        }),
      } as Response;
    });

    const { result, unmount } = renderHook(() => useIncidentEvidence(incidentId, opts));
    await waitFor(() => expect(result.current.nextCursor).toBe('older-page'));
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.evidence).toHaveLength(2));
    expect(result.current.nextCursor).toBeNull();

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.evidence[0]?.outcome).toBe('no_data'));
    expect(result.current.evidence.map((item) => item.id)).toEqual([evidenceId, older.id]);
    expect(result.current.nextCursor).toBeNull();
    unmount();
  });
});
