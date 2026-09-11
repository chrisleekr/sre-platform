import { describe, expect, test } from 'vitest';
import { makeSlackThreadReader, renderThread, type ThreadMessage } from '../slack-reader';
import type { FetchLike } from '../types';

// pull path: the Slack thread reader hydrates a whole thread via conversations.replies so the
// mention branch can seed an incident with the verbatim transcript. The fetch client is injected (a
// fake here), mirroring makeSlackPoster; never hits the network.

interface RepliesPage {
  ok: boolean;
  messages: { user: string; text: string; ts: string }[];
  response_metadata?: { next_cursor?: string };
}

/** A fake fetch that returns queued conversations.replies pages in order and records each call. */
function fakeFetch(pages: RepliesPage[]): {
  fetch: FetchLike;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const body = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
}

const getToken = (token: string | null) => async (_tenantId: string) => token;

describe('makeSlackThreadReader', () => {
  test('a single-page thread returns all messages mapped to ThreadMessage', async () => {
    const { fetch, calls } = fakeFetch([
      {
        ok: true,
        messages: [
          { user: 'U1', text: 'checkout is down', ts: '1699.0001' },
          { user: 'U2', text: 'looking now', ts: '1699.0002' },
        ],
      },
    ]);
    const reader = makeSlackThreadReader({ fetch, getToken: getToken('xoxb-BOT') });
    const msgs = await reader.readThread('tenant-1', 'C123', '1699.0001');

    expect(msgs).toEqual<ThreadMessage[]>([
      { user: 'U1', text: 'checkout is down', ts: '1699.0001' },
      { user: 'U2', text: 'looking now', ts: '1699.0002' },
    ]);
    // conversations.replies over the root ts, limit 200.
    expect(calls[0]!.url).toContain('https://slack.com/api/conversations.replies');
    expect(calls[0]!.url).toContain('channel=C123');
    expect(calls[0]!.url).toContain('ts=1699.0001');
    expect(calls[0]!.url).toContain('limit=200');
  });

  test('the bot token from getToken rides the Authorization Bearer header', async () => {
    const { fetch, calls } = fakeFetch([
      { ok: true, messages: [{ user: 'U1', text: 'hi', ts: '1' }] },
    ]);
    const reader = makeSlackThreadReader({ fetch, getToken: getToken('xoxb-TOKEN-123') });
    await reader.readThread('tenant-1', 'C123', '1');
    expect(calls[0]!.headers.authorization).toBe('Bearer xoxb-TOKEN-123');
  });

  test('pagination: a non-empty next_cursor is followed and messages concatenated', async () => {
    const { fetch, calls } = fakeFetch([
      {
        ok: true,
        messages: [{ user: 'U1', text: 'page one', ts: '1' }],
        response_metadata: { next_cursor: 'CURSOR_A' },
      },
      { ok: true, messages: [{ user: 'U2', text: 'page two', ts: '2' }] },
    ]);
    const reader = makeSlackThreadReader({ fetch, getToken: getToken('xoxb-BOT') });
    const msgs = await reader.readThread('tenant-1', 'C123', '1');

    expect(msgs.map((m) => m.text)).toEqual(['page one', 'page two']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('cursor=CURSOR_A');
  });

  test('a top-level mention with no replies (single message) yields a one-element transcript', async () => {
    const { fetch } = fakeFetch([
      { ok: true, messages: [{ user: 'U_HUMAN', text: '<@U_BOT> take a look', ts: '1699.5' }] },
    ]);
    const reader = makeSlackThreadReader({ fetch, getToken: getToken('xoxb-BOT') });
    const msgs = await reader.readThread('tenant-1', 'C123', '1699.5');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ user: 'U_HUMAN', text: '<@U_BOT> take a look', ts: '1699.5' });
  });

  test('a null bot token is a no-op: returns [] and never calls fetch (poster skip convention)', async () => {
    const { fetch, calls } = fakeFetch([{ ok: true, messages: [] }]);
    const reader = makeSlackThreadReader({ fetch, getToken: getToken(null) });
    const msgs = await reader.readThread('tenant-1', 'C123', '1');
    expect(msgs).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('a non-2xx HTTP status rejects with the status (never-drop is upstream, not here)', async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const reader = makeSlackThreadReader({ fetch, getToken: getToken('xoxb-BOT') });
    await expect(reader.readThread('tenant-1', 'C123', '1')).rejects.toThrow('429');
  });

  test('a logical ok:false body on HTTP 200 rejects (Slack signals errors in the body)', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'thread_not_found' }),
    });
    const reader = makeSlackThreadReader({ fetch, getToken: getToken('xoxb-BOT') });
    await expect(reader.readThread('tenant-1', 'C123', '1')).rejects.toThrow('not-ok');
  });

  // a broken 200 (body fails to parse) must fail LOUD, not silently return an empty thread — the
  // shared slackApiGet parses best-effort and hands back an undefined body, which the reader treats as
  // not-ok. Before the helper extraction, `await res.json()` threw here; this locks that behavior.
  test('a broken 200 whose body fails to parse rejects (not-ok), never an empty thread', async () => {
    const fetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('unexpected token < in JSON');
      },
    });
    const reader = makeSlackThreadReader({ fetch, getToken: getToken('xoxb-BOT') });
    await expect(reader.readThread('tenant-1', 'C123', '1')).rejects.toThrow('not-ok');
  });

  test('a fetch rejection surfaces a fixed message that never leaks the bot token', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('network down: authorization=Bearer xoxb-SECRET-TOKEN');
    };
    const reader = makeSlackThreadReader({ fetch, getToken: getToken('xoxb-SECRET-TOKEN') });
    await expect(reader.readThread('tenant-1', 'C123', '1')).rejects.toThrow(
      'slack conversations.replies request failed',
    );
    // Lock the no-token-leak comment: the rethrown message must not carry the bot token.
    await reader.readThread('tenant-1', 'C123', '1').catch((err: unknown) => {
      expect((err as Error).message).not.toContain('xoxb-SECRET-TOKEN');
    });
  });
});

describe('renderThread', () => {
  test('formats each line as [user]: text joined by newlines', () => {
    const rendered = renderThread([
      { user: 'U1', text: 'checkout is down', ts: '1' },
      { user: 'U2', text: 'restarting pods', ts: '2' },
    ]);
    expect(rendered).toBe('[U1]: checkout is down\n[U2]: restarting pods');
  });
});
