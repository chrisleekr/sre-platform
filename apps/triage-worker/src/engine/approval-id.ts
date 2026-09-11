import { createHash } from 'node:crypto';

/**
 * The approvals idempotency key, shared by BOTH engines. `createApproval` upserts on
 * (tenant, incident, action_id) and returns the existing row on conflict, so the key must be identical
 * across a redelivery of the same proposal.
 *
 * CONTENT-ADDRESSED, never the provider tool-call id. Anthropic and OpenAI both mint a FRESH tool-call id
 * on every API response, so a redelivered resume re-invokes the model, gets a new id, and — keyed on it —
 * would insert a SECOND approvals row and post a SECOND button block for one proposal, one of which could
 * never be decided. Hashing the proposal instead: same content -> same key (redelivery collapses to one
 * row), different content -> different key (nobody approves an action they were not shown). A random uuid
 * would satisfy uniqueness but break exactly the idempotency this key exists for.
 *
 * Hashed on the SCRUBBED proposal, at the point of persistence. The worker scrubs prompt/labels on the way
 * into Postgres and derives the key from those same scrubbed values (worker.ts), so the key addresses the
 * content the row actually holds and never encodes the pre-scrub secret's shape. Because scrubbing is pure
 * and deterministic, a redelivery re-scrubs identically and lands on the identical key. Option ORDER is part
 * of the identity — the buttons a human sees differ.
 *
 * `salt` re-opens a proposal whose consent is SPENT. Content alone cannot distinguish "the same proposal,
 * redelivered" from "the same action, proposed again after a human denied it" — and collapsing the second
 * onto the decided row would leave the engine waiting on buttons no human will ever be shown. The worker
 * salts with the turn (the newest drained human reply), which is stable across a redelivery of that turn
 * and distinct across a genuinely new one, so idempotency survives.
 */
export function approvalActionId(
  prompt: string,
  options: { id: string; label: string }[],
  salt?: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([prompt, options, salt ?? null]))
    .digest('hex');
  return `approval:${digest.slice(0, 32)}`;
}
