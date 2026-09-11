// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSlackPermalink } from '../useSlackPermalink';

const originalFetch = globalThis.fetch;
const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useSlackPermalink', () => {
  test('loads Slack-owned HTTPS archive links', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        permalink: 'https://company.slack.com/archives/C07EWAS8132/p1787403855537859',
      }),
    );

    const { result } = renderHook(() => useSlackPermalink('incident-1', opts));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.permalink).toBe(
      'https://company.slack.com/archives/C07EWAS8132/p1787403855537859',
    );
    expect(result.current.error).toBe(false);
  });

  test.each([
    'javascript:alert(1)',
    'https://example.com/archives/C07EWAS8132/p1787403855537859',
    'https://company.slack.com/client/T/C',
  ])('rejects a non-permalink response: %s', async (permalink) => {
    globalThis.fetch = vi.fn(async () => Response.json({ permalink }));

    const { result } = renderHook(() => useSlackPermalink('incident-1', opts));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.permalink).toBeNull();
  });

  test('exposes a retry after a transient API failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          permalink: 'https://workspace.slack.com/archives/C123/p123',
        }),
      );
    globalThis.fetch = fetchMock;
    const { result } = renderHook(() => useSlackPermalink('incident-1', opts));
    await waitFor(() => expect(result.current.error).toBe(true));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.permalink).toContain('workspace.slack.com'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
