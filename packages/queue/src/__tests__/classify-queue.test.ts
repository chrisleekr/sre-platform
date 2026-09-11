import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import { makeDb, jobs, type DbHandle } from '@sre/db';
import { Queue } from '../queue';
import {
  makeClassifyQueue,
  ClassifyQueue,
  CLASSIFY_STREAM,
  CLASSIFY_GROUP,
  CLASSIFY_DEAD_STREAM,
} from '../classify-queue';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

const SUFFIX = randomUUID().slice(0, 8);
const TYPE = `classify-test-${SUFFIX}`;
const tenant = randomUUID();

// Per-run suffixed stream names for all Valkey I/O. The pinned production consts (sre:classify,
// sre:jobs) are asserted as pure equality only — a test must never ensureGroup/enqueue/del a real
// stream on the shared Valkey, or it would drop live work once a classify producer/consumer lands
// (the queue.test.ts convention). Reconcile scoping is name-agnostic, so
// suffixed names prove it exactly as the real names would.
const classifyStream = `test:classify:${SUFFIX}`;
const classifyGroup = `classify-workers-${SUFFIX}`;
const classifyDead = `${classifyStream}:dead`;
const triageStream = `test:jobs:${SUFFIX}`;
const triageGroup = `workers-${SUFFIX}`;
const triageDead = `${triageStream}:dead`;

let db: DbHandle;
let redis: Redis;
let classifyQueue: Queue;

beforeAll(async () => {
  db = makeDb(ADMIN_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  classifyQueue = new Queue(db.db, redis, {
    stream: classifyStream,
    group: classifyGroup,
    deadStream: classifyDead,
  });
  await classifyQueue.ensureGroup();
}, 30_000);

afterAll(async () => {
  await redis.del(classifyStream, classifyDead, triageStream, triageDead);
  await db.db.delete(jobs).where(eq(jobs.type, TYPE));
  redis.disconnect();
  await db.close();
});

describe('classify queue isolation', () => {
  // The factory pins the production identifiers (rename guard) and returns a Queue that stamps
  // its bound stream on enqueue. The binding proof runs on a per-run stream to avoid touching the
  // real sre:classify on the shared Valkey; the const-equality asserts the pinned names themselves.
  test('makeClassifyQueue binds sre:classify / classify-workers / sre:classify:dead', async () => {
    expect(CLASSIFY_STREAM).toBe('sre:classify');
    expect(CLASSIFY_GROUP).toBe('classify-workers');
    expect(CLASSIFY_DEAD_STREAM).toBe('sre:classify:dead');
    expect(makeClassifyQueue(db.db, redis)).toBeInstanceOf(Queue);

    const id = await classifyQueue.enqueue({ tenantId: tenant, type: TYPE, payload: { n: 1 } });
    const row = (await db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.stream).toBe(classifyStream); // enqueue stamps the queue's bound stream
  });

  // The classify reconciler is stream-scoped — a stuck foreign (triage) row is not scooped.
  test('classifyQueue.reconcile(0) leaves a foreign triage-stream queued row untouched', async () => {
    const inserted = await db.db
      .insert(jobs)
      .values({ tenantId: tenant, type: TYPE, payload: {}, status: 'queued', stream: triageStream })
      .returning({ id: jobs.id });
    const id = inserted[0]!.id;

    await classifyQueue.reconcile(0); // bound to classifyStream

    const row = (await db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.status).toBe('queued'); // never re-dispatched by the classify reconciler
    expect(row.streamId).toBeNull(); // still no stream entry: untouched
  });

  // Opposite direction — the triage reconciler must not scoop a stuck classify row.
  test('triageQueue.reconcile(0) leaves a classify-stream queued row untouched (opposite direction)', async () => {
    const triageQueue = new Queue(db.db, redis, {
      stream: triageStream,
      group: triageGroup,
      deadStream: triageDead,
    });

    const inserted = await db.db
      .insert(jobs)
      .values({
        tenantId: tenant,
        type: TYPE,
        payload: {},
        status: 'queued',
        stream: classifyStream,
      })
      .returning({ id: jobs.id });
    const id = inserted[0]!.id;

    await triageQueue.reconcile(0); // bound to triageStream

    const row = (await db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.status).toBe('queued');
    expect(row.streamId).toBeNull();
  });

  // A classify backlog cannot head-of-line-block triage — a triage consumer only sees its stream.
  test('triage consumer dequeues only its own stream (no head-of-line block from classify backlog)', async () => {
    expect(CLASSIFY_STREAM).not.toBe('sre:jobs');
    expect(CLASSIFY_GROUP).not.toBe('workers');

    const triageQueue = new Queue(db.db, redis, {
      stream: triageStream,
      group: triageGroup,
      deadStream: triageDead,
    });
    await triageQueue.ensureGroup();

    const classifyId = await classifyQueue.enqueue({
      tenantId: tenant,
      type: TYPE,
      payload: { kind: 'classify' },
    });
    const triageId = await triageQueue.enqueue({
      tenantId: tenant,
      type: TYPE,
      payload: { kind: 'triage' },
    });

    const handled: string[] = [];
    await triageQueue.process('c1', async (job) => {
      handled.push(job.id);
    });

    // The triage consumer handled ONLY its own job; the classify job was never delivered to it.
    expect(handled).toEqual([triageId]);
    expect(handled).not.toContain(classifyId);
  });
});

// per-tenant FAIR scheduling on the shared classify stream. The stream entry is a {jobId}
// doorbell; the Postgres `jobs` row is the durable authority, so fairness is a row-
// SELECTION decision. ClassifyQueue's fair-select runs on every delivery (least-recently-served
// tenant, then that tenant's oldest queued row), claimed atomically with FOR UPDATE SKIP LOCKED.
//
// C1 and C2 below are the anti-starvation and alternation properties the override exists to satisfy: they FAILED
// against the base FIFO Queue (the TDD start state — B starved behind A's flood, order [a,a,b,b]) and
// pass now that freshFairQueue builds a ClassifyQueue. C3/C4/C6/C7 assert properties the base Queue
// already satisfied (created_at order, reconcile durability, stream scoping, atomic no-double-
// claim); they lock the override against regressing them.
describe('classify fair-scheduling', () => {
  const FAIR_TYPE = `classify-fair-${SUFFIX}`;
  const createdFairStreams: string[] = [];
  type Seen = { id: string; tenantId: string };

  // ClassifyQueue carries the fair-select override; a per-run suffixed stream keeps the shared
  // Valkey's real sre:classify untouched (the file convention; a test must never enqueue on a real
  // stream). ClassifyQueue extends Queue and so accepts the QueueOptions stream override.
  async function freshFairQueue(): Promise<{ q: Queue; stream: string }> {
    const s = randomUUID().slice(0, 8);
    const stream = `test:classify:fair:${s}`;
    const deadStream = `${stream}:dead`;
    createdFairStreams.push(stream, deadStream);
    const q = new ClassifyQueue(db.db, redis, { stream, group: `classify-fair-${s}`, deadStream });
    await q.ensureGroup();
    return { q, stream };
  }

  // Drive one fair selection at a time (count:1) with a single consumer (idleMs:0 is safe for a lone
  // consumer's reclaim), recording each claimed job's id + tenant to observe SELECTION ORDER. Doorbell
  // and row counts stay 1:1, so N enqueued rows drain in N process() calls regardless of which doorbell
  // maps to which claimed row.
  async function drain(q: Queue, order: Seen[], maxCalls = 12): Promise<void> {
    for (let i = 0; i < maxCalls; i++) {
      const n = await q.process(
        'c',
        async (job) => {
          order.push({ id: job.id, tenantId: job.tenantId });
        },
        { count: 1, idleMs: 0 },
      );
      if (n === 0) break;
    }
  }

  afterAll(async () => {
    await db.db.delete(jobs).where(eq(jobs.type, FAIR_TYPE));
    if (createdFairStreams.length > 0) await redis.del(...createdFairStreams);
  });

  // THE RED KEYSTONE. Tenant A floods (x3), tenant B enqueues one AFTER. Base FIFO drains
  // A1,A2,A3 before B (B at index 3), starving B. Fair scheduling serves the least-recently-served
  // tenant, so B runs after AT MOST ONE of A's jobs.
  test('fair scheduling lets tenant B run before more than one of A flood is processed (C1 anti-starvation)', async () => {
    const { q } = await freshFairQueue();
    const a = randomUUID();
    const b = randomUUID();
    await q.enqueue({ tenantId: a, type: FAIR_TYPE, payload: { t: 'a', n: 1 } });
    await q.enqueue({ tenantId: a, type: FAIR_TYPE, payload: { t: 'a', n: 2 } });
    await q.enqueue({ tenantId: a, type: FAIR_TYPE, payload: { t: 'a', n: 3 } });
    await q.enqueue({ tenantId: b, type: FAIR_TYPE, payload: { t: 'b', n: 1 } });

    const order: Seen[] = [];
    await drain(q, order);

    expect(order).toHaveLength(4); // work-conserving: every queued job drained
    const bIndex = order.findIndex((e) => e.tenantId === b);
    expect(bIndex).toBeGreaterThanOrEqual(0); // B actually ran — guards a vacuous -1 <= 1 pass
    // Only tenants A and B are present, so bIndex == the number of A's processed before B. Base FIFO
    // makes this 3 (RED). Fair select makes it <= 1 (GREEN after the override).
    expect(bIndex).toBeLessThanOrEqual(1);
  });

  // Alternation. Enqueue ALL of A then ALL of B; FIFO drains [a,a,b,b]. Fair alternates by
  // least-recently-served (A1 is oldest so wins the first unserved tie), giving [a,b,a,b].
  test('fair scheduling alternates two backlogged tenants least-recently-served regardless of enqueue order (C2)', async () => {
    const { q } = await freshFairQueue();
    const a = randomUUID();
    const b = randomUUID();
    await q.enqueue({ tenantId: a, type: FAIR_TYPE, payload: { n: 1 } });
    await q.enqueue({ tenantId: a, type: FAIR_TYPE, payload: { n: 2 } });
    await q.enqueue({ tenantId: b, type: FAIR_TYPE, payload: { n: 1 } });
    await q.enqueue({ tenantId: b, type: FAIR_TYPE, payload: { n: 2 } });

    const order: Seen[] = [];
    await drain(q, order);

    expect(order).toHaveLength(4);
    expect(order.map((e) => e.tenantId)).toEqual([a, b, a, b]); // RED on base FIFO: [a,a,b,b]
  });

  // Work-conserving. A single backlogged tenant drains continuously in created_at order with no
  // artificial gap. Fair scheduling must not stall a tenant that is the only one with work.
  test('fair scheduling drains a single backlogged tenant continuously in created_at order (C3 work-conserving)', async () => {
    const { q } = await freshFairQueue();
    const a = randomUUID();
    const ids: string[] = [];
    for (let n = 0; n < 4; n++) {
      ids.push(await q.enqueue({ tenantId: a, type: FAIR_TYPE, payload: { n } }));
    }

    const order: Seen[] = [];
    await drain(q, order);

    expect(order.map((e) => e.id)).toEqual(ids); // exact created_at order, no reorder, no gap
  });

  // Durability backstop. A queued classify row whose doorbell was never written (crash before
  // XADD, or a fair-select that lost the claim race and left the row queued) is recovered by
  // reconcile() re-delivering a doorbell, and then runs to done. No lost job. (C7 covers the SKIP
  // LOCKED no-double-claim property directly.)
  test('a lost classify claim leaves the row queued and reconcile re-delivers it to done (C4 durability)', async () => {
    const { q, stream } = await freshFairQueue();
    const a = randomUUID();
    const inserted = await db.db
      .insert(jobs)
      .values({ tenantId: a, type: FAIR_TYPE, payload: {}, status: 'queued', stream })
      .returning({ id: jobs.id });
    const id = inserted[0]!.id;

    expect(await q.reconcile(0)).toBeGreaterThanOrEqual(1); // re-doorbells the stranded queued row

    const order: Seen[] = [];
    await drain(q, order);
    expect(order.map((e) => e.id)).toContain(id);
    expect((await db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!.status).toBe('done');
  });

  // Window semantics. A served row OLDER than fairnessWindowSec is dropped from the `served` CTE,
  // so that tenant has no last_served, sorts NULLS FIRST, and is treated as never-served. This is the
  // falsifiable guard for the `updated_at >= now() - make_interval(...)` predicate: seed A served 2h
  // ago and B served 3h ago (both outside a 1s window -> both NULL -> created_at tiebreak picks A, the
  // earlier-queued). Delete the window predicate and both served rows re-enter: B's 3h-old time sorts
  // ahead of A's 2h-old time and B is picked first, flipping this assertion. Explicit past timestamps,
  // no real waits.
  test('fair scheduling treats a served row older than the window as never-served (C5 window semantics)', async () => {
    const s = randomUUID().slice(0, 8);
    const stream = `test:classify:fair:${s}`;
    const deadStream = `${stream}:dead`;
    createdFairStreams.push(stream, deadStream);
    const q = new ClassifyQueue(db.db, redis, {
      stream,
      group: `classify-fair-${s}`,
      deadStream,
      fairnessWindowSec: 1,
    });
    await q.ensureGroup();

    const a = randomUUID();
    const b = randomUUID();
    // Served history OUTSIDE the 1s window for both tenants -> both drop out of `served` -> both NULL.
    await db.db.insert(jobs).values({
      tenantId: a,
      type: FAIR_TYPE,
      payload: {},
      status: 'done',
      stream,
      updatedAt: sql`now() - interval '2 hours'`,
    });
    await db.db.insert(jobs).values({
      tenantId: b,
      type: FAIR_TYPE,
      payload: {},
      status: 'done',
      stream,
      updatedAt: sql`now() - interval '3 hours'`,
    });
    // Queued work for each; A's row is created EARLIER, so with both served rows nulled by the window
    // the created_at tiebreak favours A.
    const aInserted = await db.db
      .insert(jobs)
      .values({
        tenantId: a,
        type: FAIR_TYPE,
        payload: { t: 'a' },
        status: 'queued',
        stream,
        createdAt: sql`now() - interval '10 seconds'`,
      })
      .returning({ id: jobs.id });
    await db.db.insert(jobs).values({
      tenantId: b,
      type: FAIR_TYPE,
      payload: { t: 'b' },
      status: 'queued',
      stream,
      createdAt: sql`now() - interval '5 seconds'`,
    });
    const aQueuedId = aInserted[0]!.id;

    // Direct inserts have no stream entry, so reconcile doorbells the queued rows; then take ONE pick.
    await q.reconcile(0);
    const order: Seen[] = [];
    await q.process(
      'c',
      async (job) => {
        order.push({ id: job.id, tenantId: job.tenantId });
      },
      { count: 1, idleMs: 0 },
    );

    expect(order).toHaveLength(1);
    expect(order[0]!.id).toBe(aQueuedId); // A's 2h-old served row is outside the window -> A preferred
    expect(order[0]!.tenantId).toBe(a);
  });

  test('an existing queue resolves the current fairness window for each later delivery', async () => {
    const s = randomUUID().slice(0, 8);
    const stream = `test:classify:fair:${s}`;
    const deadStream = `${stream}:dead`;
    createdFairStreams.push(stream, deadStream);
    let windowSec = 1;
    const getFairnessWindowSec = vi.fn(async () => windowSec);
    const q = new ClassifyQueue(db.db, redis, {
      stream,
      group: `classify-fair-${s}`,
      deadStream,
      getFairnessWindowSec,
    });
    await q.ensureGroup();

    const seedPair = async (): Promise<{ earlierTenant: string; olderServedTenant: string }> => {
      const earlierTenant = randomUUID();
      const olderServedTenant = randomUUID();
      await db.db.insert(jobs).values([
        {
          tenantId: earlierTenant,
          type: FAIR_TYPE,
          payload: {},
          status: 'done',
          stream,
          updatedAt: sql`now() - interval '2 hours'`,
        },
        {
          tenantId: olderServedTenant,
          type: FAIR_TYPE,
          payload: {},
          status: 'done',
          stream,
          updatedAt: sql`now() - interval '3 hours'`,
        },
      ]);
      await db.db.insert(jobs).values([
        {
          tenantId: earlierTenant,
          type: FAIR_TYPE,
          payload: {},
          status: 'queued',
          stream,
          createdAt: sql`now() - interval '10 seconds'`,
        },
        {
          tenantId: olderServedTenant,
          type: FAIR_TYPE,
          payload: {},
          status: 'queued',
          stream,
          createdAt: sql`now() - interval '5 seconds'`,
        },
      ]);
      await q.reconcile(0);
      return { earlierTenant, olderServedTenant };
    };

    const first = await seedPair();
    const firstOrder: Seen[] = [];
    getFairnessWindowSec.mockClear();
    await q.process(
      'c',
      async (job) => {
        firstOrder.push({ id: job.id, tenantId: job.tenantId });
      },
      { count: 1, idleMs: 0 },
    );
    expect(getFairnessWindowSec).toHaveBeenCalledTimes(1);
    expect(firstOrder[0]!.tenantId).toBe(first.earlierTenant);
    await drain(q, []);

    windowSec = 20_000;
    const second = await seedPair();
    const secondOrder: Seen[] = [];
    getFairnessWindowSec.mockClear();
    await q.process(
      'c',
      async (job) => {
        secondOrder.push({ id: job.id, tenantId: job.tenantId });
      },
      { count: 1, idleMs: 0 },
    );
    expect(getFairnessWindowSec).toHaveBeenCalledTimes(1);

    expect(secondOrder[0]!.tenantId).toBe(second.olderServedTenant);
  });

  // Stream isolation. The fair-select considers ONLY WHERE stream = classify. A queued row
  // on a foreign (triage-style) stream, even same tenant, is never selected by the classify consumer.
  test('classify fair-select never selects a foreign non-classify stream row (C6 isolation)', async () => {
    const { q } = await freshFairQueue();
    const fs = randomUUID().slice(0, 8);
    const foreignStream = `test:jobs:foreign:${fs}`;
    const foreignDead = `${foreignStream}:dead`;
    createdFairStreams.push(foreignStream, foreignDead);
    const foreignQueue = new Queue(db.db, redis, {
      stream: foreignStream,
      group: `workers-${fs}`,
      deadStream: foreignDead,
    });
    await foreignQueue.ensureGroup();

    const t = randomUUID();
    const foreignId = await foreignQueue.enqueue({
      tenantId: t,
      type: FAIR_TYPE,
      payload: { kind: 'foreign' },
    });
    const classifyId = await q.enqueue({
      tenantId: t,
      type: FAIR_TYPE,
      payload: { kind: 'classify' },
    });

    const order: Seen[] = [];
    await drain(q, order);

    expect(order.map((e) => e.id)).toEqual([classifyId]); // only the classify row
    expect(order.some((e) => e.id === foreignId)).toBe(false); // foreign row never selected
  });

  // Multi-replica distribution. Two consumers racing the same fair pick claim DISTINCT rows via
  // FOR UPDATE SKIP LOCKED; neither row is claimed twice. idleMs is high (not 0): concurrent consumers
  // with idleMs:0 can reclaim each other's PEL entry and double-deliver (queue.ts process() note).
  test('two concurrent classify consumers claim distinct rows with no double-claim (C7 SKIP LOCKED)', async () => {
    const { q } = await freshFairQueue();
    const a = randomUUID();
    const id1 = await q.enqueue({ tenantId: a, type: FAIR_TYPE, payload: { n: 1 } });
    const id2 = await q.enqueue({ tenantId: a, type: FAIR_TYPE, payload: { n: 2 } });

    const order: Seen[] = [];
    await Promise.all([
      q.process(
        'cA',
        async (job) => {
          order.push({ id: job.id, tenantId: job.tenantId });
        },
        { count: 1, idleMs: 30_000 },
      ),
      q.process(
        'cB',
        async (job) => {
          order.push({ id: job.id, tenantId: job.tenantId });
        },
        { count: 1, idleMs: 30_000 },
      ),
    ]);

    expect(order.map((e) => e.id).sort()).toEqual([id1, id2].sort()); // two distinct rows, no dup
  });
});
