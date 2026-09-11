import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { Redis } from 'ioredis';
// the per-tenant, per-token Slack available-channels cache.
import { makeChannelsCache } from '../slack-channels-cache';

/** A Map-backed Redis double covering exactly what the cache uses: GET, and SET with an EX ttl. */
function fakeRedis(): Redis & { store: Map<string, string>; ttls: Map<string, number> } {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, ...args: unknown[]) {
      const ex = args.findIndex((a) => String(a).toUpperCase() === 'EX');
      if (ex >= 0) ttls.set(key, Number(args[ex + 1]));
      store.set(key, value);
      return 'OK';
    },
  } as unknown as Redis & { store: Map<string, string>; ttls: Map<string, number> };
}

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const TOKEN = 'xoxb-one';
const OTHER_TOKEN = 'xoxb-two';
const VALUE = { channels: [{ id: 'C0OPS', name: 'ops' }], truncated: false };

const keyFor = (tenantId: string, token: string): string =>
  `slack:channels:${tenantId}:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;

describe('makeChannelsCache', () => {
  test('a cold read is a MISS (null), not an empty list', async () => {
    const cache = makeChannelsCache(fakeRedis());
    // null is the miss signal: an empty-array return would be indistinguishable from a workspace where
    // the bot genuinely sees no channels, and the route would serve "no channels" forever.
    expect(await cache.get(TENANT_A, TOKEN)).toBeNull();
  });

  test('a cached EMPTY channel list is a HIT, and is served as-is', async () => {
    const cache = makeChannelsCache(fakeRedis());
    await cache.set(TENANT_A, TOKEN, { channels: [], truncated: false }, 300);
    expect(await cache.get(TENANT_A, TOKEN)).toEqual({ channels: [], truncated: false });
  });

  test('set → get round-trips the channels AND the truncation flag', async () => {
    const cache = makeChannelsCache(fakeRedis());
    await cache.set(TENANT_A, TOKEN, { ...VALUE, truncated: true }, 300);
    expect(await cache.get(TENANT_A, TOKEN)).toEqual({ ...VALUE, truncated: true });
  });

  test('the key is tenant-scoped: tenant B never reads tenant A’s channels', async () => {
    const redis = fakeRedis();
    const cache = makeChannelsCache(redis);
    await cache.set(TENANT_A, TOKEN, VALUE, 300);

    expect(await cache.get(TENANT_B, TOKEN)).toBeNull(); // a cross-tenant hit would leak A's channels
    expect([...redis.store.keys()]).toEqual([keyFor(TENANT_A, TOKEN)]);
  });

  // The list is DERIVED from the token, so it is part of the key: a tenant repointed at another Slack
  // workspace can never read the previous workspace's channels, and no delete/set ordering can race.
  test('the key is token-scoped: a new bot token cannot read the old token’s list', async () => {
    const cache = makeChannelsCache(fakeRedis());
    await cache.set(TENANT_A, TOKEN, VALUE, 300);
    expect(await cache.get(TENANT_A, OTHER_TOKEN)).toBeNull();
  });

  test('the token is HASHED into the key, never stored in it', async () => {
    const redis = fakeRedis();
    await makeChannelsCache(redis).set(TENANT_A, TOKEN, VALUE, 300);
    // A Valkey dump must not hand out a bot token.
    expect([...redis.store.keys()].join(' ')).not.toContain(TOKEN);
    expect([...redis.store.keys()]).toEqual([keyFor(TENANT_A, TOKEN)]);
  });

  test('the entry expires: set writes the TTL it was given', async () => {
    const redis = fakeRedis();
    await makeChannelsCache(redis).set(TENANT_A, TOKEN, VALUE, 300);
    // Without an EX the list would go stale forever, and a newly-invited channel would never appear.
    expect(redis.ttls.get(keyFor(TENANT_A, TOKEN))).toBe(300);
  });

  // A cache is an optimisation: a Valkey outage must degrade to "no cache", never fail the request.
  test('a Valkey outage is a MISS on read and a no-op on write, never a throw', async () => {
    const down = {
      get: async () => {
        throw new Error('valkey down');
      },
      set: async () => {
        throw new Error('valkey down');
      },
    } as unknown as Redis;
    const cache = makeChannelsCache(down);

    await expect(cache.get(TENANT_A, TOKEN)).resolves.toBeNull(); // the route then reads Slack
    await expect(cache.set(TENANT_A, TOKEN, VALUE, 300)).resolves.toBeUndefined();
  });

  test('a corrupt entry reads as a MISS rather than throwing', async () => {
    const redis = fakeRedis();
    redis.store.set(keyFor(TENANT_A, TOKEN), 'not json');
    expect(await makeChannelsCache(redis).get(TENANT_A, TOKEN)).toBeNull();
  });
});
