import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { forwardedSourceAddress, makePublicRateLimiter } from '../rate-limit';

let redis: Redis;

beforeAll(() => {
  redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
});

afterAll(() => redis?.disconnect());

describe('public rate limiter', () => {
  test('trusts only the configured number of right-most forwarding hops', () => {
    expect(forwardedSourceAddress('10.0.0.4', '203.0.113.8, 10.0.0.3', 0)).toBe('10.0.0.4');
    expect(forwardedSourceAddress('10.0.0.4', '203.0.113.8', 1)).toBe('203.0.113.8');
    expect(forwardedSourceAddress('10.0.0.4', '203.0.113.8, 10.0.0.3', 2)).toBe('203.0.113.8');
    expect(forwardedSourceAddress('10.0.0.4', '203.0.113.8', 2)).toBe('10.0.0.4');
  });

  test('atomically accepts twenty requests and rejects the twenty-first across instances', async () => {
    const subject = randomUUID();
    const first = makePublicRateLimiter(redis);
    const secondRedis = redis.duplicate();
    const second = makePublicRateLimiter(secondRedis);
    try {
      const results = await Promise.all(
        Array.from({ length: 21 }, (_, index) =>
          (index % 2 === 0 ? first : second).allow('discovery-test', subject, 20, 60_000),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(20);
      expect(results.filter((allowed) => !allowed)).toHaveLength(1);
    } finally {
      secondRedis.disconnect();
    }
  });
});
