import type { CredentialGetter } from '../request-credentials';
// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useSurfaces,
  saveSlackSurface,
  testSlackSurface,
  listChannels,
  listAvailableChannels,
  toggleChannel,
} from '../useSurfaces';
import * as surfaceHelpers from '../useSurfaces';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};
const surface = {
  id: 'srf-1',
  surface: 'slack',
  hasAppToken: true,
  hasBotToken: true,
};

describe('useSurfaces', () => {
  test('loads the tenant surfaces with the bearer header', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ surfaces: [surface] }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    const { result } = renderHook(() => useSurfaces(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.surfaces).toHaveLength(1);
    expect(result.current.error).toBe(false);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://api/surfaces');
    expect(call[1].headers).toMatchObject({ authorization: 'Bearer jwt' });
  });

  test('flags an error when the request fails', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response);
    const { result } = renderHook(() => useSurfaces(opts));
    await waitFor(() => expect(result.current.error).toBe(true));
  });

  // T3 characterization: refetch() bumps the nonce and re-fires the load (the post-mutation reload).
  // Locked before the six per-resource hooks fold into a shared useFetchResource, since useSurfaces is the
  // one whose refetch path had no test (useConnectors already covers its own).
  test('refetch re-fetches the surfaces', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ surfaces: [] }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    const { result } = renderHook(() => useSurfaces(opts));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    result.current.refetch();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe('slack surface mutation helpers', () => {
  test('saveSlackSurface PUTs to /surfaces/slack with the write-only body and bearer header', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    await saveSlackSurface('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' }), {
      appToken: 'xapp-abc',
      botToken: 'xoxb-abc',
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://api/surfaces/slack');
    expect(call[1].method).toBe('PUT');
    expect(call[1].headers).toMatchObject({
      authorization: 'Bearer jwt',
      'content-type': 'application/json',
    });
    const body = JSON.parse(call[1].body as string) as {
      appToken: string;
      botToken: string;
    };
    expect(body).toEqual({
      appToken: 'xapp-abc',
      botToken: 'xoxb-abc',
    });
  });

  test('saveSlackSurface surfaces the API reason and gives an actionable expired-session message', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({ error: 'Slack workspace is already connected to another tenant' }),
        }) as Response,
    );
    await expect(
      saveSlackSurface('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' }), {
        appToken: 'xapp-secret',
        botToken: 'xoxb-secret',
      }),
    ).rejects.toThrow(/already connected to another tenant/i);

    globalThis.fetch = vi.fn(
      async () =>
        ({ ok: false, status: 401, json: async () => ({ error: 'invalid token' }) }) as Response,
    );
    await expect(
      saveSlackSurface('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' }), {
        appToken: 'xapp-secret',
        botToken: 'xoxb-secret',
      }),
    ).rejects.toThrow(/session expired.*sign in again/i);
  });

  test('testSlackSurface POSTs to /surfaces/slack/test and returns the parsed result', async () => {
    const probe = { ok: true, botUserId: 'U0BOT', team: 'T0' };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => probe }) as Response);
    globalThis.fetch = fetchMock;
    const res = await testSlackSurface('http://api', async () => ({
      kind: 'bearer' as const,
      token: 'jwt',
    }));
    expect(res).toEqual(probe);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://api/surfaces/slack/test');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers).toMatchObject({ authorization: 'Bearer jwt' });
  });

  test('listChannels GETs /surfaces/slack/channels with the bearer header', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ channels: [] }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    await listChannels('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' }));
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://api/surfaces/slack/channels');
    expect(call[1].headers).toMatchObject({ authorization: 'Bearer jwt' });
  });

  test('toggleChannel PUTs to /surfaces/slack/channels/<channel> with the enabled body', async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    await toggleChannel(
      'http://api',
      async () => ({ kind: 'bearer' as const, token: 'jwt' }),
      '#alerts',
      false,
    );
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://api/surfaces/slack/channels/%23alerts');
    expect(call[1].method).toBe('PUT');
    expect(call[1].headers).toMatchObject({ authorization: 'Bearer jwt' });
    const body = JSON.parse(call[1].body as string) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  test('mutation helpers throw on a non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, text: async () => '' }) as Response);
    await expect(
      saveSlackSurface('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' }), {
        appToken: 'a',
        botToken: 't',
      }),
    ).rejects.toThrow();
    await expect(
      testSlackSurface('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' })),
    ).rejects.toThrow();
    await expect(
      listChannels('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' })),
    ).rejects.toThrow();
    await expect(
      toggleChannel(
        'http://api',
        async () => ({ kind: 'bearer' as const, token: 'jwt' }),
        'C_X',
        true,
      ),
    ).rejects.toThrow();
    await expect(
      listAvailableChannels('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' })),
    ).rejects.toThrow();
  });

  // the pick-list source. A Slack refusal (missing scope) must surface its message, not degrade
  // to an empty list that would read as "this workspace has no channels".
  test('listAvailableChannels GETs /surfaces/slack/available-channels and surfaces the error message', async () => {
    const channels = [{ id: 'C07EWAS8132', name: '#homelab-notification' }];
    // the response carries the truncation flag alongside the list, and it must survive the
    // boundary — the picker cannot tell a page-capped list from a complete one by looking at it.
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ channels, truncated: true }) }) as Response,
    );
    await expect(
      listAvailableChannels('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' })),
    ).resolves.toEqual({
      channels,
      truncated: true,
    });
    // An API that omits the flag (older deployment) reads as not-truncated, never as undefined.
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ channels }) }) as Response,
    );
    await expect(
      listAvailableChannels('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' })),
    ).resolves.toEqual({
      channels,
      truncated: false,
    });

    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({ error: 'Slack app needs channels:read' }),
        }) as Response,
    );
    await expect(
      listAvailableChannels('http://api', async () => ({ kind: 'bearer' as const, token: 'jwt' })),
    ).rejects.toThrow(/channels:read/);
  });

  test('disconnectSlackSurface DELETEs the Slack connection and surfaces an API failure', async () => {
    const disconnectSlackSurface = (
      surfaceHelpers as unknown as {
        disconnectSlackSurface?: (
          apiBaseUrl: string,
          getCredentials: CredentialGetter,
        ) => Promise<void>;
      }
    ).disconnectSlackSurface;
    expect(disconnectSlackSurface).toBeTypeOf('function');

    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response,
    );
    globalThis.fetch = fetchMock;
    await disconnectSlackSurface!('http://api', async () => ({
      kind: 'bearer' as const,
      token: 'jwt',
    }));
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://api/surfaces/slack');
    expect(call[1]).toMatchObject({
      method: 'DELETE',
      headers: { authorization: 'Bearer jwt' },
    });

    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: 'disconnect failed' }, { status: 503 }),
    );
    await expect(
      disconnectSlackSurface!('http://api', async () => ({
        kind: 'bearer' as const,
        token: 'jwt',
      })),
    ).rejects.toThrow(/could not be disconnected/i);
  });
});
