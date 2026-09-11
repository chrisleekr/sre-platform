import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { makeRevokePublisher, SessionRegistry } from '../auth/revoke';

const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

let publisherRedis: Redis;

beforeAll(async () => {
  publisherRedis = new Redis(VALKEY_URL, { db: 12, maxRetriesPerRequest: null });
  await publisherRedis.flushdb();
});

afterAll(() => {
  publisherRedis?.disconnect();
});

describe('cross-replica session revocation', () => {
  test('publisher failures remain best effort', async () => {
    const failingRedis = {
      publish: vi.fn().mockRejectedValue(new Error('Valkey unavailable')),
    } as unknown as Redis;

    await expect(
      makeRevokePublisher(failingRedis).publish({ userId: randomUUID() }),
    ).resolves.toBeUndefined();
  });

  test('closes matching sessions on two replicas and deregisters idempotently', async () => {
    const firstSubscriber = new Redis(VALKEY_URL, { db: 12, maxRetriesPerRequest: null });
    const secondSubscriber = new Redis(VALKEY_URL, { db: 12, maxRetriesPerRequest: null });
    const first = new SessionRegistry();
    const second = new SessionRegistry();
    await Promise.all([first.start(firstSubscriber), second.start(secondSubscriber)]);
    const publish = makeRevokePublisher(publisherRedis);
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const otherTenantClose = vi.fn();
    const otherUserClose = vi.fn();
    const unregister = first.register(userId, tenantId, firstClose);
    second.register(userId, tenantId, secondClose);
    second.register(userId, otherTenantId, otherTenantClose);
    second.register(otherUserId, tenantId, otherUserClose);

    await publish.publish({ userId, tenantId });
    await expect.poll(() => firstClose.mock.calls.length, { timeout: 1_000 }).toBe(1);
    await expect.poll(() => secondClose.mock.calls.length, { timeout: 1_000 }).toBe(1);
    expect(firstClose).toHaveBeenCalledWith(1008, 'signed out');
    expect(secondClose).toHaveBeenCalledWith(1008, 'signed out');
    expect(otherTenantClose).not.toHaveBeenCalled();
    expect(otherUserClose).not.toHaveBeenCalled();

    unregister();
    unregister();
    await publish.publish({ userId });
    await expect.poll(() => otherTenantClose.mock.calls.length, { timeout: 1_000 }).toBe(1);
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(otherUserClose).not.toHaveBeenCalled();

    firstSubscriber.disconnect();
    secondSubscriber.disconnect();
  });
});
