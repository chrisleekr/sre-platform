import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { makeRedisSurfaceLock } from '../lock';

const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';
let redis: Redis;

beforeAll(() => {
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  await redis.quit();
});

describe('renewable surface projection lease', () => {
  test('only the owner token can renew or release the lease', async () => {
    const key = `surface-lock-test:${randomUUID()}`;
    const lock = makeRedisSurfaceLock(redis, 10_000);
    const token = await lock.acquire(key);
    expect(token).toBeTruthy();
    try {
      await redis.pexpire(key, 2_000);
      const shortenedTtl = await redis.pttl(key);
      expect(shortenedTtl).toBeGreaterThan(0);
      expect(shortenedTtl).toBeLessThanOrEqual(2_000);
      expect(await lock.renew(key, 'not-the-owner')).toBe(false);
      expect(await lock.renew(key, token!)).toBe(true);
      expect(await redis.pttl(key)).toBeGreaterThan(shortenedTtl + 5_000);

      await lock.release(key, 'not-the-owner');
      expect(await redis.get(key)).toBe(token);
      await lock.release(key, token!);
      expect(await redis.get(key)).toBeNull();
    } finally {
      await redis.del(key);
    }
  });
});
