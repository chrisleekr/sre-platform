import { incidents, jobs, makeDb, tenants, type DbHandle } from '@sre/db';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { Queue } from '../queue';

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

  const SUFFIX = randomUUID().slice(0, 8);

  const STREAM = `test:jobs:${SUFFIX}`;

  const DEAD = `${STREAM}:dead`;

  const TYPE = `test-${SUFFIX}`;

  const tenant = randomUUID();

  let db: DbHandle;

  let redis: Redis;

  let q: Queue;

  beforeAll(async () => {
    db = makeDb(ADMIN_URL);
    await db.db.insert(tenants).values({ id: tenant, name: `queue-${SUFFIX}` });
    redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null, lazyConnect: false });
    q = new Queue(db.db, redis, {
      stream: STREAM,
      deadStream: DEAD,
      group: 'workers',
      maxAttempts: 3,
    });
    await q.ensureGroup();
  }, 30_000);

  afterAll(async () => {
    await redis.del(STREAM, DEAD);
    await db.db.delete(jobs).where(eq(jobs.type, TYPE));
    // coalescing tests insert type='resume' rows for this tenant.
    await db.db.delete(jobs).where(sql`type = 'resume' and tenant_id = ${tenant}`);
    // coalescing tests insert type='runbook.generate' rows for this tenant.
    await db.db.delete(jobs).where(sql`type = 'runbook.generate' and tenant_id = ${tenant}`);
    await db.db
      .delete(jobs)
      .where(
        sql`type in ('signal.reassess', 'recovery.verify', 'cohort.analyze', 'relation.reassess') and tenant_id = ${tenant}`,
      );
    // poll tests insert type='poll' rows for this tenant.
    await db.db.delete(jobs).where(sql`type = 'poll' and tenant_id = ${tenant}`);
    await db.db.delete(incidents).where(eq(incidents.tenantId, tenant));
    await db.db.delete(tenants).where(eq(tenants.id, tenant));
    redis.disconnect();
    await db.close();
  });

  return {
    ADMIN_URL,
    VALKEY_URL,
    SUFFIX,
    STREAM,
    DEAD,
    TYPE,
    tenant,
    get db() {
      return db;
    },
    set db(value: typeof db) {
      db = value;
    },
    get redis() {
      return redis;
    },
    set redis(value: typeof redis) {
      redis = value;
    },
    get q() {
      return q;
    },
    set q(value: typeof q) {
      q = value;
    },
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
