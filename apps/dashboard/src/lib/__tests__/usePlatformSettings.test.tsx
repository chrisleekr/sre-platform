// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { savePlatformSetting, usePlatformSettings } from '../usePlatformSettings';

const originalFetch = globalThis.fetch;
const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};
const settings = [
  { key: 'sample.rate', value: 2.5, defaultValue: 1 },
  { key: 'archive/window', value: 12, defaultValue: 24 },
];

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('usePlatformSettings', () => {
  test('loads every numeric setting from the authenticated platform-settings endpoint', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ settings }) }) as Response,
    );
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => usePlatformSettings(opts));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings).toEqual(settings);
    expect(result.current.error).toBe(false);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://api/platform-settings');
    expect(call[1].headers).toMatchObject({ authorization: 'Bearer jwt' });
  });

  test('refetch reloads persisted settings', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ settings: [] }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    const { result } = renderHook(() => usePlatformSettings(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));

    result.current.refetch();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test('reports a failed load without inventing settings', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }) as Response);
    const { result } = renderHook(() => usePlatformSettings(opts));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(true);
    expect(result.current.settings).toEqual([]);
  });
});

describe('platform setting mutation', () => {
  test('sends a bearer-authenticated JSON number to the encoded setting path', async () => {
    const saved = { key: 'archive/window size', value: 3.75 };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => saved }) as Response);
    globalThis.fetch = fetchMock;

    await expect(
      savePlatformSetting(
        'http://api',
        async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        saved.key,
        saved.value,
      ),
    ).resolves.toEqual(saved);

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://api/platform-settings/archive%2Fwindow%20size');
    expect(call[1].method).toBe('PUT');
    expect(call[1].headers).toMatchObject({
      authorization: 'Bearer jwt',
      'content-type': 'application/json',
    });
    expect(JSON.parse(call[1].body as string)).toEqual({ value: 3.75 });
  });

  test('rejects a failed save so the editor can retain the draft', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }) as Response);

    await expect(
      savePlatformSetting(
        'http://api',
        async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        'sample.rate',
        4,
      ),
    ).rejects.toThrow();
  });
});
