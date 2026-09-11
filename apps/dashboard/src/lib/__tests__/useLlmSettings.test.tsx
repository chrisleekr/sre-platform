// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { saveLlmSettings, useLlmSettings } from '../useLlmSettings';

const originalFetch = globalThis.fetch;
const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};
const settings = {
  config: {
    runtime: 'claude-agent-sdk' as const,
    provider: 'anthropic' as const,
    model: 'claude-test',
    baseUrl: null,
    authMode: 'api-key' as const,
    maxTurns: 8,
    pricing: null,
  },
  source: 'stored' as const,
  credentialConfigured: true,
  updatedAt: '2026-08-25T00:00:00.000Z',
};
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useLlmSettings', () => {
  test('loads runtime configuration through the authenticated operator endpoint', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({ ok: true, json: async () => settings }) as Response,
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const { result } = renderHook(() => useLlmSettings(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.settings).toEqual(settings);
    expect(result.current).not.toHaveProperty('usage');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api/platform-settings/llm');
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({ authorization: 'Bearer jwt' });
  });
});

describe('saveLlmSettings', () => {
  test('sends a write-only credential and validated runtime config to the LLM endpoint', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({ ok: true, json: async () => settings }) as Response,
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      saveLlmSettings('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' }), {
        config: settings.config,
        credential: 'write-only',
      }),
    ).resolves.toEqual(settings);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/platform-settings/llm');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({
      config: settings.config,
      credential: 'write-only',
    });
  });
});
