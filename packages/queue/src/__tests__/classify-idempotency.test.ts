import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { jobs, makeDb, type DbHandle } from '@sre/db';
import { and, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { Queue } from '../queue';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';
const suffix = randomUUID().slice(0, 8);
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const stream = `test:classify-idempotency:${suffix}`;
const deadStream = `${stream}:dead`;

let db: DbHandle;
let redis: Redis;
let queue: Queue;

function candidate(overrides: { intakeId?: string; eventKey?: string } = {}) {
  return {
    kind: 'root' as const,
    intakeId: overrides.intakeId ?? randomUUID(),
    eventKey: overrides.eventKey ?? `slack:C-alerts:${randomUUID()}`,
    channel: 'C-alerts',
    externalId: '1788200000.000001',
  };
}

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  db = makeDb(DATABASE_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  queue = new Queue(db.db, redis, {
    stream,
    group: `classify-idempotency-${suffix}`,
    deadStream,
  });
  await queue.ensureGroup();
}, 30_000);

afterAll(async () => {
  await db.db.delete(jobs).where(inArray(jobs.tenantId, [tenantId, otherTenantId]));
  await redis.del(stream, deadStream);
  redis.disconnect();
  await db.close();
});

describe('durable classify idempotency', () => {
  test('uses an existing admission transaction without opening a nested connection', async () => {
    const payload = candidate();
    const [first, retry] = await db.db.transaction(async (tx) => {
      const inserted = await queue.insertClassifyTx(tx, {
        tenantId,
        type: 'classify',
        payload,
      });
      const duplicate = await queue.insertClassifyTx(tx, {
        tenantId,
        type: 'classify',
        payload,
      });
      return [inserted, duplicate] as const;
    });

    expect(first).toMatchObject({ inserted: true, matchedBy: null });
    expect(retry).toEqual({ jobId: first.jobId, inserted: false, matchedBy: 'intake' });
  });

  test('a retry after durable insert but before dispatch recovers the same job', async () => {
    const payload = candidate();
    const first = await queue.insertClassify({ tenantId, type: 'classify', payload });
    const beforeRetry = await db.db.select().from(jobs).where(eq(jobs.id, first.jobId));

    expect(first).toMatchObject({ inserted: true, matchedBy: null });
    expect(beforeRetry[0]).toMatchObject({ status: 'queued', streamId: null });

    const retry = await queue.insertClassify({ tenantId, type: 'classify', payload });
    expect(retry).toEqual({ jobId: first.jobId, inserted: false, matchedBy: 'intake' });

    await queue.publishJob(retry.jobId);
    const handled: string[] = [];
    await queue.process('recovered', async (job) => {
      handled.push(job.id);
    });
    expect(handled).toEqual([first.jobId]);
  });

  test('two receipts for one provider event share its durable classify job', async () => {
    const eventKey = `slack:C-alerts:${randomUUID()}`;
    const first = await queue.insertClassify({
      tenantId,
      type: 'classify',
      payload: candidate({ eventKey }),
    });
    const duplicate = await queue.insertClassify({
      tenantId,
      type: 'classify',
      payload: candidate({ eventKey }),
    });

    expect(duplicate).toEqual({ jobId: first.jobId, inserted: false, matchedBy: 'event' });
    const rows = await db.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.eventKey, eventKey)));
    expect(rows).toEqual([{ id: first.jobId }]);
  });

  test('a distinct provider event remains independent', async () => {
    const first = await queue.insertClassify({
      tenantId,
      type: 'classify',
      payload: candidate(),
    });
    const second = await queue.insertClassify({
      tenantId,
      type: 'classify',
      payload: candidate(),
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(second.jobId).not.toBe(first.jobId);
  });

  test('receipt and provider-event identities are isolated by tenant', async () => {
    const intakeId = randomUUID();
    const eventKey = `slack:C-alerts:${randomUUID()}`;
    const payload = candidate({ intakeId, eventKey });
    const first = await queue.insertClassify({ tenantId, type: 'classify', payload });
    const second = await queue.insertClassify({
      tenantId: otherTenantId,
      type: 'classify',
      payload,
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(second.jobId).not.toBe(first.jobId);
    const rows = await db.db
      .select({ tenantId: jobs.tenantId, id: jobs.id })
      .from(jobs)
      .where(
        and(
          inArray(jobs.tenantId, [tenantId, otherTenantId]),
          eq(jobs.idempotencyKey, intakeId),
          eq(jobs.eventKey, eventKey),
        ),
      );
    expect(new Set(rows.map((row) => row.tenantId))).toEqual(new Set([tenantId, otherTenantId]));
  });
});
