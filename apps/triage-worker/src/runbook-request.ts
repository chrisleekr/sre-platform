/** The responder-request fields a runbook job payload may carry, set or adopted. */
export interface RunbookRequestPayload {
  automatic?: unknown;
  requestedMessageId?: string;
  requestedBy?: string;
}

/**
 * The capture fence a save must pass for a responder request: the requesting message and member.
 * An automatic pass nobody asked for has none.
 *
 * @param payload - Job payload, as enqueued or as re-read after a request was adopted.
 */
export function requestFence(
  payload: RunbookRequestPayload | undefined,
): { messageId: string; userId: string } | undefined {
  return payload?.requestedMessageId && payload.requestedBy
    ? { messageId: payload.requestedMessageId, userId: payload.requestedBy }
    : undefined;
}
