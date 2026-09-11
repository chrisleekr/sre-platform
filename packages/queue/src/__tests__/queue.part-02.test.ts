import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { jobs } from '@sre/db';
import type { Redis } from 'ioredis';

import { Queue } from '../queue';

import { createFixture } from './queue.fixture';

const __fixture = createFixture();

describe('Valkey Streams queue', () => {
  test('returns a durable queued job when post-commit dispatch is unavailable', async () => {
    const unavailable = new Error('Valkey unavailable');
    const dispatchRedis = {
      xadd: vi.fn(async () => {
        throw unavailable;
      }),
    } as unknown as Redis;
    const queue = new Queue(__fixture.db.db, __fixture.redis, {
      stream: __fixture.STREAM,
      deadStream: __fixture.DEAD,
      group: 'workers',
      dispatchRedis,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let jobId: string;
    try {
      jobId = await queue.enqueue({
        tenantId: __fixture.tenant,
        type: __fixture.TYPE,
        payload: {},
      });
    } finally {
      warn.mockRestore();
    }

    expect(dispatchRedis.xadd).toHaveBeenCalledTimes(1);
    expect((await __fixture.db.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]).toMatchObject({
      status: 'queued',
      streamId: null,
    });
  });

  test('keeps a successfully dispatched job when stream-id bookkeeping fails', async () => {
    const bookkeepingError = new Error('Postgres bookkeeping unavailable');
    const realDb = __fixture.db.db;
    let failBookkeeping = true;
    const db = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property === 'update' && failBookkeeping) {
          return () => {
            failBookkeeping = false;
            return {
              set: () => ({
                where: async () => {
                  throw bookkeepingError;
                },
              }),
            };
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof realDb;
    const queue = new Queue(db, __fixture.redis, {
      stream: __fixture.STREAM,
      deadStream: __fixture.DEAD,
      group: 'workers',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const caseKey = randomUUID();

    let jobId: string;
    try {
      jobId = await queue.enqueue({
        tenantId: __fixture.tenant,
        type: __fixture.TYPE,
        payload: { caseKey },
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('queue.stream_id_write_failed'));
    } finally {
      warn.mockRestore();
    }

    expect(
      await __fixture.db.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(sql`type = ${__fixture.TYPE} and payload->>'caseKey' = ${caseKey}`),
    ).toEqual([{ id: jobId }]);
    const handled: string[] = [];
    await queue.process('stream-id-bookkeeping-failure', async (job) => {
      handled.push(job.id);
    });
    expect(handled).toEqual([jobId]);
    expect((await __fixture.db.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]).toMatchObject({
      status: 'done',
    });
  });

  test('reconcile re-dispatches a queued job whose stream entry was lost', async () => {
    // Simulate a crash after the Postgres write but before XADD: a queued row, no stream entry.
    const inserted = await __fixture.db.db
      .insert(jobs)
      .values({
        tenantId: __fixture.tenant,
        type: __fixture.TYPE,
        payload: {},
        status: 'queued',
        stream: __fixture.STREAM,
      })
      .returning({ id: jobs.id });
    const id = inserted[0]!.id;

    expect(await __fixture.q.reconcile(0)).toBeGreaterThanOrEqual(1);

    const handled: string[] = [];
    await __fixture.q.process('c1', async (job) => {
      handled.push(job.id);
    });
    expect(handled).toContain(id);
    expect((await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!.status).toBe(
      'done',
    );
  });

  test('reconcile is scoped to its own stream: a foreign-stream stuck job is left alone', async () => {
    // A stuck queued job that belongs to a DIFFERENT stream must not be scooped onto ours.
    const foreignStream = `test:jobs:foreign:${randomUUID().slice(0, 8)}`;
    const inserted = await __fixture.db.db
      .insert(jobs)
      .values({
        tenantId: __fixture.tenant,
        type: __fixture.TYPE,
        payload: {},
        status: 'queued',
        stream: foreignStream,
      })
      .returning({ id: jobs.id });
    const id = inserted[0]!.id;

    await __fixture.q.reconcile(0); // q is bound to STREAM
    const handled: string[] = [];
    await __fixture.q.process('c1', async (job) => {
      handled.push(job.id);
    });

    // Untouched: never re-dispatched here, never consumed here, still queued for its real stream.
    expect(handled).not.toContain(id);
    expect((await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!.status).toBe(
      'queued',
    );
  });

  test('handleOne drops a foreign-stream delivery: acks it but never marks the job done', async () => {
    const foreignStream = `test:jobs:foreign:${randomUUID().slice(0, 8)}`;
    const dead = `${foreignStream}:dead`;
    const inserted = await __fixture.db.db
      .insert(jobs)
      .values({
        tenantId: __fixture.tenant,
        type: __fixture.TYPE,
        payload: {},
        status: 'queued',
        stream: foreignStream,
      })
      .returning({ id: jobs.id });
    const id = inserted[0]!.id;
    // Simulate a stray XADD misrouting the foreign job's id onto THIS stream.
    await __fixture.redis.xadd(__fixture.STREAM, '*', 'jobId', id);

    const handled: string[] = [];
    await __fixture.q.process('c1', async (job) => {
      handled.push(job.id);
    });

    // The stray entry is consumed (acked, so it will not redeliver here) but the handler never ran
    // and the job row is untouched — never marked done.
    expect(handled).not.toContain(id);
    expect((await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!.status).toBe(
      'queued',
    );

    // Not orphaned: its real stream still owns it and can recover it.
    const fq = new Queue(__fixture.db.db, __fixture.redis, {
      stream: foreignStream,
      deadStream: dead,
      group: 'workers',
    });
    await fq.ensureGroup();
    expect(await fq.reconcile(0)).toBeGreaterThanOrEqual(1);
    await __fixture.redis.del(foreignStream, dead);
  });

  test('two concurrent consumers run the handler at most once for one job id (atomic claim)', async () => {
    const id = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: __fixture.TYPE,
      payload: {},
    });
    // Second delivery for the same job (double-XADD crash scenario: two stream entries, one job id).
    await __fixture.redis.xadd(__fixture.STREAM, '*', 'jobId', id);
    let runs = 0;
    const handler = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 100));
    };
    // Each consumer takes one of the two entries (count:1); a non-atomic claim lets both run the handler.
    await Promise.all([
      __fixture.q.process('cA', handler, { count: 1, idleMs: 30_000 }),
      __fixture.q.process('cB', handler, { count: 1, idleMs: 30_000 }),
    ]);
    expect(runs).toBe(1); // PRE-FIX this is 2 (RED): unconditional UPDATE ... SET status='processing'
    const row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0];
    expect(row?.status).toBe('done');
  });

  test('a consumer whose lease was reclaimed cannot clobber the new claim (attempts fence)', async () => {
    const id = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: __fixture.TYPE,
      payload: {},
    });
    await __fixture.q.process(
      'cA',
      async () => {
        // Simulate another consumer reclaiming mid-handler: bump attempts + refresh lease.
        await __fixture.db.db
          .update(jobs)
          .set({ attempts: sql`${jobs.attempts} + 1`, updatedAt: sql`now()` })
          .where(eq(jobs.id, id));
      },
      { idleMs: 30_000, count: 1 },
    );
    const row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0];
    // cA claimed attempts=1; the in-handler bump made it 2; cA's fenced done-write (WHERE attempts=1)
    // matched 0 rows, so the row is NOT clobbered to 'done'.
    expect(row?.status).toBe('processing');
    expect(row?.attempts).toBe(2);
  });

  test('a crashed processing job (stale updated_at) is still recovered', async () => {
    const id = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: __fixture.TYPE,
      payload: {},
    });
    await __fixture.db.db
      .update(jobs)
      .set({ status: 'processing', updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(jobs.id, id));
    let ran = false;
    await __fixture.q.process(
      'c1',
      async () => {
        ran = true;
      },
      { idleMs: 0 },
    );
    expect(ran).toBe(true);
    const row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0];
    expect(row?.status).toBe('done');
  });

  test('a handler running longer than idleMs is not re-claimed and executed twice while alive (heartbeat)', async () => {
    // Without the heartbeat a second consumer re-claims at idleMs and runs the handler concurrently:
    // handleOne would await the handler with NO mid-run updated_at refresh, so once idleMs elapsed the
    // atomic claim's staleness predicate (updated_at < now() - idleMs) would treat a still-live lease as
    // crashed. A live handler keeps renewing its lease instead, so it runs exactly once.
    const id = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: __fixture.TYPE,
      payload: {},
    });
    const idleMs = 100;
    let runs = 0;
    const handler = async () => {
      runs += 1;
      // Outlive idleMs to model a slow triage LLM call still in flight past the lease window.
      await new Promise((r) => setTimeout(r, 350));
    };

    // First consumer claims the job and enters the long handler; do NOT await (it holds for ~350ms).
    const first = __fixture.q.process('cA', handler, { count: 1, idleMs });

    // Wait past idleMs (first is still sleeping), then drive a second consumer against the same queue.
    await new Promise((r) => setTimeout(r, 150));
    const second = __fixture.q.process('cB', handler, { count: 1, idleMs });

    await Promise.all([first, second]);

    // A live handler must not be re-claimed: exactly one execution. PRE-FIX this is 2 (RED).
    expect(runs).toBe(1);
    const row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0];
    expect(row?.status).toBe('done');
  });
});

// harden resume trigger: a coalescing resume producer collapses duplicate human replies for one
// incident into a single queued/processing resume job (partial-unique index + xadd only on a fresh
// insert), so a reply flood cannot fan out into N triage runs.
describe('enqueueResume coalescing', () => {
  const queuedOrProcessing = async (incidentId: string) =>
    __fixture.db.db
      .select()
      .from(jobs)
      .where(
        sql`type = 'resume' and payload->>'incidentId' = ${incidentId} and status in ('queued','processing')`,
      );

  test('enqueueResume coalesces: two resume enqueues for one incident yield one queued job', async () => {
    const incidentId = randomUUID();
    const id1 = await __fixture.q.enqueueResume(__fixture.tenant, incidentId, 'msg-1');
    const id2 = await __fixture.q.enqueueResume(__fixture.tenant, incidentId, 'msg-2');

    // Exactly one enqueue won the insert; the other coalesced onto it and returned null.
    const ids = [id1, id2];
    expect(ids.filter((x) => typeof x === 'string')).toHaveLength(1);
    expect(ids.filter((x) => x === null)).toHaveLength(1);
    expect(await queuedOrProcessing(incidentId)).toHaveLength(1);
  });

  test('persists resume work when the fail-fast dispatch connection is unavailable', async () => {
    const unavailable = new Error('Valkey unavailable');
    const dispatchRedis = {
      xadd: vi.fn(async () => {
        throw unavailable;
      }),
    } as unknown as Redis;
    const queue = new Queue(__fixture.db.db, __fixture.redis, {
      stream: __fixture.STREAM,
      deadStream: __fixture.DEAD,
      group: 'workers',
      dispatchRedis,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const incidentId = randomUUID();

    let jobId: string | null;
    try {
      jobId = await queue.enqueueResume(__fixture.tenant, incidentId, 'msg-valkey-down');
    } finally {
      warn.mockRestore();
    }

    expect(jobId).toEqual(expect.any(String));
    expect(dispatchRedis.xadd).toHaveBeenCalledTimes(1);
    expect((await __fixture.db.db.select().from(jobs).where(eq(jobs.id, jobId!)))[0]).toMatchObject(
      { status: 'queued', streamId: null },
    );
  });

  test('keeps resume gates on the persistent connection when dispatch uses a bounded client', async () => {
    const dispatchRedis = {
      set: vi.fn(async () => {
        throw new Error('dispatch Redis must not own resume gates');
      }),
      del: vi.fn(async () => {
        throw new Error('dispatch Redis must not own resume gates');
      }),
      xadd: vi.fn(async () => '1-0'),
    } as unknown as Redis;
    const queue = new Queue(__fixture.db.db, __fixture.redis, {
      stream: __fixture.STREAM,
      deadStream: __fixture.DEAD,
      group: 'workers',
      dispatchRedis,
    });
    const incidentId = randomUUID();

    const jobId = await queue.enqueueResume(__fixture.tenant, incidentId, 'msg-gate-owner');
    await queue.clearResumeGate(incidentId);

    expect(jobId).toEqual(expect.any(String));
    expect(dispatchRedis.set).not.toHaveBeenCalled();
    expect(dispatchRedis.del).not.toHaveBeenCalled();
    expect(dispatchRedis.xadd).toHaveBeenCalledTimes(1);
  });

  test('a mid-run reply (prior job processing) enqueues a fresh queued resume (at-least-once)', async () => {
    const incidentId = randomUUID();
    const id1 = await __fixture.q.enqueueResume(__fixture.tenant, incidentId, 'msg-1');
    expect(typeof id1).toBe('string');

    // Model the worker CLAIMING the resume: the atomic claim moves it queued -> PROCESSING (the real
    // at-claim state, not 'done'), and the worker clears the fast-gate before reading history. The
    // partial index is scoped to status='queued', so the processing job has left it: a human reply
    // that lands mid-run must enqueue a FRESH queued resume (the engine lock serializes the two runs;
    // the second reads full history). This is the at-least-once the feature claims.
    await __fixture.db.db.update(jobs).set({ status: 'processing' }).where(eq(jobs.id, id1!));
    await __fixture.q.clearResumeGate(incidentId);
    const id2 = await __fixture.q.enqueueResume(__fixture.tenant, incidentId, 'msg-2');
    expect(typeof id2).toBe('string');
    expect(id2).not.toBe(id1);
    // Bounded fan-out: at most one 'processing' + one 'queued' resume per incident.
    expect(await queuedOrProcessing(incidentId)).toHaveLength(2);
  });

  test('the durable index bounds fan-out: a reply while one is queued coalesces even with the gate cleared', async () => {
    const incidentId = randomUUID();
    const id1 = await __fixture.q.enqueueResume(__fixture.tenant, incidentId, 'msg-1'); // queued
    expect(typeof id1).toBe('string');
    // Clear the fast-gate so the DURABLE partial-unique index (not the Redis gate) is what coalesces.
    await __fixture.q.clearResumeGate(incidentId);
    const id2 = await __fixture.q.enqueueResume(__fixture.tenant, incidentId, 'msg-2');
    expect(id2).toBeNull(); // the queued row already occupies the (tenant,type,incident) index slot
    expect(await queuedOrProcessing(incidentId)).toHaveLength(1);
  });

  test('a reply after the prior resume completed enqueues a new resume', async () => {
    const incidentId = randomUUID();
    const id1 = await __fixture.q.enqueueResume(__fixture.tenant, incidentId, 'msg-1');
    await __fixture.db.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, id1!));
    await __fixture.q.clearResumeGate(incidentId);
    const id3 = await __fixture.q.enqueueResume(__fixture.tenant, incidentId, 'msg-3');
    expect(typeof id3).toBe('string');
    expect(id3).not.toBe(id1);
    expect(await queuedOrProcessing(incidentId)).toHaveLength(1);
  });
});

// the JOB_STREAM_MAXLEN bullet describes a poll row left behind by a trim, and asks the
// deciding question: can that stranded row block the next poll? It cannot. ONE reason carries it. A
// poll payload has no incidentId, so `jobs_resume_coalesce_idx`'s key expression is NULL and btree
// NULLs are distinct (no NULLS NOT DISTINCT); `jobs_runbook_coalesce_idx` pins type='runbook.generate'
// in its predicate and so never covers a poll row at all. COALESCING_TYPES is NOT a second reason: it
// decides whether a conflict is ABSORBED or RAISED, so 'poll' being absent from it is why the NULL key
// is load-bearing rather than incidental. Poll takes the bare insert, and a conflict there would be
// fatal. The bullet's surviving conclusion is therefore a row LEAK, never a dropped job and never a
// stopped poll. Both linger states get a test below, because the bullet asserts both.
describe('a stranded poll job never blocks the next poll enqueue', () => {
  const pollRows = async (connectorType: string) =>
    __fixture.db.db
      .select()
      .from(jobs)
      .where(
        sql`type = 'poll' and tenant_id = ${__fixture.tenant} and payload->>'connectorType' = ${connectorType}`,
      );

  test('a poll row stranded in processing does not block the next poll enqueue for the same tenant + connectorType', async () => {
    const connectorType = `datadog-${randomUUID().slice(0, 8)}`;
    const id1 = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: 'poll',
      payload: { connectorType },
    });

    // Model the crash the bullet describes: the worker CLAIMED the job (queued -> PROCESSING, the
    // real at-claim state) and died, and the trim dropped its stream entry. Poll has no reconcile
    // driver, so the row never leaves 'processing'. Same claim modelling as the tests.
    await __fixture.db.db.update(jobs).set({ status: 'processing' }).where(eq(jobs.id, id1));

    // The next cadence tick enqueues the same tenant + connectorType. It must SUCCEED: poll takes the
    // bare insert, so a unique index covering this row would raise 23505 and reject the tick outright.
    // Poll stops for no tenant.
    const id2 = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: 'poll',
      payload: { connectorType },
    });
    expect(id2).not.toBe(id1);

    // Two rows: the leaked 'processing' one and the fresh 'queued' one. The enqueue INSERTS a new
    // row and never touches the old one, so BOTH leak. The bullet must not claim the next enqueue
    // "supersedes" a trimmed one.
    const rows = await pollRows(connectorType);
    expect(rows.map((r) => r.status).sort()).toEqual(['processing', 'queued']);
    expect(rows.find((r) => r.id === id1)?.status).toBe('processing');
    expect(rows.find((r) => r.id === id2)?.status).toBe('queued');
  }, 30_000);

  test('a poll row still lingering queued does not block the next poll enqueue either', async () => {
    const connectorType = `datadog-${randomUUID().slice(0, 8)}`;
    const id1 = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: 'poll',
      payload: { connectorType },
    });

    // The bullet's OTHER linger state: the trim dropped the entry while the row was still `queued`, so
    // no worker ever claimed it. This is the branch that actually exercises NULL-distinctness. A
    // `queued` row sits INSIDE `jobs_resume_coalesce_idx`'s status='queued' predicate, so the index is
    // live over BOTH rows here and the NULL key is the only thing keeping them from colliding. The
    // sibling test above strands in `processing`, which leaves that predicate entirely, so it would
    // still pass under NULLS NOT DISTINCT and cannot pin this.
    const id2 = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: 'poll',
      payload: { connectorType },
    });
    expect(id2).not.toBe(id1);

    const rows = await pollRows(connectorType);
    expect(rows.map((r) => r.status).sort()).toEqual(['queued', 'queued']);
    expect(rows.map((r) => r.id).sort()).toEqual([id1, id2].sort());
  }, 30_000);

  test('coalesces queued signal reassessment while retaining every causal signal version', async () => {
    const incidentId = randomUUID();
    const signalId = randomUUID();
    const secondSignalId = randomUUID();
    const first = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertReassessmentTx(tx, __fixture.tenant, incidentId, signalId, 1),
    );
    expect(first.jobId).toBeTruthy();

    const coalesced = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertReassessmentTx(tx, __fixture.tenant, incidentId, signalId, 2),
    );
    expect(coalesced.jobId).toBeNull();
    const queued = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, first.jobId!)))[0]!;
    expect(queued.payload).toEqual({
      incidentId,
      signalChanges: [{ signalId, signalVersion: 2, triggerReason: 'material_change' }],
      investigationTrigger: {
        reason: 'material_change',
        automatic: true,
        monitorKey: null,
      },
    });

    await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertReassessmentTx(
        tx,
        __fixture.tenant,
        incidentId,
        secondSignalId,
        1,
        'state_transition',
      ),
    );
    const merged = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, first.jobId!)))[0]!;
    const expectedChanges = [
      { signalId, signalVersion: 2, triggerReason: 'material_change' },
      { signalId: secondSignalId, signalVersion: 1, triggerReason: 'state_transition' },
    ].sort((a, b) => a.signalId.localeCompare(b.signalId));
    expect(merged.payload).toMatchObject({
      signalChanges: expectedChanges,
    });

    await __fixture.db.db
      .update(jobs)
      .set({ status: 'processing' })
      .where(eq(jobs.id, first.jobId!));
    const successor = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertReassessmentTx(tx, __fixture.tenant, incidentId, signalId, 3),
    );
    expect(successor.jobId).toBeTruthy();
    expect(successor.jobId).not.toBe(first.jobId);
    await __fixture.db.db
      .delete(jobs)
      .where(sql`tenant_id = ${__fixture.tenant} and payload->>'incidentId' = ${incidentId}`);
  });
});
