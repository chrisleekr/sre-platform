// Live-Valkey test (mirrors queue.test.ts Redis setup): the snapshot cache round-trips a tenant's
// connector snapshots through a TTL'd Valkey key. No Postgres — the cache is Valkey-only.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { NormalizedSnapshot } from '@sre/connectors';
import { makeSnapshotCache } from '../snapshot-cache';

const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

const tenant = randomUUID();
let redis: Redis;

beforeAll(() => {
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null, lazyConnect: false });
});

afterAll(async () => {
  await redis.del(`snap:${tenant}:kubernetes`, `snap:${tenant}:gitlab`);
  redis.disconnect();
});

function snap(entityId: string): NormalizedSnapshot {
  return {
    tenantId: tenant,
    source: 'kubernetes',
    entityId,
    metrics: { restartCount: 3, ready: 0 },
    metadata: { kind: 'pod' },
    observedAt: new Date(),
  };
}

describe('SnapshotCache', () => {
  test('set then get round-trips the snapshots', async () => {
    const cache = makeSnapshotCache(redis);
    await cache.set(tenant, 'kubernetes', [snap('pod-a'), snap('pod-b')], 60);

    const got = await cache.get(tenant, 'kubernetes');
    expect(got).toHaveLength(2);
    expect(got.map((s) => s.entityId)).toEqual(['pod-a', 'pod-b']);
    expect(got[0]!.metrics.restartCount).toBe(3);
  });

  test('set applies the TTL', async () => {
    const cache = makeSnapshotCache(redis);
    await cache.set(tenant, 'kubernetes', [snap('pod-a')], 60);

    const ttl = await redis.ttl(`snap:${tenant}:kubernetes`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  test('a miss returns []', async () => {
    const cache = makeSnapshotCache(redis);
    expect(await cache.get(tenant, 'gitlab')).toEqual([]);
  });

  test('delete removes a source snapshot immediately', async () => {
    const cache = makeSnapshotCache(redis);
    await cache.set(tenant, 'kubernetes', [snap('pod-a')], 60);
    await cache.delete?.(tenant, 'kubernetes');
    expect(await cache.get(tenant, 'kubernetes')).toEqual([]);
  });

  test('isolates and deletes snapshot entries by connector generation', async () => {
    const cache = makeSnapshotCache(redis);
    const oldGeneration = { id: randomUUID(), lifecycleVersion: 1 };
    const newGeneration = { id: randomUUID(), lifecycleVersion: 0 };
    await cache.set(tenant, 'argocd', [snap('old')], 60, oldGeneration);
    await cache.set(tenant, 'argocd', [snap('new')], 60, newGeneration);
    expect((await cache.get(tenant, 'argocd', oldGeneration))[0]?.entityId).toBe('old');
    expect((await cache.get(tenant, 'argocd', newGeneration))[0]?.entityId).toBe('new');
    await cache.delete?.(tenant, 'argocd', oldGeneration);
    expect(await cache.get(tenant, 'argocd', oldGeneration)).toEqual([]);
    expect((await cache.get(tenant, 'argocd', newGeneration))[0]?.entityId).toBe('new');
    await cache.delete?.(tenant, 'argocd', newGeneration);
  });

  test('admits one distributed lease holder until the TTL expires', async () => {
    const cache = makeSnapshotCache(redis);
    const name = `argocd-test:${randomUUID()}`;
    await expect(cache.acquireLease?.(name, 1)).resolves.toBe(true);
    await expect(cache.acquireLease?.(name, 1)).resolves.toBe(false);
  });
});
