// The surface adapter contract. Adapters mirror hub messages OUT to a chat surface; the
// Slack inbound runs through managed Socket Mode in apps/api; adapters take an injected fetch client so
// outbound calls are unit-testable with a fake, like connectors.
import type { HubMessage } from '@sre/hub';
import type { Surface } from '@sre/db';

export type { Surface };

/** A minimal fetch signature so adapters are testable with a fake (a subset of the DOM fetch). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json: () => Promise<unknown>;
}>;

/**
 * Where to post: the surface's bot token + the channel. `channel` comes from the incident's surface
 * BINDING — the channel the alert arrived in — never from a configured fan-out target. A thread
 * id (Slack's thread_ts) is only meaningful inside the channel that owns its root message, so the
 * channel and the thread must come from the same source or the reply lands nowhere.
 */
export interface SurfaceTarget {
  token: string;
  channel: string;
}

/**
 * A hub message on its way OUT to a surface. Adapters take this rather than a bare HubMessage so
 * the one rendering concern that is not the hub's business can travel with the content it describes; the
 * hub itself stays surface-agnostic, so `preformatted` is defined here, not on HubMessage.
 *
 * `preformatted` means "this content is already surface-native markup the platform authored; render it
 * verbatim". Omitting it ESCAPES the body, and that default is the whole point: a surface adapter renders
 * into a markup dialect (Slack parses `text` as mrkdwn), so an unescaped body is markup injection. A
 * future producer that forgets this flag gets escaped (safe) rather than unescaped (vulnerable).
 *
 * `author` is NOT a usable trust marker and must never be used as one: the author:'system' producers carry
 * the MOST untrusted text on the platform. classify-consumer.ts:481 appends the human's @mention
 * transcript as system, and worker.ts:283 appends the LLM's brief as system, so "escape unless system"
 * would leave exactly the untrusted text unescaped.
 *
 * Today the sole opt-out is the cross-thread breadcrumb (apps/triage-worker/src/index.ts), whose
 * `<url|text>` IS Slack's link syntax and whose URL comes from Slack's own chat.getPermalink over
 * Slack-generated ids, never human input.
 */
export type OutboundMessage = HubMessage & { preformatted?: boolean };

/** Outbound poster: mirror one hub message to a surface. */
export interface SurfacePoster {
  readonly surface: Surface;
  /**
   * Post a hub message into an EXISTING thread. `threadId` is the surface's own thread identifier
   * (Slack's root thread_ts), passed verbatim and opaque — never a joined composite, so a surface whose
   * thread ids contain delimiters (a Teams `19:…@thread.v2` conversation id) still round-trips. The
   * channel travels in `target`; the two always come from the same binding row. Nothing opens a
   * thread: the thread is the alert, and its binding is written with the incident. `link` is an
   * optional dashboard deep-link appended to the rendered text. Returns the POSTED MESSAGE's id (e.g. a
   * Slack ts), which the caller stores as the mutable working post.
   */
  post(
    target: SurfaceTarget,
    threadId: string,
    msg: OutboundMessage,
    link?: string | null,
  ): Promise<string>;
  /** Edit a message in place (e.g. chat.update) — the working post as the agent narrates. */
  update(
    target: SurfaceTarget,
    messageId: string,
    msg: OutboundMessage,
    link?: string | null,
  ): Promise<void>;
  /** Delete a message (e.g. chat.delete); tolerates already-gone as success (idempotent redelivery). */
  delete(target: SurfaceTarget, messageId: string): Promise<void>;
}
