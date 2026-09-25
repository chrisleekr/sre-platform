import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { makeDb, jobs, type DbHandle } from '@sre/db';
import { Queue } from '../queue';

// A StatusCake wakeup is a one-shot poll job that carries the only copy of its notification. When
// its post-commit XADD fails, enqueue swallows the error, so the poll stream's own reconcile is the
// only path that ever dispatches the row.
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

// The production binding from both apps' entrypoints. No other test touches this stream.
const POLL_STREAM = 'sre:jobs:poll';
const TYPE = `poll-wakeup-test-${randomUUID().slice(0, 8)}`;

let db: DbHandle;
let redis: Redis;

beforeAll(() => {
  db = makeDb(ADMIN_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null, lazyConnect: false });
});

afterAll(async () => {
  await redis.del(POLL_STREAM);
  await db.db.delete(jobs).where(eq(jobs.type, TYPE));
  redis.disconnect();
  await db.close();
});

describe('poll queue reconcile', () => {
  test('a wakeup whose XADD failed stays queued with no stream entry until pollQueue.reconcile dispatches it', async () => {
    const failing = new Redis(VALKEY_URL, { maxRetriesPerRequest: null, lazyConnect: false });
    (failing as unknown as { xadd: () => Promise<never> }).xadd = () =>
      Promise.reject(new Error('valkey unavailable'));
    try {
      const writer = new Queue(db.db, failing, { stream: POLL_STREAM, group: 'poll' });
      const jobId = await writer.enqueue({
        tenantId: randomUUID(),
        type: TYPE,
        payload: { wakeup: true },
      });

      const [lost] = await db.db.select().from(jobs).where(eq(jobs.id, jobId));
      expect(lost?.status).toBe('queued');
      expect(lost?.stream).toBe(POLL_STREAM);
      expect(lost?.streamId).toBeNull();
      const before = await redis.xrange(POLL_STREAM, '-', '+');
      expect(before.some(([, fields]) => fields.includes(jobId))).toBe(false);

      const pollQueue = new Queue(db.db, redis, { stream: POLL_STREAM, group: 'poll' });
      expect(await pollQueue.reconcile()).toBeGreaterThanOrEqual(1);

      const [recovered] = await db.db.select().from(jobs).where(eq(jobs.id, jobId));
      expect(recovered?.status).toBe('queued');
      expect(recovered?.streamId).not.toBeNull();
      const entries = await redis.xrange(POLL_STREAM, '-', '+');
      expect(entries.some(([, fields]) => fields.includes(jobId))).toBe(true);
    } finally {
      failing.disconnect();
    }
  });
});
