import { WS_CLOSE_POLICY } from '@sre/contracts';
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import type { WSEvents } from 'hono/ws';
import { openIncidentSession, type IncidentSession, type SessionDeps } from './session';
import { makeTokenBucket } from './rate-limit';
import { handleIngestFrame } from './ws-ingest';

// Per-connection ingest rate limit (CWE-770): a burst of up to WS_BURST frames is allowed, then
// frames are refused and refill at WS_REFILL_PER_SEC. Bounds how fast one socket can trigger resumes.
const WS_BURST = 20;
const WS_REFILL_PER_SEC = 1;

/**
 * Dashboard WebSocket surface. `GET /ws/incidents/:incidentId?ticket=…` — the
 * handshake carries a short-lived single-use ticket (minted at `POST /ws/ticket`), never a
 * bearer token, so nothing sensitive lands in access logs. Thin Bun transport over the
 * runtime-agnostic session logic.
 */
export function wsRoutes(deps: SessionDeps): Hono {
  const app = new Hono();

  app.get(
    '/incidents/:incidentId',
    upgradeWebSocket((c) =>
      incidentWebSocketEvents(deps, c.req.param('incidentId') ?? '', c.req.query('ticket')),
    ),
  );

  return app;
}

/** Build the stateful event handlers for one dashboard socket. */
export function incidentWebSocketEvents(
  deps: SessionDeps,
  incidentId: string,
  ticket: string | undefined,
): WSEvents {
  let session: IncidentSession | null = null;
  let resolveSessionReady!: (value: IncidentSession | null) => void;
  const sessionReady = new Promise<IncidentSession | null>((resolve) => {
    resolveSessionReady = resolve;
  });
  let preAuthFramePending = false;
  let closed = false;
  // One bucket per connection: the limit is per-socket, not global.
  const bucket = makeTokenBucket({
    capacity: WS_BURST,
    refillPerSec: WS_REFILL_PER_SEC,
    now: () => Date.now(),
  });

  return {
    async onOpen(_evt, ws) {
      try {
        const opened = await openIncidentSession(deps, {
          incidentId,
          ticket,
          sink: {
            send: (data) => {
              if (ws.readyState === 1) ws.send(data);
            },
            close: (code, reason) => ws.close(code, reason),
          },
        });
        if (closed) await opened?.close();
        else session = opened;
      } finally {
        resolveSessionReady(session);
      }
    },
    async onMessage(evt, ws) {
      // Retain at most one frame while authorization and history replay are pending. Admission checks
      // in handleIngestFrame run before it awaits the session promise.
      if (!session && preAuthFramePending) {
        if (!closed) {
          closed = true;
          ws.close(WS_CLOSE_POLICY, 'only one frame is allowed while the session opens');
        }
        return;
      }
      preAuthFramePending = !session;
      try {
        await handleIngestFrame(
          {
            session: session ?? sessionReady,
            bucket,
            send: (frame) => {
              if (ws.readyState === 1) ws.send(JSON.stringify(frame));
            },
          },
          evt.data,
        );
      } finally {
        preAuthFramePending = false;
      }
    },
    async onClose() {
      closed = true;
      await session?.close();
      session = null;
    },
  };
}
