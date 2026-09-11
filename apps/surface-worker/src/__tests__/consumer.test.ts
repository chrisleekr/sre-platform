import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { HubMessage } from '@sre/hub';
import { ensureSurfaceGroup, surfaceStreamTick } from '../consumer';

const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';
const STREAM = `test:surface:${randomUUID().slice(0, 8)}`;
const GROUP = 'surface';

let redis: Redis;

beforeAll(async () => {
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
  await ensureSurfaceGroup(redis, STREAM, GROUP);
});

afterAll(async () => {
  await redis.del(STREAM);
  redis.disconnect();
});

const hubMsg = (id: string): HubMessage => ({
  id,
  incidentId: 'i1',
  author: 'agent',
  kind: 'text',
  content: 'hi',
  createdAt: 't',
});

describe('surfaceStreamTick', () => {
  test('delivers each entry once, acks it, and does not redeliver', async () => {
    await redis.xadd(STREAM, '*', 'msg', JSON.stringify(hubMsg('a')));
    await redis.xadd(STREAM, '*', 'msg', JSON.stringify(hubMsg('b')));

    const seen: string[] = [];
    const handled = await surfaceStreamTick(
      redis,
      { stream: STREAM, group: GROUP, consumer: 'c1' },
      async (m) => {
        seen.push(m.id);
        return true;
      },
    );
    expect(handled).toBe(2);
    expect(seen.sort()).toEqual(['a', 'b']);

    // A second pass finds nothing new and never redelivers the acked entries.
    const again = await surfaceStreamTick(
      redis,
      { stream: STREAM, group: GROUP, consumer: 'c1' },
      async () => {
        throw new Error('should not run');
      },
    );
    expect(again).toBe(0);
  });

  test('a throwing handler still acks (no poison-pill redelivery)', async () => {
    await redis.xadd(STREAM, '*', 'msg', JSON.stringify(hubMsg('c')));
    const first = await surfaceStreamTick(
      redis,
      { stream: STREAM, group: GROUP, consumer: 'c1' },
      async () => {
        throw new Error('boom');
      },
    );
    expect(first).toBe(1); // handled (acked) despite the throw

    const second = await surfaceStreamTick(
      redis,
      { stream: STREAM, group: GROUP, consumer: 'c1' },
      async () => {
        throw new Error('should not redeliver');
      },
    );
    expect(second).toBe(0);
  });
});

// --- delivery hardening: the tick honours a boolean handler (false = defer/leave pending),
// with a per-entry attempt counter (redis.incr) that acks after MAX_ATTEMPTS to avoid a poison loop.
// A fake redis lets us assert on xack/incr without a live server. ---

type Entry = [id: string, fields: string[]];

function fakeRedis(newEntries: Entry[], over: Partial<{ incr: ReturnType<typeof vi.fn> }> = {}) {
  return {
    xautoclaim: vi.fn(async () => ['0-0', [] as Entry[], [] as string[]]),
    xreadgroup: vi.fn(async () => (newEntries.length ? [[STREAM, newEntries]] : null)),
    xack: vi.fn(async () => 1),
    set: vi.fn(async () => 'OK'),
    incr: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    ...over,
  };
}

const entryOf = (id: string, msgId: string): Entry => [id, ['msg', JSON.stringify(hubMsg(msgId))]];
const opts = { stream: STREAM, group: GROUP, consumer: 'c1' };

describe('surfaceStreamTick handler contract', () => {
  test('does not ack an entry when the handler returns false (deferred)', async () => {
    const fake = fakeRedis([entryOf('1-0', 'd')]);
    await surfaceStreamTick(fake as never, opts, async () => false);
    expect(fake.xack).not.toHaveBeenCalled(); // left pending for XAUTOCLAIM
  });

  test('acks a deferred entry after MAX_ATTEMPTS (poison-loop guard)', async () => {
    // The per-entry retry counter has already reached the ceiling, so give up and ack.
    const fake = fakeRedis([entryOf('2-0', 'e')], { incr: vi.fn(async () => 5) });
    await surfaceStreamTick(fake as never, opts, async () => false);
    expect(fake.xack).toHaveBeenCalled();
  });

  test('acks normally when the handler returns true', async () => {
    const fake = fakeRedis([entryOf('3-0', 'f')]);
    await surfaceStreamTick(fake as never, opts, async () => true);
    expect(fake.xack).toHaveBeenCalledWith(STREAM, GROUP, '3-0');
  });
});
