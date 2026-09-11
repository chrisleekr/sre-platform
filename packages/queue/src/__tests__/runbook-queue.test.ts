import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { makeDb, jobs, type DbHandle } from '@sre/db';
import { Queue } from '../queue';
import {
  makeRunbookQueue,
  RUNBOOK_STREAM,
  RUNBOOK_GROUP,
  RUNBOOK_DEAD_STREAM,
} from '../runbook-queue';

// the dedicated runbook-generation stream, isolated from triage (sre:jobs) and classify
// (sre:classify) so a runbook backlog cannot head-of-line-block triage. RED now: ./runbook-queue does
// not exist, so the whole module fails to load. Enqueue writes the durable Postgres jobs row
// stamped with the bound stream BEFORE the XADD (Postgres source-of-truth).
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

const SUFFIX = randomUUID().slice(0, 8);
const TYPE = `runbook-test-${SUFFIX}`;
const tenant = randomUUID();

// Per-run suffixed stream name for all Valkey I/O; the pinned production const is asserted as pure
// equality only, so a test never touches the real sre:runbook on the shared Valkey (queue.test.ts /
// classify-queue.test.ts convention).
const runbookStream = `test:runbook:${SUFFIX}`;
const runbookGroup = `runbook-workers-${SUFFIX}`;
const runbookDead = `${runbookStream}:dead`;

let db: DbHandle;
let redis: Redis;
let queue: Queue;

beforeAll(async () => {
  db = makeDb(ADMIN_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  queue = new Queue(db.db, redis, {
    stream: runbookStream,
    group: runbookGroup,
    deadStream: runbookDead,
  });
  await queue.ensureGroup();
}, 30_000);

afterAll(async () => {
  await redis.del(runbookStream, runbookDead);
  await db.db.delete(jobs).where(eq(jobs.type, TYPE));
  redis.disconnect();
  await db.close();
});

describe('runbook queue', () => {
  test('makeRunbookQueue binds sre:runbook / runbook-workers / sre:runbook:dead and stamps stream on enqueue', async () => {
    expect(RUNBOOK_STREAM).toBe('sre:runbook');
    expect(RUNBOOK_GROUP).toBe('runbook-workers');
    expect(RUNBOOK_DEAD_STREAM).toBe('sre:runbook:dead');
    expect(makeRunbookQueue(db.db, redis)).toBeInstanceOf(Queue);

    const id = await queue.enqueue({
      tenantId: tenant,
      type: TYPE,
      payload: { incidentId: randomUUID(), requestedBy: 'u1' },
    });
    const row = (await db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.stream).toBe(runbookStream); // Enqueue stamps the queue's bound stream
    expect(row.status).toBe('queued');
    expect(row.tenantId).toBe(tenant);
  });
});
