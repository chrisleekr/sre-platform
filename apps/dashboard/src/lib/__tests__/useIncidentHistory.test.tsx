// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useIncidentHistory } from '../useIncidentHistory';
import type { HubMessage } from '../types';

const originalFetch = globalThis.fetch;
const incidentId = '11111111-1111-4111-8111-111111111111';
const opts = {
  apiBaseUrl: 'http://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};

function message(id: string, createdAt: string, content = id): HubMessage {
  return { id, incidentId, author: 'agent', kind: 'text', content, createdAt };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useIncidentHistory', () => {
  test('keeps resolved Slack names through replay but drops stale presentation after edits', async () => {
    const raw = message('message-1', '2026-08-21T00:01:00.000Z');
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        messages: [
          {
            ...raw,
            displayContent: 'Chris: @Homelab check health',
            authorDisplayName: 'Chris',
          },
        ],
        nextCursor: null,
      }),
    );
    const { result, rerender } = renderHook(
      ({ live }) => useIncidentHistory(incidentId, live, opts),
      {
        initialProps: { live: [raw] },
      },
    );
    await waitFor(() => expect(result.current.messages[0]?.authorDisplayName).toBe('Chris'));
    expect(result.current.messages[0]?.displayContent).toBe('Chris: @Homelab check health');
    rerender({ live: [{ ...raw, content: 'edited' }] });
    expect(result.current.messages[0]?.content).toBe('edited');
    expect(result.current.messages[0]?.displayContent).toBeUndefined();
  });
  test('a failed history load stays visible and can be retried', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: 'database details' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ messages: [], nextCursor: null }));
    const { result } = renderHook(() => useIncidentHistory(incidentId, [], opts));
    await waitFor(() =>
      expect(result.current.error).toContain('Conversation history could not be loaded'),
    );
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBeNull());
  });
  test('a refresh merges the newest page without dropping loaded older history', async () => {
    const oldest = message('message-1', '2026-08-21T00:01:00.000Z');
    const middle = message('message-2', '2026-08-21T00:02:00.000Z');
    const newest = message('message-3', '2026-08-21T00:03:00.000Z');
    let newestPageCalls = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('before=older-page'))
        return {
          ok: true,
          json: async () => ({ messages: [oldest], nextCursor: null }),
        } as Response;
      newestPageCalls += 1;
      return {
        ok: true,
        json: async () => ({
          messages:
            newestPageCalls === 1 ? [middle, newest] : [{ ...newest, content: 'updated receipt' }],
          nextCursor: newestPageCalls === 1 ? 'older-page' : 'newest-page-cursor',
        }),
      } as Response;
    });

    const { result, unmount } = renderHook(() => useIncidentHistory(incidentId, [], opts));
    await waitFor(() =>
      expect(result.current.messages.map((row) => row.id)).toEqual(['message-2', 'message-3']),
    );
    await waitFor(() => expect(result.current.hasOlder).toBe(true));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.messages).toHaveLength(3));
    expect(result.current.hasOlder).toBe(false);

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.messages[2]?.content).toBe('updated receipt'));
    expect(result.current.messages.map((row) => row.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
    ]);
    expect(result.current.hasOlder).toBe(false);
    unmount();
  });
});
