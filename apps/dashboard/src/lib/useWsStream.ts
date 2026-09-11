import type { CredentialGetter } from './request-credentials';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  WS_CLOSE_POLICY,
  WS_CLOSE_TOKEN_EXPIRED,
  type WsAcceptedFrame,
  type WsErrorFrame,
  type WsPostFrame,
} from '@sre/contracts';
import { authenticatedFetch } from './authenticatedFetch';
import type { HubMessage } from './types';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed';

/**
 * How many times one incident view may silently re-ticket after the server closed it for an expired
 * token. A bound, not a retry policy: each reconnect is a real ticket mint, and a server whose clock
 * disagrees with ours would otherwise turn "expired" into an unbounded mint-and-dial loop.
 */
export const MAX_TOKEN_EXPIRY_RECONNECTS = 10;
export type WsRefusalCode = WsErrorFrame['code'];

export interface WsStreamOptions {
  apiBaseUrl: string;
  wsBaseUrl: string;
  /** Resolves the current access token. Must be stable. */
  getCredentials: CredentialGetter;
  /** Upper bound for a WebSocket handshake that never opens or errors. */
  connectTimeoutMs?: number;
}

export interface WsStream {
  messages: HubMessage[];
  status: WsStatus;
  /** Last server refusal of a post. Null when clear. */
  error: string | null;
  errorCode: WsRefusalCode | null;
  connectionError: string | null;
  postState: {
    clientMessageId: string;
    messageId: string | null;
    state: 'saving' | 'saved' | 'failed';
  } | null;
  send: (content: string) => boolean;
  retry: () => void;
}

function isAcceptedFrame(v: unknown): v is WsAcceptedFrame {
  if (typeof v !== 'object' || v === null) return false;
  const frame = v as Partial<WsAcceptedFrame>;
  return (
    frame.type === 'accepted' &&
    typeof frame.clientMessageId === 'string' &&
    typeof frame.messageId === 'string'
  );
}

function isErrorFrame(v: unknown): v is WsErrorFrame {
  if (typeof v !== 'object' || v === null) return false;
  const frame = v as Partial<WsErrorFrame>;
  // Also require `code` to be a string: the shared WsErrorFrame types it as a strict union, so the
  // predicate must at least confirm the field is present before the compiler trusts that narrowing.
  return (
    frame.type === 'error' && typeof frame.code === 'string' && typeof frame.message === 'string'
  );
}

/**
 * Subscribe to an incident's hub conversation. Mints a single-use WS ticket over HTTP, then
 * opens the WebSocket with it — the access token never enters the WS URL. Live messages are
 * appended (deduped by id); `send` pushes human input back into the hub.
 */
export function useWsStream(incidentId: string | null, opts: WsStreamOptions): WsStream {
  const { apiBaseUrl, wsBaseUrl, getCredentials, connectTimeoutMs = 10_000 } = opts;
  const [messages, setMessages] = useState<HubMessage[]>([]);
  const [status, setStatus] = useState<WsStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<WsRefusalCode | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [postState, setPostState] = useState<WsStream['postState']>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingPostRef = useRef<WsPostFrame | null>(null);
  const tokenExpiryReconnectsRef = useRef(0);

  useEffect(() => {
    tokenExpiryReconnectsRef.current = 0;
    setMessages([]);
    setError(null);
    setErrorCode(null);
    setConnectionError(null);
    setPostState(null);
    pendingPostRef.current = null;
  }, [incidentId]);

  useEffect(() => {
    if (!incidentId) {
      setStatus('idle');
      return;
    }
    let active = true;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    setStatus('connecting');
    setConnectionError(null);

    void (async () => {
      try {
        const res = await authenticatedFetch(`${apiBaseUrl}/ws/ticket`, getCredentials, {
          method: 'POST',
        });
        if (!res.ok) throw new Error('ticket request failed');
        const { ticket } = (await res.json()) as { ticket?: unknown };
        if (typeof ticket !== 'string' || ticket.length === 0) throw new Error('invalid ticket');
        if (!active) return;

        const ws = new WebSocket(
          `${wsBaseUrl}/ws/incidents/${incidentId}?ticket=${encodeURIComponent(ticket)}`,
        );
        wsRef.current = ws;
        const clearConnectTimer = (): void => {
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = undefined;
        };
        connectTimer = setTimeout(() => {
          if (!active || ws.readyState === WebSocket.OPEN) return;
          timedOut = true;
          setConnectionError('The incident stream connection timed out.');
          setStatus('closed');
          ws.close();
        }, connectTimeoutMs);
        ws.onopen = () => {
          if (active) {
            clearConnectTimer();
            setConnectionError(null);
            setStatus('open');
            if (pendingPostRef.current) ws.send(JSON.stringify(pendingPostRef.current));
          }
        };
        ws.onerror = () => {
          if (active) {
            clearConnectTimer();
            if (timedOut) return;
            setConnectionError('Could not connect to the incident stream.');
            setStatus('closed');
          }
        };
        ws.onclose = (event: CloseEvent) => {
          if (!active) return;
          clearConnectTimer();
          if (timedOut) return;
          // An expired token is the one close the user should never have to act on: mint a fresh
          // ticket and dial again, reusing 'connecting' so the reconnect looks like the first connect.
          // The budget is deliberately NOT reset by a successful open, because open-then-immediately
          // -closed is precisely the clock-skew pathology the bound exists to stop; only a new
          // incident or an explicit retry clears it.
          if (
            event.code === WS_CLOSE_POLICY &&
            event.reason === WS_CLOSE_TOKEN_EXPIRED &&
            tokenExpiryReconnectsRef.current < MAX_TOKEN_EXPIRY_RECONNECTS
          ) {
            tokenExpiryReconnectsRef.current += 1;
            setConnectionError(null);
            // A post refused for the expired credential is exactly what precedes this close, so keeping
            // its banner would leave "reconnect to post" on screen after the reconnect already did that.
            // Same reasoning as the fresh-incident effect above: a new connection is a new context.
            setError(null);
            setErrorCode(null);
            setStatus('connecting');
            setRetryNonce((value) => value + 1);
            return;
          }
          setConnectionError('The incident stream disconnected.');
          setStatus('closed');
        };
        ws.onmessage = (e: MessageEvent) => {
          if (!active) return;
          try {
            const frame: unknown = JSON.parse(e.data as string);
            // Guard before the cast: an error frame is not a message and must not enter the log.
            if (isErrorFrame(frame)) {
              setError(frame.message);
              setErrorCode(frame.code);
              if (pendingPostRef.current) {
                setPostState((current) => (current ? { ...current, state: 'failed' } : null));
                pendingPostRef.current = null;
              }
              return;
            }
            if (isAcceptedFrame(frame)) {
              if (pendingPostRef.current?.clientMessageId === frame.clientMessageId) {
                setPostState({
                  clientMessageId: frame.clientMessageId,
                  messageId: frame.messageId,
                  state: 'saved',
                });
                pendingPostRef.current = null;
              }
              return;
            }
            const msg = frame as HubMessage;
            setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          } catch {
            // Ignore malformed frames. The connection can continue carrying valid messages.
          }
        };
      } catch {
        if (active) {
          setConnectionError('Could not connect to the incident stream.');
          setStatus('closed');
        }
      }
    })();

    return () => {
      active = false;
      if (connectTimer) clearTimeout(connectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [incidentId, apiBaseUrl, wsBaseUrl, getCredentials, connectTimeoutMs, retryNonce]);

  const send = useCallback((content: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && !pendingPostRef.current) {
      try {
        const frame: WsPostFrame = { content, clientMessageId: crypto.randomUUID() };
        pendingPostRef.current = frame;
        setPostState({
          clientMessageId: frame.clientMessageId,
          messageId: null,
          state: 'saving',
        });
        ws.send(JSON.stringify(frame));
        // A successful attempt clears a retryable refusal; a new one arrives as its own frame.
        setError(null);
        setErrorCode(null);
        return true;
      } catch {
        setConnectionError('The incident stream disconnected.');
        setStatus('closed');
      }
    }
    return false;
  }, []);

  const retry = useCallback(() => {
    // An explicit user retry is a fresh judgement that the stream is worth trying, so it restores the
    // automatic-reconnect budget the previous run may have spent.
    tokenExpiryReconnectsRef.current = 0;
    setRetryNonce((value) => value + 1);
  }, []);

  return {
    messages,
    status,
    error,
    errorCode,
    connectionError,
    postState,
    send,
    retry,
  };
}
