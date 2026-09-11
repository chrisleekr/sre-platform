// @vitest-environment jsdom
// The polling hook behind the Error budgets panel. The panel had a component test against a mocked
// hook, so nothing covered the hook itself: the request it sends, the shape it projects, and the
// read-model promise that it only ever reads.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { SloRow } from '../types';
import { useSloStatus } from '../useSloStatus';
import type { RequestCredential } from '../request-credentials';

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const row = (over: Partial<SloRow> = {}): SloRow => ({
  id: 'slo-1',
  name: 'checkout-availability',
  service: 'checkout',
  sliType: 'availability',
  target: 0.999,
  windowDays: 30,
  enabled: true,
  lastEvaluationError: null,
  evaluationFailingSince: null,
  evaluation: {
    budgetRemaining: 0.25,
    burnRate: 4,
    burnWindow: '1h',
    exhaustionDays: 1.875,
    computedAt: '2026-09-05T00:00:00.000Z',
  },
  ...over,
});

const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};

describe('useSloStatus', () => {
  test('reads the objective status endpoint with the bearer token and projects the rows', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ slos: [row()] }));

    const { result, unmount } = renderHook(() => useSloStatus(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(globalThis.fetch).toHaveBeenCalledWith('http://api/slos/status', {
      credentials: 'include',
      headers: { authorization: 'Bearer jwt', 'x-sre-session': '1' },
    });
    expect(result.current.slos).toHaveLength(1);
    expect(result.current.error).toBe(false);
    unmount();
  });

  test('carries the failure reason through, so the panel can tell failing apart from new', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        slos: [
          row({
            evaluation: null,
            lastEvaluationError: 'query did not resolve to a numeric ratio',
            evaluationFailingSince: '2026-09-05T00:05:00.000Z',
          }),
        ],
      }),
    );

    const { result, unmount } = renderHook(() => useSloStatus(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.slos[0]!.lastEvaluationError).toBe(
      'query did not resolve to a numeric ratio',
    );
    unmount();
  });

  test('a response with no objectives yields an empty list rather than undefined', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({}));

    const { result, unmount } = renderHook(() => useSloStatus(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.slos).toEqual([]);
    expect(result.current.error).toBe(false);
    unmount();
  });

  test('a failed first load is a blocking error and reports the status code', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 403 }));

    const { result, unmount } = renderHook(() => useSloStatus(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe(true);
    expect(result.current.errorStatus).toBe(403);
    // Nothing was ever loaded, so this is not a background refresh failure.
    expect(result.current.backgroundError).toBe(false);
    unmount();
  });

  test('a failed refresh keeps the last good rows and degrades to a background error', async () => {
    // The whole point of the read model: a broken refresh must not blank out the last measurement.
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      return call === 1 ? Response.json({ slos: [row()] }) : new Response('boom', { status: 500 });
    });

    const { result, unmount } = renderHook(() => useSloStatus({ ...opts, pollMs: 20 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.slos).toHaveLength(1);

    await waitFor(() => expect(result.current.backgroundError).toBe(true));
    expect(result.current.slos).toHaveLength(1);
    unmount();
  });

  test('polls on its own cadence and stops on unmount', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ slos: [row()] }));

    const { result, unmount } = renderHook(() => useSloStatus({ ...opts, pollMs: 20 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1),
    );

    // Unmount and drain inside the test body: a polling hook torn down by the suite instead can fire
    // a timer after jsdom is gone and fail the run with "window is not defined".
    unmount();
    const after = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(after);
  });
});
test.each<RequestCredential>([{ kind: 'cookie' }, { kind: 'bearer', token: 'explicit-api-token' }])(
  'loads the error-budget read model with $kind credentials',
  async (credential) => {
    const fetch = vi.fn(async () => Response.json({ slos: [] }));
    vi.stubGlobal('fetch', fetch);
    const getCredentials = async () => credential;
    const { result, unmount } = renderHook(() =>
      useSloStatus({ apiBaseUrl: 'http://api.test', getCredentials }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.slos).toEqual([]);
    expect(fetch).toHaveBeenCalledWith('http://api.test/slos/status', {
      credentials: 'include',
      headers: {
        'x-sre-session': '1',
        ...(credential.kind === 'bearer' ? { authorization: 'Bearer explicit-api-token' } : {}),
      },
    });
    unmount();
  },
);
