// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useLlmUsage } from '../useLlmUsage';

const originalFetch = globalThis.fetch;
const usage = {
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-26T00:00:00.000Z',
  invocations: 3,
  succeeded: 2,
  failed: 1,
  unpriced: 0,
  missingUsage: 0,
  configuredCostUsd: 0.42,
  providerEstimatedCostUsd: 0.4,
  tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 },
  byOperation: [],
  byModel: [],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useLlmUsage', () => {
  test('loads only the requested usage window through the authenticated operator endpoint', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({ ok: true, json: async () => usage }) as Response,
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const getCredentials = async () => ({ kind: 'bearer' as const, token: 'jwt' });

    const { result } = renderHook(() =>
      useLlmUsage({
        apiBaseUrl: 'http://api',
        getCredentials,
        from: usage.from,
        to: usage.to,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.usage).toEqual({ ...usage, series: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `http://api/platform-settings/llm/usage?from=${encodeURIComponent(usage.from)}&to=${encodeURIComponent(usage.to)}`,
    );
    expect(init?.headers).toMatchObject({ authorization: 'Bearer jwt' });
  });
});
