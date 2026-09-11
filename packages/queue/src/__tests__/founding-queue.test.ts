import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  jobs,
  makeDb,
  tenants,
  scheduleWorkspaceDeletion,
  cancelWorkspaceDeletion,
  purgeWorkspaceIfDue,
  type DbHandle,
} from '@sre/db';
import {
  FOUNDING_JOB_STREAM,
  FOUNDING_JOB_TYPE,
  makeFoundingQueue,
  SYSTEM_TENANT_ID,
  TENANT_PURGE_JOB_TYPE,
} from '../founding-queue';

let db: DbHandle;
let redis: Redis;
const jobIds = new Set<string>();

beforeAll(() => {
  db = makeDb(process.env.DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { db: 12, maxRetriesPerRequest: null });
});

afterAll(async () => {
  for (const id of jobIds) await db.db.delete(jobs).where(eq(jobs.id, id));
  await redis.del(FOUNDING_JOB_STREAM, 'sre:founding:dead');
  redis.disconnect();
  await db.close();
});

describe('founding queue', () => {
  test('overlapping deletion requests retain one deadline and cancellation retires the same job', async () => {
    const tenantId = randomUUID();
    const queue = makeFoundingQueue(db.db, redis);
    const now = new Date();
    await db.db
      .insert(tenants)
      .values({ id: tenantId, name: 'Delete twice', slug: `delete-${tenantId}` });
    try {
      const results = await Promise.all([
        scheduleWorkspaceDeletion(db.db, tenantId, queue.insertTenantPurgeTx.bind(queue), now),
        scheduleWorkspaceDeletion(
          db.db,
          tenantId,
          queue.insertTenantPurgeTx.bind(queue),
          new Date(now.getTime() + 60_000),
        ),
      ]);
      for (const result of results) jobIds.add(result.purge.jobId);
      expect(results[0]!.purge.jobId).toBe(results[1]!.purge.jobId);
      expect(results[0]!.workspace.deleteAfter).toEqual(results[1]!.workspace.deleteAfter);
      const [stored] = await db.db.select().from(jobs).where(eq(jobs.id, results[0]!.purge.jobId));
      expect(stored!.availableAt).toEqual(results[0]!.workspace.deleteAfter);
      await cancelWorkspaceDeletion(db.db, tenantId);
      expect(
        await purgeWorkspaceIfDue(db.db, tenantId, new Date(now.getTime() + 15 * 86_400_000)),
      ).toBe('not_due');
      expect(await db.db.select().from(jobs).where(eq(jobs.id, stored!.id))).toMatchObject([
        { status: 'done' },
      ]);
    } finally {
      await db.db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  });

  test('stores the founding id as durable idempotency and reuses the live job', async () => {
    const foundingId = randomUUID();
    const queue = makeFoundingQueue(db.db, redis);
    const first = await db.db.transaction((tx) => queue.insertProvisionTx(tx, foundingId));
    jobIds.add(first.jobId);
    expect(first.created).toBe(true);
    expect(await db.db.select().from(jobs).where(eq(jobs.id, first.jobId))).toMatchObject([
      {
        tenantId: SYSTEM_TENANT_ID,
        type: FOUNDING_JOB_TYPE,
        idempotencyKey: foundingId,
        stream: FOUNDING_JOB_STREAM,
        status: 'queued',
      },
    ]);
    const second = await db.db.transaction((tx) => queue.insertProvisionTx(tx, foundingId));
    expect(second).toEqual({ jobId: first.jobId, created: false });
  });

  test('keeps one workspace purge durable and undispatched until its grace period expires', async () => {
    const tenantId = randomUUID();
    const availableAt = new Date(Date.now() + 60_000);
    const queue = makeFoundingQueue(db.db, redis);
    const first = await db.db.transaction((tx) =>
      queue.insertTenantPurgeTx(tx, tenantId, availableAt),
    );
    jobIds.add(first.jobId);
    expect(first.created).toBe(true);
    expect(await db.db.select().from(jobs).where(eq(jobs.id, first.jobId))).toMatchObject([
      {
        tenantId: SYSTEM_TENANT_ID,
        type: TENANT_PURGE_JOB_TYPE,
        payload: { tenantId },
        idempotencyKey: `tenant.purge:${tenantId}`,
        status: 'queued',
        streamId: null,
      },
    ]);
    await queue.publishJob(first.jobId);
    expect(await redis.xlen(FOUNDING_JOB_STREAM)).toBe(0);
    const second = await db.db.transaction((tx) =>
      queue.insertTenantPurgeTx(tx, tenantId, availableAt),
    );
    expect(second).toEqual({ jobId: first.jobId, created: false });
  });
});
