// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { WS_CLOSE_POLICY, WS_CLOSE_TOKEN_EXPIRED } from '@sre/contracts';
import { MAX_TOKEN_EXPIRY_RECONNECTS, useWsStream } from '../useWsStream';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  send(d: string) {
    this.sent.push(d);
  }
  // A bare close() is a normal closure the client cannot distinguish from any other; the code/reason
  // pair exists so a test can express a server policy close.
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  /** Server-initiated close, so a test can drive the close frame the client must interpret. */
  serverClose(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const origWebSocket = globalThis.WebSocket;
const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.WebSocket = origWebSocket;
  globalThis.fetch = origFetch;
  FakeWebSocket.instances = [];
  vi.restoreAllMocks();
});

const opts = {
  apiBaseUrl: 'http://api',
  wsBaseUrl: 'ws://api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
};
const frame = {
  id: 'm1',
  incidentId: 'inc-1',
  author: 'agent',
  kind: 'text',
  content: 'investigating',
  createdAt: '2026-06-30T00:00:00Z',
};

function sentPost(ws: FakeWebSocket, index = 0): { content: string; clientMessageId: string } {
  return JSON.parse(ws.sent[index]!) as { content: string; clientMessageId: string };
}

describe('useWsStream', () => {
  test('preserves replay metadata while accepting older unmarked message frames', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async () => Response.json({ ticket: 'tkt' }));
    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.emit({ ...frame, replay: true });
      socket.emit({ ...frame, id: 'm2', replay: false });
      socket.emit({ ...frame, id: 'm3' });
    });
    expect(result.current.messages.map((message) => message.replay)).toEqual([
      true,
      false,
      undefined,
    ]);
    expect(result.current.messages.map((message) => message.content)).toEqual([
      'investigating',
      'investigating',
      'investigating',
    ]);
    unmount();
  });
  test('mints a ticket, connects, receives (deduped), and sends', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ ticket: 'tkt' }) }) as Response,
    );

    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('ws://api/ws/incidents/inc-1?ticket=tkt');

    act(() => ws.open());
    await waitFor(() => expect(result.current.status).toBe('open'));

    act(() => ws.emit(frame));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]!.content).toBe('investigating');

    // Duplicate id is ignored.
    act(() => ws.emit(frame));
    expect(result.current.messages).toHaveLength(1);

    let handedOff = false;
    act(() => {
      handedOff = result.current.send('ack');
    });
    expect(handedOff).toBe(true);
    expect(sentPost(ws)).toMatchObject({ content: 'ack' });
    expect(sentPost(ws).clientMessageId).toMatch(/^[0-9a-f-]{36}$/i);
    unmount();
  });

  // the server answers a refused post with a discriminated `{type:'error'}` frame. It must be
  // surfaced as an error, not swallowed into the message log as a malformed HubMessage.
  test('surfaces a server error frame and keeps it out of the message log', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ ticket: 'tkt' }) }) as Response,
    );

    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    await waitFor(() => expect(result.current.status).toBe('open'));

    act(() =>
      ws.emit({
        type: 'error',
        code: 'content_too_long',
        message: 'message exceeds the content limit',
      }),
    );
    await waitFor(() => expect(result.current.error).toBe('message exceeds the content limit'));
    expect(result.current.messages).toHaveLength(0);
    // The socket stays open: a refusal is per-message, not fatal.
    expect(result.current.status).toBe('open');

    // A real message still lands, and a fresh attempt clears the stale refusal.
    act(() => ws.emit(frame));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    act(() => result.current.send('retry'));
    expect(result.current.error).toBeNull();
    unmount();
  });

  test('marks the stream closed when the ticket mint fails', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response);

    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));
    await waitFor(() => expect(result.current.status).toBe('closed'));
    expect(result.current.connectionError).toMatch(/connect/i);
    expect(typeof result.current.retry).toBe('function');
    expect(FakeWebSocket.instances).toHaveLength(0);
    unmount();
  });

  test('turns a stalled WebSocket handshake into a visible retryable timeout', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ ticket: 'tkt' }) }) as Response,
    );

    const { result, unmount } = renderHook(() =>
      useWsStream('inc-1', { ...opts, connectTimeoutMs: 10 }),
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await waitFor(() => expect(result.current.status).toBe('closed'));
    expect(result.current.connectionError).toMatch(/timed out/i);
    expect(typeof result.current.retry).toBe('function');
    unmount();
  });

  test('an explicit retry mints a fresh ticket and retains messages already received', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ticket: 'ticket-one' }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ticket: 'ticket-two' }),
      } as Response);
    globalThis.fetch = fetchMock;

    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.emit(frame));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    act(() => first.close());
    await waitFor(() => expect(result.current.status).toBe('closed'));

    act(() => result.current.retry());

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances[1]!.url).toBe('ws://api/ws/incidents/inc-1?ticket=ticket-two');
    expect(result.current.messages).toEqual([frame]);
    unmount();
  });

  test('reconnect resends the same client id until the server acknowledges the durable row', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ ticket: 'tkt' }) }) as Response,
    );
    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => void result.current.send('same durable message'));
    const originalFrame = first.sent[0]!;

    act(() => first.close());
    act(() => result.current.retry());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(second.sent).toEqual([originalFrame]);

    const post = JSON.parse(originalFrame) as { clientMessageId: string };
    act(() =>
      second.emit({
        type: 'accepted',
        clientMessageId: post.clientMessageId,
        messageId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    await waitFor(() => expect(result.current.postState?.state).toBe('saved'));
    expect(result.current.postState?.messageId).toBe('11111111-1111-4111-8111-111111111111');
    unmount();
  });

  test('send reports whether content was handed to an open socket', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ ticket: 'tkt' }) }) as Response,
    );

    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;

    expect(result.current.send('too early')).toBe(false);
    act(() => ws.open());
    await waitFor(() => expect(result.current.status).toBe('open'));
    expect(result.current.send('ready')).toBe(true);
    expect(sentPost(ws)).toMatchObject({ content: 'ready' });
    act(() => ws.close());
    await waitFor(() => expect(result.current.status).toBe('closed'));
    expect(result.current.send('too late')).toBe(false);
    unmount();
  });

  test('reconnects without user action when the server closes for an expired token', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ ticket: 'tkt' }) }) as Response,
    );
    globalThis.fetch = fetchMock;

    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    await waitFor(() => expect(result.current.status).toBe('open'));

    // The refusal that races the deadline is the same event that then closes the socket, so the banner
    // it raises is the one most likely to be stale after the reconnect.
    act(() =>
      first.emit({
        type: 'error',
        code: 'session_closed',
        message: 'this session has ended; reconnect to post',
      }),
    );
    await waitFor(() => expect(result.current.errorCode).toBe('session_closed'));

    act(() => first.serverClose(WS_CLOSE_POLICY, WS_CLOSE_TOKEN_EXPIRED));

    // An expired token is recoverable: the hook mints a fresh ticket and dials again, so the user
    // never sees the disconnect state.
    await waitFor(() => expect(result.current.status).toBe('connecting'));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.connectionError).toBeNull();
    // The reconnect already did what the refusal asked for, so its banner must not survive it.
    expect(result.current.error).toBeNull();
    expect(result.current.errorCode).toBeNull();
    unmount();
  });

  test('shows the disconnect state and does not reconnect on a non-expiry policy close', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ ticket: 'tkt' }) }) as Response,
    );
    globalThis.fetch = fetchMock;

    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    await waitFor(() => expect(result.current.status).toBe('open'));

    // 'forbidden' is a decision about this incident, not a stale credential; retrying would loop.
    act(() => first.serverClose(WS_CLOSE_POLICY, 'forbidden'));

    await waitFor(() => expect(result.current.status).toBe('closed'));
    expect(result.current.connectionError).toMatch(/disconnect/i);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('does not reconnect when the expiry reason arrives under a different close code', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ ticket: 'tkt' }) }) as Response,
    );
    globalThis.fetch = fetchMock;

    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    await waitFor(() => expect(result.current.status).toBe('open'));

    // 1006 is what a browser reports for an abnormal transport drop, and a proxy can rewrite a close
    // frame's reason onto one. Reconnecting on the reason alone would mint a ticket on every blip.
    act(() => first.serverClose(1006, WS_CLOSE_TOKEN_EXPIRED));

    await waitFor(() => expect(result.current.status).toBe('closed'));
    expect(result.current.connectionError).toMatch(/disconnect/i);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('stops reconnecting once the token-expiry budget is spent', async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ ticket: 'tkt' }) }) as Response,
    );

    const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));

    // One close per socket, one more than the budget allows: the last one must not dial again, or a
    // server stuck on 'token expired' becomes an unbounded mint-and-dial loop.
    for (let attempt = 0; attempt <= MAX_TOKEN_EXPIRY_RECONNECTS; attempt++) {
      await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(attempt));
      const ws = FakeWebSocket.instances[attempt]!;
      act(() => ws.open());
      await waitFor(() => expect(result.current.status).toBe('open'));
      act(() => ws.serverClose(WS_CLOSE_POLICY, WS_CLOSE_TOKEN_EXPIRED));
    }

    await waitFor(() => expect(result.current.status).toBe('closed'));
    expect(FakeWebSocket.instances).toHaveLength(MAX_TOKEN_EXPIRY_RECONNECTS + 1);
    expect(result.current.connectionError).toMatch(/disconnect/i);

    // The Reconnect button is the only way out of a spent budget, so it has to restore it: without
    // the reset the reconnect would dial once and then stay disconnected for the rest of the session.
    act(() => result.current.retry());
    await waitFor(() =>
      expect(FakeWebSocket.instances).toHaveLength(MAX_TOKEN_EXPIRY_RECONNECTS + 2),
    );
    const revived = FakeWebSocket.instances[MAX_TOKEN_EXPIRY_RECONNECTS + 1]!;
    act(() => revived.open());
    await waitFor(() => expect(result.current.status).toBe('open'));

    act(() => revived.serverClose(WS_CLOSE_POLICY, WS_CLOSE_TOKEN_EXPIRED));
    await waitFor(() => expect(result.current.status).toBe('connecting'));
    await waitFor(() =>
      expect(FakeWebSocket.instances).toHaveLength(MAX_TOKEN_EXPIRY_RECONNECTS + 3),
    );
    expect(result.current.connectionError).toBeNull();
    unmount();
  });

  test.each(['rate_limited', 'content_too_long', 'internal_error'] as const)(
    '%s remains retryable on the open socket',
    async (code) => {
      globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
      globalThis.fetch = vi.fn(
        async () => ({ ok: true, json: async () => ({ ticket: 'tkt' }) }) as Response,
      );

      const { result, unmount } = renderHook(() => useWsStream('inc-1', opts));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const ws = FakeWebSocket.instances[0]!;
      act(() => ws.open());
      act(() => ws.emit({ type: 'error', code, message: `retry after ${code}` }));

      await waitFor(() => expect(result.current.errorCode).toBe(code));
      let handedOff = false;
      act(() => {
        handedOff = result.current.send('corrected retry');
      });
      expect(handedOff).toBe(true);
      await waitFor(() => expect(result.current.error).toBeNull());
      expect(result.current.errorCode).toBeNull();
      expect(sentPost(ws)).toMatchObject({ content: 'corrected retry' });
      unmount();
    },
  );
});

// Unmount in each test body, not just afterEach: the hook mints its ticket asynchronously, so a
// still-pending effect can resolve against a torn-down jsdom window during full-suite teardown and
// fail with "window is not defined" (unreproducible in isolation).
