// Slack thread reader: hydrate a whole thread via conversations.replies so the mention pull
// path can seed an incident with the verbatim transcript. Inbound-read counterpart of makeSlackPoster
// (outbound): same injected FetchLike so it is unit-testable with a fake, and the same null-token skip
// convention as the surface fan-out (a missing bot token is a config gap, not a triage failure).
import { nextCursor, slackApiGet, type SlackGetResult } from './slack-http';
import type { FetchLike } from './types';

const PAGE_LIMIT = 200; // conversations.replies page size; we paginate on next_cursor to exhaustion.

/** One thread message, normalized for the incident seed + characterize prompt. */
export interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
}

interface SlackRepliesResponse {
  ok?: boolean;
  messages?: { user?: string; text?: string; ts?: string }[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackThreadReaderDeps {
  /** Injected fetch (a fake in tests), mirroring makeSlackPoster. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** The tenant's Slack bot token, or null when unset (mirrors the fan-out's getToken). */
  getToken: (tenantId: string) => Promise<string | null>;
}

export interface SlackThreadReader {
  readThread(tenantId: string, channel: string, rootTs: string): Promise<ThreadMessage[]>;
}

/**
 * Renders Slack thread messages for an investigation seed prompt.
 *
 * @param msgs - Ordered Slack thread messages to render.
 */
export function renderThread(msgs: ThreadMessage[]): string {
  return distinctThreadMessages(msgs)
    .map((message) => (message.user ? `[${message.user}]: ${message.text}` : message.text))
    .join('\n');
}

/** Remove pagination overlap by source identity, never by message text.
 * @param messages - Messages from one Slack channel thread, in provider order.
 */
function distinctThreadMessages(messages: ThreadMessage[]): ThreadMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (!message.text.trim()) return false;
    if (!message.ts) return true;
    if (seen.has(message.ts)) return false;
    seen.add(message.ts);
    return true;
  });
}

/**
 * Builds a paginated tenant-scoped Slack thread reader.
 *
 * @param deps - HTTP and bot-token dependencies for Slack reads.
 */
export function makeSlackThreadReader(deps: SlackThreadReaderDeps): SlackThreadReader {
  const fetchImpl: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return {
    async readThread(tenantId, channel, rootTs): Promise<ThreadMessage[]> {
      const token = await deps.getToken(tenantId);
      // No token: skip silently (mirrors the fan-out, which only posts `if (token)`). The incident
      // still opens from the mention text, so a missing bot token degrades reads, never drops triage.
      if (!token) return [];

      const out: ThreadMessage[] = [];
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({ channel, ts: rootTs, limit: String(PAGE_LIMIT) });
        if (cursor) params.set('cursor', cursor);
        // The transport call is wrapped so a fetch rejection surfaces a fixed message: the bot token rides
        // a Bearer header (not the URL), and this guarantees no rejection text can carry it. The logical
        // failures below (non-2xx, ok:false) throw OUTSIDE this catch, keeping their specific messages.
        let res: SlackGetResult<SlackRepliesResponse>;
        try {
          res = await slackApiGet<SlackRepliesResponse>(
            fetchImpl,
            token,
            'conversations.replies',
            params,
          );
        } catch {
          throw new Error('slack conversations.replies request failed');
        }
        if (!res.ok) throw new Error(`slack conversations.replies failed: ${res.status}`);
        // Slack returns HTTP 200 even for logical failures; the `ok` flag is the real status. A missing
        // body is a broken 200 (unparseable JSON) — fail loud like the pre-extraction `res.json()` did,
        // never return an empty thread silently.
        if (!res.body || res.body.ok === false)
          throw new Error('slack conversations.replies not-ok');
        for (const m of res.body?.messages ?? []) {
          out.push({ user: m.user ?? '', text: m.text ?? '', ts: m.ts ?? '' });
        }
        // A non-empty next_cursor means another page follows; empty/absent ends the walk.
        cursor = nextCursor(res.body);
      } while (cursor);
      return distinctThreadMessages(out);
    },
  };
}
