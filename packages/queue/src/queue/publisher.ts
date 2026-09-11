import { jobs, withTenant, type Db } from '@sre/db';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { RESUME_GATE_TTL_SEC, resumeGateKey } from './contracts';
import type { QueueWriter } from './writer';

export class QueuePublisher {
  constructor(
    private readonly db: Db,
    private readonly gateRedis: Redis,
    private readonly dispatchRedis: Redis,
    private readonly stream: string,
    private readonly streamMaxLen: number,
    private readonly writer: QueueWriter,
  ) {}

  /**
   * Post-commit dispatch half of {@link insertJobTx} / {@link insertResumeTx}: XADD the job onto the
   * stream, then record its streamId. Call ONLY after the tx that inserted the job committed — an xadd for
   * a rolled-back job is exactly the orphaned-dispatch bug the split closes. An XADD failure is
   * recoverable: the row stays `queued` with a null `stream_id` and {@link reconcile} re-dispatches it.
   *
   * The `stream_id` write is BOOKKEEPING, not dispatch: once the XADD lands the job WILL run, so a failure
   * to record the id must never be reported as a failed publish. Throwing there told the caller "not
   * dispatched" about a job that was, and a caller that retried inserted a SECOND job (the coalescing index
   * only covers `status = 'queued'`, so the already-claimed first job no longer blocks it) — a duplicate
   * investigation. Swallow it: a null stream_id only makes {@link reconcile} re-XADD, and the atomic claim
   * in handleOne makes the duplicate delivery a no-op.
   */
  async publishJob(jobId: string): Promise<void> {
    const due = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.stream, this.stream),
          eq(jobs.status, 'queued'),
          lte(jobs.availableAt, sql`now()`),
        ),
      )
      .limit(1);
    if (!due[0]) return;
    const streamId = await this.dispatchRedis.xadd(
      this.stream,
      'MAXLEN',
      '~',
      this.streamMaxLen,
      '*',
      'jobId',
      jobId,
    );
    try {
      await this.db
        .update(jobs)
        .set({ streamId, updatedAt: sql`now()` })
        .where(eq(jobs.id, jobId));
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          pkg: '@sre/queue',
          msg: 'stream_id write failed after xadd; job is dispatched, reconcile may re-deliver',
          jobId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  /** Post-commit dispatch for a resume job (see {@link publishJob}); kept as the resume path's name. */
  async publishResume(jobId: string): Promise<void> {
    await this.publishJob(jobId);
  }

  /** Publish durable delayed jobs whose model-selected due time has arrived. */
  async dispatchDue(limit = 100): Promise<number> {
    const due = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.stream, this.stream),
          eq(jobs.status, 'queued'),
          isNull(jobs.streamId),
          lte(jobs.availableAt, sql`now()`),
        ),
      )
      .orderBy(jobs.availableAt, jobs.createdAt)
      .limit(limit);
    for (const row of due) await this.publishJob(row.id);
    return due.length;
  }

  /**
   * Coalescing resume producer: collapse a human-reply flood for one incident into at most one
   * queued/processing `resume` job, so N replies never fan out into N triage runs. Composition of
   * {@link insertResumeTx} + {@link publishResume} behind the Redis NX fast-gate; the durable
   * `jobs_resume_coalesce_idx` is the source of truth. A gate outage falls through to that durable index.
   * Returns the new job id, or null when coalesced.
   * The atomic ingest path calls the split halves directly to share the reply's transaction;
   * this stays as the standalone enqueue API.
   */
  async enqueueResume(
    tenantId: string,
    incidentId: string,
    humanMessageId: string,
  ): Promise<string | null> {
    // Fast gate: a resume is already pending for this incident — coalesce without a DB round-trip.
    let gateArmed = false;
    try {
      const armed = await this.gateRedis.set(
        resumeGateKey(incidentId),
        '1',
        'EX',
        RESUME_GATE_TTL_SEC,
        'NX',
      );
      if (armed === null) return null;
      gateArmed = true;
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          pkg: '@sre/queue',
          event: 'queue.resume_gate_unavailable',
          incidentId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
    // The insert runs in its own tx; it can return null (durable coalesce) or THROW. On a throw the insert
    // rolled back, so a gate left armed with no new pending job would coalesce a real future reply into
    // nothing = lost resume — release it. On a null return the durable index found an already-
    // pending job, so the armed gate still reflects reality; leave it.
    let jobId: string | null;
    try {
      ({ jobId } = await withTenant(this.db, tenantId, (tx) =>
        this.writer.insertResumeTx(tx, tenantId, incidentId, humanMessageId),
      ));
    } catch (e) {
      if (gateArmed) await this.gateRedis.del(resumeGateKey(incidentId)).catch(() => undefined);
      throw e;
    }
    if (jobId === null) return null; // durable index coalesced a concurrent/duplicate resume
    await this.publishResume(jobId).catch((error) =>
      console.warn(
        JSON.stringify({
          level: 'warn',
          pkg: '@sre/queue',
          event: 'queue.post_commit_dispatch_failed',
          jobId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      ),
    );
    return jobId;
  }

  /** Release the resume fast-gate so the next human reply re-arms and enqueues. The worker calls
   * this when it claims a resume (clear-before-read), so a reply landing mid-run is not lost. */
  async clearResumeGate(incidentId: string): Promise<void> {
    await this.gateRedis.del(resumeGateKey(incidentId));
  }
}
