import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

// Fallback default only. Production derives the TTL from the job ceiling plus stuck grace, and the
// lock must outlive any live run; a crashed worker's lock still auto-expires.
export const ENGINE_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * A per-incident mutex so at most one engine run (initial triage or a resume) is active per incident
 *Serializing runs keeps concurrent replies from interleaving hub writes or racing
 * `applyTriageResult`. `acquire` returns a release token (or null when already held); the token gates
 * `release` so a run that overran its TTL cannot free a later run's lock.
 */
export interface IncidentLock {
  acquire(incidentId: string): Promise<string | null>;
  release(incidentId: string, token: string): Promise<void>;
}

function lockKey(incidentId: string): string {
  return `engine:lock:${incidentId}`;
}

// Token-checked delete: only release the lock if it still holds our token.
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export function makeRedisLock(redis: Redis, ttlMs: number = ENGINE_LOCK_TTL_MS): IncidentLock {
  return {
    async acquire(incidentId) {
      const token = randomUUID();
      const won = await redis.set(lockKey(incidentId), token, 'PX', ttlMs, 'NX');
      return won ? token : null;
    },
    async release(incidentId, token) {
      await redis.eval(RELEASE_LUA, 1, lockKey(incidentId), token);
    },
  };
}
