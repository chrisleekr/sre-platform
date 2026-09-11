import { createHash } from 'node:crypto';
import type { HubMessage } from '@sre/hub';
import { SLACK_API } from './slack-http';
import type { FetchLike } from './types';

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>\n]*)?>/g;
const AUTHOR = /^\[([UW][A-Z0-9]+)\]:/gm;

/** Presentation metadata only. Original content and identity remain unchanged. */
export interface SlackMessageDisplay {
  displayContent: string;
  authorDisplayName?: string;
}

/**
 * Resolves names for retained Slack transcripts, scoped to the tenant and current bot credential.
 * @param deps - Tenant token resolver and optional Slack HTTP transport.
 */
export function makeSlackDisplayResolver(deps: {
  getToken: (tenantId: string) => Promise<string | null>;
  fetch?: FetchLike;
}) {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const cache = new Map<string, { expires: number; name: Promise<string | null> }>();

  async function resolve(token: string, scope: string, user: string): Promise<string | null> {
    const key = `${scope}:${user}`;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.name;
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    const entry = { expires: Date.now() + 60_000, name: Promise.resolve<string | null>(null) };
    entry.name = (async () => {
      try {
        const response = await fetchImpl(
          `${SLACK_API}/users.info?user=${encodeURIComponent(user)}`,
          {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(1000),
          },
        );
        if (!response.ok) return null;
        const data = (await response.json()) as {
          ok?: boolean;
          user?: {
            name?: string;
            real_name?: string;
            profile?: { display_name?: string; real_name?: string };
          };
        };
        if (!data.ok) return null;
        const name = [
          data.user?.profile?.display_name,
          data.user?.profile?.real_name,
          data.user?.real_name,
          data.user?.name,
        ].find((value) => typeof value === 'string' && value.trim());
        if (!name) return null;
        entry.expires = Date.now() + 60 * 60_000;
        return Array.from(name, (char) =>
          char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char,
        )
          .join('')
          .trim()
          .slice(0, 100);
      } catch {
        return null;
      }
    })();
    cache.set(key, entry);
    return entry.name;
  }

  return async (
    tenantId: string,
    messages: HubMessage[],
    authors: ReadonlyMap<string, string> = new Map(),
  ): Promise<Map<string, SlackMessageDisplay>> => {
    const eligible = messages.filter(
      (message) => message.originSurface === 'slack' && message.author === 'human',
    );
    const ids = new Set(
      eligible.flatMap((message) => [
        ...(authors.has(message.id) ? [authors.get(message.id)!] : []),
        ...Array.from(message.content.matchAll(MENTION), (match) => match[1]!),
        ...Array.from(message.content.matchAll(AUTHOR), (match) => match[1]!),
      ]),
    );
    const result = new Map<string, SlackMessageDisplay>();
    if (ids.size === 0) return result;
    let token: string | null;
    try {
      token = await deps.getToken(tenantId);
    } catch {
      return result;
    }
    if (!token) return result;
    const scope = `${tenantId}:${createHash('sha256').update(token).digest('hex')}`;
    // Bound work per history page, including transcripts containing arbitrary user-supplied IDs.
    const names = new Map(
      await Promise.all(
        [...ids].slice(0, 40).map(async (id) => [id, await resolve(token, scope, id)] as const),
      ),
    );
    const escaped = (name: string) => name.replace(/[\\`*_{}[\]()#+.!<>|~-]/g, '\\$&');
    for (const message of eligible) {
      const authorName = names.get(authors.get(message.id) ?? '');
      result.set(message.id, {
        displayContent: message.content
          .replace(MENTION, (original, id: string) =>
            names.get(id) ? `@${escaped(names.get(id)!)}` : original,
          )
          .replace(AUTHOR, (original, id: string) =>
            names.get(id) ? `${escaped(names.get(id)!)}:` : original,
          ),
        // Only canonical sender metadata may label the author, never message text.
        ...(authorName ? { authorDisplayName: authorName } : {}),
      });
    }
    return result;
  };
}
