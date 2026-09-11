import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';

import { eq, sql } from 'drizzle-orm';

import {
  createIncident,
  incidents,
  jobs,
  setIncidentArchivedTx,
  transitionIncidentTx,
  withTenant,
} from '@sre/db';

import { IncidentUnavailableError, Queue } from '../queue';

import { createFixture } from './queue.fixture';

const __fixture = createFixture();

// a double-click on "generate runbook" must not produce two runbook.generate runs for one
// incident. Today the shared `jobs_resume_coalesce_idx` (key columns tenant_id, type,
// payload->>'incidentId'; predicate status='queued') already blocks a SECOND QUEUED row, but plain
// Queue.enqueue has no ON CONFLICT, so the duplicate click raises a 23505 unique-violation and the API
// 500s. And once the first job flips to 'processing' it leaves that queued-only index, so a second
// enqueue inserts a real duplicate: both consumers pass the read-only findChunkLinkingIncident guard and
// both write knowledge_chunks. Coalescing must therefore span queued+processing for runbook.generate,
// return the EXISTING job id instead of throwing, and still permit regeneration once the job is terminal.
describe('runbook.generate coalescing', () => {
  const RUNBOOK = 'runbook.generate';

  const nonTerminal = async (incidentId: string) =>
    __fixture.db.db
      .select()
      .from(jobs)
      .where(
        sql`type = ${RUNBOOK} and payload->>'incidentId' = ${incidentId} and status in ('queued','processing')`,
      );

  const enqueueRunbook = (incidentId: string) =>
    __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: RUNBOOK,
      payload: { incidentId, requestedBy: 'auth0|tester' },
    });

  test('a deleted incident cannot enqueue runbook model work', async () => {
    const incidentId = (
      await createIncident(__fixture.db.db, __fixture.tenant, {
        fingerprint: randomUUID(),
        alertSource: 'slack',
        service: 'deleted-runbook',
        severity: 'sev3',
      })
    ).id;
    await __fixture.db.db
      .update(incidents)
      .set({ archivedAt: new Date() })
      .where(eq(incidents.id, incidentId));

    await expect(enqueueRunbook(incidentId)).rejects.toBeInstanceOf(IncidentUnavailableError);
    expect(await nonTerminal(incidentId)).toEqual([]);
  });

  test('runbook enqueue waits for an uncommitted deletion and then creates no job', async () => {
    const incidentId = (
      await createIncident(__fixture.db.db, __fixture.tenant, {
        fingerprint: randomUUID(),
        alertSource: 'slack',
        service: 'deleted-runbook-race',
        severity: 'sev3',
      })
    ).id;
    await withTenant(__fixture.db.db, __fixture.tenant, (tx) =>
      transitionIncidentTx(tx, incidentId, 'resolved'),
    );
    let releaseDelete!: () => void;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let deleteApplied!: () => void;
    const deleteReached = new Promise<void>((resolve) => {
      deleteApplied = resolve;
    });
    const deletion = withTenant(__fixture.db.db, __fixture.tenant, async (tx) => {
      const result = await setIncidentArchivedTx(tx, incidentId, true, { expectedVersion: 1 });
      deleteApplied();
      await deleteReleased;
      return result;
    });
    await deleteReached;

    let enqueueSettled = false;
    const enqueue = enqueueRunbook(incidentId).then(
      (value) => {
        enqueueSettled = true;
        return { value };
      },
      (error: unknown) => {
        enqueueSettled = true;
        return { error };
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(enqueueSettled).toBe(false);
    releaseDelete();

    await expect(deletion).resolves.toMatchObject({ outcome: 'applied' });
    expect(await enqueue).toEqual({ error: expect.any(IncidentUnavailableError) });
    expect(await nonTerminal(incidentId)).toEqual([]);
  });

  test('a double-click while the first job is queued coalesces onto it and returns the existing job id (no 23505)', async () => {
    const incidentId = randomUUID();
    const id1 = await enqueueRunbook(incidentId);
    // RED today: the queued-only partial index rejects this insert with 23505 and enqueue throws,
    // surfacing as HTTP 500 from POST /incidents/:id/generate-runbook.
    const id2 = await enqueueRunbook(incidentId);

    expect(id2).toBe(id1);
    expect(await nonTerminal(incidentId)).toHaveLength(1);
  });

  test('a second request while the first job is processing still coalesces to one non-terminal job', async () => {
    const incidentId = randomUUID();
    const id1 = await enqueueRunbook(incidentId);
    // Model the worker CLAIMING the job (queued -> processing), exactly as the tests do. The
    // resume index's predicate is status='queued', so a processing job has left it: this is the real
    // race the ticket is about.
    await __fixture.db.db.update(jobs).set({ status: 'processing' }).where(eq(jobs.id, id1));

    const id2 = await enqueueRunbook(incidentId);

    // RED today: a second row is inserted, so two consumers distil the same incident and both write.
    expect(await nonTerminal(incidentId)).toHaveLength(1);
    expect(id2).toBe(id1);
  });

  test('regeneration is still possible once the prior job is terminal', async () => {
    const incidentId = randomUUID();
    const id1 = await enqueueRunbook(incidentId);
    await __fixture.db.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, id1));

    // Over-coalescing (e.g. an index with no status predicate) would permanently block regeneration.
    const id2 = await enqueueRunbook(incidentId);
    expect(typeof id2).toBe('string');
    expect(id2).not.toBe(id1);
    expect(await nonTerminal(incidentId)).toHaveLength(1);
  });

  test('resume semantics are untouched: a mid-run reply still enqueues a fresh resume (regression lock)', async () => {
    const incidentId = randomUUID();
    const id1 = await __fixture.q.enqueueResume(__fixture.tenant, incidentId, 'msg-1');
    expect(typeof id1).toBe('string');
    await __fixture.db.db.update(jobs).set({ status: 'processing' }).where(eq(jobs.id, id1!));
    await __fixture.q.clearResumeGate(incidentId);

    // The resume index is deliberately queued-only so a reply landing mid-run enqueues a FRESH resume
    // (at-least-once). A runbook coalescing index that bled into type='resume' would break this.
    const id2 = await __fixture.q.enqueueResume(__fixture.tenant, incidentId, 'msg-2');
    expect(typeof id2).toBe('string');
    expect(id2).not.toBe(id1);

    const resumes = await __fixture.db.db
      .select()
      .from(jobs)
      .where(
        sql`type = 'resume' and payload->>'incidentId' = ${incidentId} and status in ('queued','processing')`,
      );
    expect(resumes).toHaveLength(2);
  });

  test('a conflicting triage enqueue still THROWS: the newer alert body is never silently coalesced away', async () => {
    const incidentId = randomUUID();
    const first = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: 'triage',
      payload: { incidentId, title: 'first alert', alert: { value: 1 } },
    });

    // Coalescing must be OPT-IN. `jobs_resume_coalesce_idx` keys on type, so it constrains triage too: a
    // blanket ON CONFLICT DO NOTHING would drop this re-alert's payload and report the first job id as
    // success. routeToIncident depends on the 23505 to release its dedup key and rethrow, so the newer
    // alert body still reaches the engine.
    await expect(
      __fixture.q.enqueue({
        tenantId: __fixture.tenant,
        type: 'triage',
        payload: { incidentId, title: 'second alert', alert: { value: 2 } },
      }),
    ).rejects.toThrow();

    const triages = await __fixture.db.db
      .select()
      .from(jobs)
      .where(sql`type = 'triage' and payload->>'incidentId' = ${incidentId}`);
    expect(triages).toHaveLength(1);
    expect(triages[0]!.id).toBe(first);
  });

  test('a flood cannot grow the work stream without bound: XADD caps it', async () => {
    const stream = `test:jobs:cap:${randomUUID().slice(0, 8)}`;
    const dead = `${stream}:dead`;
    const CAP = 100;
    const FLOOD = 600;
    const cq = new Queue(__fixture.db.db, __fixture.redis, {
      stream,
      deadStream: dead,
      group: 'workers',
      streamMaxLen: CAP,
    });
    await cq.ensureGroup();

    // One real job row; publishJob is the production XADD site, so the flood exercises the real path.
    const id = await cq.enqueue({ tenantId: __fixture.tenant, type: __fixture.TYPE, payload: {} });
    for (let i = 0; i < FLOOD; i++) await cq.publishJob(id);

    // `MAXLEN ~` trims whole macro-nodes only (stream-node-max-entries, default 100), so XLEN settles
    // ABOVE the cap and never below it. Assert the honest bound — bounded well under the flood, never
    // under the cap — rather than an exact count, which approximate trimming does not promise.
    const len = await __fixture.redis.xlen(stream);
    expect(len).toBeGreaterThanOrEqual(CAP);
    expect(len).toBeLessThan(FLOOD);

    await __fixture.redis.del(stream, dead);
    // Explicit budget, not vitest's 5s default. FLOOD publishJob calls are FLOOD Valkey XADDs
    // PLUS FLOOD Postgres UPDATEs (publishJob writes stream_id), so this is ~1200 sequential
    // round-trips by design: the flood has to cross stream-node-max-entries (default 100) macro-node
    // boundaries before `MAXLEN ~` trims anything, so it cannot be made small. Measured at ~0.6s
    // isolated, but the full suite shares one Postgres and one Valkey across 135 files and Postgres is
    // the contended one (~77% of the cost here), so the same work runs several times slower and
    // overran 5s. Nothing here races a behaviour: every assertion is deterministic, the test is merely
    // expensive, so the budget is the only thing the load can break. Sized to absorb contention while
    // still failing on a real regression.
  }, 60_000);

  test('a job whose stream entry the cap trimmed away is still re-dispatched and processed', async () => {
    const stream = `test:jobs:trim:${randomUUID().slice(0, 8)}`;
    const dead = `${stream}:dead`;
    const CAP = 100;
    const tq = new Queue(__fixture.db.db, __fixture.redis, {
      stream,
      deadStream: dead,
      group: 'workers',
      streamMaxLen: CAP,
    });
    await tq.ensureGroup();

    // The victim: a real queued job with a real stream entry, enqueued FIRST so the cap evicts it first.
    const victim = await tq.enqueue({
      tenantId: __fixture.tenant,
      type: __fixture.TYPE,
      payload: { victim: true },
    });
    const victimStreamId = (
      await __fixture.db.db.select().from(jobs).where(eq(jobs.id, victim))
    )[0]!.streamId!;

    // Flood past the cap so the CAP ITSELF evicts the victim's entry — not a hand-rolled XTRIM.
    const filler = await tq.enqueue({
      tenantId: __fixture.tenant,
      type: __fixture.TYPE,
      payload: { filler: true },
    });
    for (let i = 0; i < 600; i++) await tq.publishJob(filler);

    // The pointer is gone from Valkey...
    expect(await __fixture.redis.xrange(stream, victimStreamId, victimStreamId)).toHaveLength(0);
    // ...but Postgres, the source of truth, still has the job queued. Nothing was lost.
    expect((await __fixture.db.db.select().from(jobs).where(eq(jobs.id, victim)))[0]!.status).toBe(
      'queued',
    );

    // reconcile() re-XADDs it (stale updated_at, second clause of its predicate) and it runs to done.
    expect(await tq.reconcile(0)).toBeGreaterThanOrEqual(1);
    const handled: string[] = [];
    await tq.process(
      'c1',
      async (job) => {
        handled.push(job.id);
      },
      { count: 1000 },
    );

    expect(handled).toContain(victim);
    expect((await __fixture.db.db.select().from(jobs).where(eq(jobs.id, victim)))[0]!.status).toBe(
      'done',
    );

    await __fixture.redis.del(stream, dead);
    // Explicit budget for the same reason as the flood test above: 600 publishJob calls are 600
    // XADDs plus 600 Postgres UPDATEs. This is the test that actually reddened CI, timing out at 5004ms
    // on roughly one full-suite run in three while staying green in isolation.
  }, 60_000);

  test("a job trimmed while 'processing' with a dead handler is re-dispatched", async () => {
    const stream = `test:jobs:crashtrim:${randomUUID().slice(0, 8)}`;
    const dead = `${stream}:dead`;
    const CAP = 100;
    const pq = new Queue(__fixture.db.db, __fixture.redis, {
      stream,
      deadStream: dead,
      group: 'workers',
      streamMaxLen: CAP,
    });
    await pq.ensureGroup();

    // The victim: enqueued FIRST so the cap evicts its entry first.
    const victim = await pq.enqueue({
      tenantId: __fixture.tenant,
      type: __fixture.TYPE,
      payload: { victim: true },
    });
    const victimStreamId = (
      await __fixture.db.db.select().from(jobs).where(eq(jobs.id, victim))
    )[0]!.streamId!;

    // Model the crashed replica through the real path rather than by hand: process() runs the real
    // claim (status 'processing', attempts bumped) and leaves the entry un-acked in the PEL, then the
    // handler never returns, so no terminal write ever lands — exactly what a replica that dies
    // mid-run leaves behind. Every other exit from handleOne is terminal, so a hung handler is the
    // only way to reach this state without killing a process. idleMs 0 skips the lease heartbeat, so
    // the abandoned row goes stale like a dead worker's instead of renewing itself.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let markClaimed!: () => void;
    const claimLanded = new Promise<void>((r) => (markClaimed = r));
    const abandoned = pq.process(
      'crashed',
      async () => {
        markClaimed();
        await gate;
      },
      { idleMs: 0 },
    );
    await claimLanded;

    try {
      // The claim is real, not staged: assert the state the crash left before relying on it.
      const crashed = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, victim)))[0]!;
      expect(crashed.status).toBe('processing');
      expect(crashed.attempts).toBe(1);

      // Backdate the claim: the crash must predate the reconcile threshold, and a test cannot wait.
      await __fixture.db.db
        .update(jobs)
        .set({ updatedAt: sql`now() - interval '5 minutes'` })
        .where(eq(jobs.id, victim));

      // Flood past the cap so the CAP ITSELF evicts the victim's entry — not a hand-rolled XTRIM.
      const filler = await pq.enqueue({
        tenantId: __fixture.tenant,
        type: __fixture.TYPE,
        payload: { filler: true },
      });
      for (let i = 0; i < 600; i++) await pq.publishJob(filler);

      // The entry is gone from the stream. It is still in the PEL, but reclaim cannot save it:
      // XAUTOCLAIM drops a PEL entry that no longer exists in the stream instead of re-delivering it
      // (https://valkey.io/commands/xautoclaim/), so reconcile is the only backstop left.
      expect(await __fixture.redis.xrange(stream, victimStreamId, victimStreamId)).toHaveLength(0);
      // Postgres, the source of truth, still holds the job mid-flight. Nothing was lost.
      expect(
        (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, victim)))[0]!.status,
      ).toBe('processing');

      // So reconcile() must re-dispatch it, and it must run to done — the page still needs answering.
      expect(await pq.reconcile(0)).toBeGreaterThanOrEqual(1);

      // Bind the recovery to the VICTIM. The count above proves nothing on its own: at olderThanMs 0
      // the predicate is `updated_at < now()`, which every queued row satisfies, so the still-queued
      // filler alone returns 1. Re-dispatch means the victim's row now points at a NEW, live entry
      // instead of the trimmed one it is stuck on.
      const redispatched = (
        await __fixture.db.db.select().from(jobs).where(eq(jobs.id, victim))
      )[0]!;
      expect(redispatched.streamId).not.toBe(victimStreamId);
      expect(
        await __fixture.redis.xrange(stream, redispatched.streamId!, redispatched.streamId!),
      ).toHaveLength(1);

      const handled: string[] = [];
      await pq.process(
        'c1',
        async (job) => {
          handled.push(job.id);
        },
        { count: 1000 },
      );

      expect(handled).toContain(victim);
      expect(
        (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, victim)))[0]!.status,
      ).toBe('done');
    } finally {
      // Unwind the abandoned handler so no pending promise outlives the test. Released only after the
      // assertions: its terminal write is fenced on (processing, attempts=1), which is precisely the
      // stuck state under test, so releasing earlier would mark the victim done and mask the bug.
      release();
      await abandoned;
      await __fixture.redis.del(stream, dead);
    }
    // Explicit budget for the same reason as the flood tests above: 600 publishJob calls are
    // 600 XADDs plus 600 Postgres UPDATEs, and the recovery pass then walks every surviving filler
    // entry. Deterministic throughout — only the cost, never a behaviour, rides on the load.
  }, 60_000);

  test("reconcile's queued reset never clobbers a claim that lands after its XADD", async () => {
    const stream = `test:jobs:fence:${randomUUID().slice(0, 8)}`;
    const dead = `${stream}:dead`;
    const spyRedis = new Redis(__fixture.VALKEY_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    const gq = new Queue(__fixture.db.db, spyRedis, { stream, deadStream: dead, group: 'workers' });
    await gq.ensureGroup();

    // A crashed worker's leftovers, set directly: this test is about the fence, not about how the row
    // went stale — the test above drives that state through the real claim.
    const id = await gq.enqueue({ tenantId: __fixture.tenant, type: __fixture.TYPE, payload: {} });
    await __fixture.db.db
      .update(jobs)
      .set({ status: 'processing', attempts: 1, updatedAt: sql`now() - interval '5 minutes'` })
      .where(eq(jobs.id, id));
    const stranded = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

    // reconcile XADDs BEFORE it updates, so a consumer can win the CAS on its stale-processing branch
    // inside that window. Drive the race from inside the XADD itself: that is the only moment the
    // window is open, and the write below is exactly what the winning CAS does. Spying on a dedicated
    // connection follows the dead-letter cap test below.
    type XaddSpy = { xadd: (...args: unknown[]) => Promise<unknown> };
    const spied = spyRedis as unknown as XaddSpy;
    const realXadd = spied.xadd.bind(spyRedis);
    let claims = 0;
    spied.xadd = async (...args: unknown[]) => {
      const result = await realXadd(...args);
      if (args[0] === stream) {
        claims++;
        await __fixture.db.db
          .update(jobs)
          .set({ status: 'processing', attempts: sql`${jobs.attempts} + 1`, updatedAt: sql`now()` })
          .where(eq(jobs.id, id));
      }
      return result;
    };

    expect(await gq.reconcile(0)).toBe(1);
    expect(claims).toBe(1);

    // The fence matched 0 rows, so the live claim stands untouched. Unfenced, the reset would push a
    // RUNNING job back to `queued`, fencing out its handler and freeing a second consumer to claim it:
    // two LLM investigations narrating into one customer thread, unrecoverable once sent. The row must
    // still be the claimer's, and reconcile's new stream_id must never have landed.
    const after = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(after.status).toBe('processing');
    expect(after.attempts).toBe(stranded.attempts + 1);
    expect(after.streamId).toBe(stranded.streamId);

    spyRedis.disconnect();
    await __fixture.redis.del(stream, dead);
  });

  test('the dead-letter XADD carries the same cap', async () => {
    // Nothing consumes the dead stream, so it grows monotonically — the likeliest unbounded stream of
    // the four. Asserted on the CALL SHAPE via a spy rather than a real length: proving the trim needs
    // >2 macro-nodes of dead entries (~250 dead-lettered jobs), and the flood test above already proves
    // this exact `MAXLEN ~` shape bounds a real stream.
    const stream = `test:jobs:deadcap:${randomUUID().slice(0, 8)}`;
    const dead = `${stream}:dead`;
    const CAP = 100;
    const spyRedis = new Redis(__fixture.VALKEY_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    const xaddCalls: unknown[][] = [];
    type XaddSpy = { xadd: (...args: unknown[]) => Promise<unknown> };
    const spied = spyRedis as unknown as XaddSpy;
    const realXadd = spied.xadd.bind(spyRedis);
    spied.xadd = async (...args: unknown[]) => {
      xaddCalls.push(args);
      return realXadd(...args);
    };

    const dq = new Queue(__fixture.db.db, spyRedis, {
      stream,
      deadStream: dead,
      group: 'workers',
      maxAttempts: 1,
      streamMaxLen: CAP,
    });
    await dq.ensureGroup();
    const id = await dq.enqueue({ tenantId: __fixture.tenant, type: __fixture.TYPE, payload: {} });
    await dq.process(
      'c1',
      async () => {
        throw new Error('boom');
      },
      { idleMs: 0 },
    );
    expect((await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!.status).toBe(
      'dead',
    );

    const deadAdds = xaddCalls.filter((args) => args[0] === dead);
    expect(deadAdds).toHaveLength(1);
    expect(deadAdds[0]!.slice(0, 4)).toEqual([dead, 'MAXLEN', '~', CAP]);

    spyRedis.disconnect();
    await __fixture.redis.del(stream, dead);
  });
});
