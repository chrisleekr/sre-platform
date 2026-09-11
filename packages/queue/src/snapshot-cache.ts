import type { NormalizedSnapshot } from '@sre/connectors';
import type { Redis } from 'ioredis';

/**
 * Per-tenant, per-source cache of the latest connector poll. The poller writes each source's
 * NormalizedSnapshot[] under a TTL'd Valkey key; the dashboard read endpoints fetch by the
 * JWT-resolved tenant id. Valkey-only (the durable jobs live in Postgres); a stale/missing key is a
 * miss, not an error, so the panels degrade to empty rather than fail.
 *
 * Tenant isolation is by key namespace: `snap:<tenantId>:<source>`. The read side always keys by the
 * authenticated tenant, so one tenant can never address another's snapshots.
 */
export interface SnapshotCache {
  set(
    tenantId: string,
    source: string,
    snapshots: NormalizedSnapshot[],
    ttlSec: number,
    generation?: { id: string; lifecycleVersion: number },
  ): Promise<void>;
  /** The tenant's snapshots for one source; `[]` on miss or unparseable value. */
  get(
    tenantId: string,
    source: string,
    generation?: { id: string; lifecycleVersion: number },
  ): Promise<NormalizedSnapshot[]>;
  delete?(
    tenantId: string,
    source: string,
    generation?: { id: string; lifecycleVersion: number },
  ): Promise<void>;
  acquireLease?(name: string, ttlSec: number): Promise<boolean>;
}

const PREFIX = 'snap:';

function key(
  tenantId: string,
  source: string,
  generation?: { id: string; lifecycleVersion: number },
): string {
  const suffix = generation ? `:${generation.id}:${generation.lifecycleVersion}` : '';
  return `${PREFIX}${tenantId}:${source}${suffix}`;
}

/**
 * Builds a generation-aware connector snapshot cache.
 *
 * @param redis - Valkey connection used for expiring snapshot values.
 */
export function makeSnapshotCache(redis: Redis): SnapshotCache {
  return {
    async set(tenantId, source, snapshots, ttlSec, generation) {
      await redis.set(key(tenantId, source, generation), JSON.stringify(snapshots), 'EX', ttlSec);
    },
    async get(tenantId, source, generation) {
      const raw = await redis.get(key(tenantId, source, generation));
      if (!raw) return [];
      try {
        // NB: observedAt round-trips through JSON as an ISO string, not a Date. Readers that need a
        // Date must re-parse; the dashboard endpoints coerce with `new Date(...)` at the boundary.
        return JSON.parse(raw) as NormalizedSnapshot[];
      } catch {
        return [];
      }
    },
    async delete(tenantId, source, generation) {
      await redis.del(key(tenantId, source, generation));
    },
    async acquireLease(name, ttlSec) {
      return (await redis.set(`lease:${name}`, '1', 'EX', ttlSec, 'NX')) !== null;
    },
  };
}
