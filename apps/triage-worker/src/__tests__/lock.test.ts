// Real-Valkey integration: the per-incident engine lock is mutually exclusive, releases only for the
// token that holds it (a run that overran its TTL cannot free a later run's lock), and auto-expires so
// a crashed holder cannot wedge an incident forever.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { makeRedisLock } from '../lock';

const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';
let redis: Redis;

beforeAll(() => {
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
});
afterAll(async () => {
  await redis.quit();
});

describe('makeRedisLock', () => {
  test('is mutually exclusive; release frees it for the next acquirer', async () => {
    const lock = makeRedisLock(redis, 5000);
    const id = `inc-${randomUUID()}`;
    const t1 = await lock.acquire(id);
    expect(t1).toBeTruthy();
    // Held: a second acquire fails.
    expect(await lock.acquire(id)).toBeNull();
    await lock.release(id, t1!);
    // Freed: acquirable again.
    const t2 = await lock.acquire(id);
    expect(t2).toBeTruthy();
    await lock.release(id, t2!);
  });

  test('release with a stale token does not free another holder', async () => {
    const lock = makeRedisLock(redis, 5000);
    const id = `inc-${randomUUID()}`;
    const t1 = await lock.acquire(id);
    expect(t1).toBeTruthy();
    // An overran run releasing with the wrong token must be a no-op.
    await lock.release(id, 'stale-token');
    expect(await lock.acquire(id)).toBeNull(); // still held by t1
    await lock.release(id, t1!);
  });

  test('auto-expires after its TTL so a crashed holder cannot wedge the incident', async () => {
    const lock = makeRedisLock(redis, 100);
    const id = `inc-${randomUUID()}`;
    expect(await lock.acquire(id)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 150));
    // No explicit release: the TTL expired, so it is acquirable again.
    expect(await lock.acquire(id)).toBeTruthy();
    await redis.del(`engine:lock:${id}`);
  });
});
