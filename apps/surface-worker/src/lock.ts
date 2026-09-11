import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SurfaceLock } from './fanout';

// Slack requests have a 10s deadline. This wider renewable lease prevents a slow DB read around that
// request from letting a later lifecycle version overtake the current projection.
const OPEN_LOCK_TTL_MS = 60_000;

const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

export function makeRedisSurfaceLock(redis: Redis, ttlMs: number = OPEN_LOCK_TTL_MS): SurfaceLock {
  return {
    async acquire(key) {
      const token = randomUUID();
      const won = await redis.set(key, token, 'PX', ttlMs, 'NX');
      return won ? token : null;
    },
    async renew(key, token) {
      return (await redis.eval(RENEW_LUA, 1, key, token, ttlMs)) === 1;
    },
    async release(key, token) {
      await redis.eval(RELEASE_LUA, 1, key, token);
    },
  };
}
