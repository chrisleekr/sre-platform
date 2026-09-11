import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { AvailableChannel } from './surface-config';

/** What a cached available-channels read carries: the list, plus whether it is partial. */
export interface CachedChannels {
  channels: AvailableChannel[];
  truncated: boolean;
}

export interface ChannelsCache {
  /** null is a MISS. A cached EMPTY list is a HIT, and must be served as one: a workspace where the bot
   *  sees no channels is a legitimate answer, and returning [] for a miss would re-hammer Slack forever. */
  get(tenantId: string, token: string): Promise<CachedChannels | null>;
  set(tenantId: string, token: string, value: CachedChannels, ttlSec: number): Promise<void>;
}

/**
 * Per-tenant AND per-token key. Tenant first: tenant isolation is absolute and Valkey has no
 * RLS to fall back on.
 *
 * The TOKEN is part of the key because the list is DERIVED from it. Invalidating on write instead cannot
 * be made correct: a GET that started before the token changed can spend up to 50 pages x 15s inside
 * conversations.list and then write the OLD workspace's channels back into the cache AFTER the delete —
 * the operator then picks a channel id that matches no inbound event, which is the silently-dead inbound
 * this pick-list exists to prevent. Keying on the token makes the stale entry unreachable the
 * instant the token changes, so no ordering can race; the orphan simply expires on its TTL. The token is
 * hashed, never stored: a Valkey dump must not leak a bot token.
 */
export const channelsCacheKey = (tenantId: string, token: string): string =>
  `slack:channels:${tenantId}:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;

/**
 * The Slack available-channels cache. conversations.list is Tier-2 rate-limited and can walk up
 * to CHANNELS_MAX_PAGES pages; the dashboard asked for it on every mount, so a few operators with the
 * page open were enough to earn a 429. Cache the answer per tenant + token, briefly.
 *
 * FAIL-OPEN at this seam, so the route never has to reason about cache faults: a Valkey outage (or a
 * malformed entry) reads as a MISS and the route re-reads Slack, and a failed WRITE is swallowed rather
 * than discarding a Slack read the caller already paid for. A cache is an optimisation; it must never be
 * able to fail the request it was meant to speed up.
 */
export function makeChannelsCache(redis: Redis): ChannelsCache {
  return {
    async get(tenantId, token) {
      try {
        const raw = await redis.get(channelsCacheKey(tenantId, token));
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as CachedChannels;
        if (!Array.isArray(parsed.channels)) return null;
        return { channels: parsed.channels, truncated: parsed.truncated === true };
      } catch {
        return null; // Valkey down, or a corrupt entry: a MISS, never a 500.
      }
    },
    async set(tenantId, token, value, ttlSec) {
      await redis
        .set(channelsCacheKey(tenantId, token), JSON.stringify(value), 'EX', ttlSec)
        .catch(() => {}); // best-effort: the next read just pays for Slack again.
    },
  };
}
