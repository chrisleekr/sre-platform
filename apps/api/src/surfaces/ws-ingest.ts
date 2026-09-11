import { MAX_CONTENT_CHARS, type WsAcceptedFrame, type WsErrorFrame } from '@sre/contracts';
import { IngestRefusedError, type IncidentSession } from './session';
import type { TokenBucket } from './rate-limit';

/**
 * Pre-parse bound on the RAW frame (CWE-770). The content cap lives in `ingest`, but it can only be applied
 * after JSON.parse, so without this an authed socket could burn Bun's full 16MB maxPayloadLength of parse
 * allocation per frame. 8x the content cap leaves room for the JSON envelope and for worst-case escaping
 * (a control char serializes to 6 chars), so no legitimate frame is refused here; the exact cap is still
 * enforced on the decoded content.
 */
export const MAX_FRAME_CHARS = MAX_CONTENT_CHARS * 8;
// Bun's transport limit is bytes while JavaScript string length is UTF-16 code units. Four bytes per
// code unit admits every application-valid text frame while rejecting Bun's 16 MB default at transport.
export const MAX_FRAME_BYTES = MAX_FRAME_CHARS * 4;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Extract the human message and its idempotency key. Raw text remains a legacy, unacknowledged input. */
function parsePost(data: unknown): { content: string; clientMessageId?: string } {
  if (typeof data !== 'string') return { content: '' };
  try {
    const m = JSON.parse(data) as { content?: unknown; clientMessageId?: unknown };
    if (typeof m.content === 'string') {
      const clientMessageId =
        typeof m.clientMessageId === 'string' && UUID_RE.test(m.clientMessageId)
          ? m.clientMessageId
          : undefined;
      return { content: m.content.trim(), clientMessageId };
    }
  } catch {
    return { content: data.trim() };
  }
  return { content: '' };
}

/**
 * Handle one inbound client frame. Transport-agnostic on purpose: ws.ts pulls in `hono/bun`, which needs
 * the Bun global, so the logic lives here where it is directly testable. Rate-limited and policy-refused
 * posts answer with a discriminated error frame instead of a silent drop or an unhandled
 * rejection, and the socket stays open in every case.
 */
export async function handleIngestFrame(
  ctx: {
    session: IncidentSession | null | Promise<IncidentSession | null>;
    bucket: TokenBucket;
    send: (frame: WsErrorFrame | WsAcceptedFrame) => void;
  },
  data: unknown,
): Promise<void> {
  const { bucket, send } = ctx;
  // Budget check first: a spent budget must not buy a DB round-trip (CWE-770).
  if (!bucket.tryTake()) {
    send({
      type: 'error',
      code: 'rate_limited',
      message: 'too many messages; slow down and retry',
    });
    return;
  }
  // Bound the frame BEFORE JSON.parse; answer with the same code the content cap uses, since from the
  // client's side this is the same refusal (its message was too long), not a silent drop.
  if (typeof data === 'string' && data.length > MAX_FRAME_CHARS) {
    send({
      type: 'error',
      code: 'content_too_long',
      message: `message exceeds the ${MAX_CONTENT_CHARS}-character limit`,
    });
    return;
  }
  const { content, clientMessageId } = parsePost(data);
  if (!content) return;
  const session = await ctx.session;
  if (!session) return;
  try {
    const message = await session.adapter.ingest({ content, clientMessageId });
    if (clientMessageId) {
      send({ type: 'accepted', clientMessageId, messageId: message.id });
    }
  } catch (err) {
    if (err instanceof IngestRefusedError) {
      send({ type: 'error', code: err.code, message: err.message });
      return;
    }
    // An infrastructure failure leaks nothing to the client, but must not take the socket down either.
    console.warn(
      JSON.stringify({
        level: 'warn',
        pkg: 'surfaces',
        msg: 'ws ingest failed',
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    send({ type: 'error', code: 'internal_error', message: 'could not post your message; retry' });
  }
}
