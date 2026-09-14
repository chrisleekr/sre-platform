/**
 * WebSocket wire contract shared by the API surface (producer) and the dashboard (consumer). Pure TS,
 * no runtime deps: both sides import the same symbols so the ingress cap and the error-frame shape can
 * never drift apart.
 */

/**
 * Ingress bound on a single human post (CWE-770). Measured in UTF-16 code units (`String.length`),
 * not bytes: the column is `text` and the bound exists to cap what one frame can push into the hub and
 * into the next engine prompt, so a code-unit count is the honest unit and needs no surrogate arithmetic.
 * 8k is far above any real reply or pasted stack trace, and stays well under the 39k Slack egress render
 * cap so a hub message crossing to Slack is never truncated on the way out. Over-length posts are
 * REJECTED, never truncated: silently rewriting a human's words on the write path would corrupt the
 * canonical transcript. Rejection mirrors SLACK_FILE_MAX_BYTES, not the egress text cap.
 */
export const MAX_CONTENT_CHARS = 8_000;

/**
 * WebSocket close code for a policy decision the client cannot argue with (RFC 6455 section 7.4.1,
 * 1008 "Policy Violation"). Every server-initiated refusal of a dashboard session uses it.
 */
export const WS_CLOSE_POLICY = 1008;

/**
 * Close reason meaning the caller's access token reached its expiry while the socket was open.
 * The string is load-bearing across the API/dashboard boundary: the client keys its automatic
 * re-ticket-and-reconnect on this exact pairing with `WS_CLOSE_POLICY`, and treats every other policy
 * close as final. Both sides import this symbol so a rename can never silently disable the reconnect.
 */
export const WS_CLOSE_TOKEN_EXPIRED = 'token expired';

/**
 * Why an ingest was refused. Rides the WS error frame to the client, so it is a stable wire code.
 * `session_closed` means the caller's credential reached its expiry before the frame was committed; it
 * is distinct from `incident_archived`, which is a statement about the incident, not about the caller.
 */
export type IngestRefusalCode = 'content_too_long' | 'incident_archived' | 'session_closed';

/**
 * Server→client error frame. Every other frame on this socket is a HubMessage, which carries no
 * `type` field, so `type` is the discriminator the client keys on before treating a frame as a message.
 * A refused post is a per-message failure, never a socket close: the conversation stays live.
 */
export interface WsErrorFrame {
  type: 'error';
  code: IngestRefusalCode | 'rate_limited' | 'internal_error';
  message: string;
}

/** Dashboard post. The client-generated UUID makes reconnect/retry idempotent at the Postgres boundary. */
export interface WsPostFrame {
  content: string;
  clientMessageId: string;
}

/** The message and its resume job committed before this acknowledgement is emitted. */
export interface WsAcceptedFrame {
  type: 'accepted';
  clientMessageId: string;
  messageId: string;
}

/** Optional delivery metadata. Missing metadata from older servers is not proof of a live arrival. */
export interface WsMessageDelivery {
  replay?: boolean;
}
