import { jobs, type Db } from '@sre/db';
import { and, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

export interface JobInput {
  tenantId: string;
  type: string;
  payload: unknown;
}

export interface ClassifyEnqueueResult {
  jobId: string;
  inserted: boolean;
  matchedBy: 'intake' | 'event' | null;
}

export interface Job {
  id: string;
  tenantId: string;
  type: string;
  payload: unknown;
  attempts: number;
  createdAt?: Date;
}

/** Per-attempt execution context. `Job` stays the durable row shape; the signal lives here. */
export interface JobContext {
  /** Aborts with a DeadlineExceededError when this attempt's processing ceiling passes. Handlers must stop work and throw; the queue never abandons a pending handler. */
  signal: AbortSignal;
}

/** One-argument handlers still typecheck; handlers that run long work take the context. */
export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;

/** The per-attempt processing ceiling passed with the handler still running. */
export class DeadlineExceededError extends Error {
  constructor(readonly ceilingMs: number) {
    super(`handler exceeded processing ceiling of ${ceilingMs}ms`);
    this.name = 'DeadlineExceededError';
  }
}

export const DEFAULT_MAX_PROCESSING_MS = 15 * 60_000;
export const DEFAULT_STUCK_GRACE_MS = 60_000;

export interface StuckJobInfo {
  jobId: string;
  tenantId: string;
  type: string;
  attempts: number;
  ceilingMs: number;
  graceMs: number;
}

/**
 * Deletes terminal job history older than the configured retention window.
 *
 * @param db - Database containing durable queue rows.
 * @param retentionSec - Minimum terminal-row age in seconds.
 */
export async function pruneTerminalJobs(db: Db, retentionSec: number): Promise<number> {
  const result = await db
    .delete(jobs)
    .where(
      and(
        inArray(jobs.status, ['done', 'dead']),
        sql`${jobs.updatedAt} < now() - make_interval(secs => ${retentionSec})`,
      ),
    );
  return result.count;
}

/**
 * The outcome of {@link Queue.claimForDelivery}: the row a delivery actually claimed plus its
 * post-claim `attempts` (the lease token every terminal write is fenced on). `job.attempts` equals
 * `attempts` — both are surfaced because the fencing writes read `attempts` while the handler reads
 * the `job`. `null` means "nothing to run for this delivery" (stale/terminal, foreign-stream, or lost
 * the claim race); handleOne then acks the delivered entry and moves on.
 */
export interface ClaimedDelivery {
  job: Job;
  attempts: number;
}

/** TTL for the resume fast-gate. A safety cap only: the worker clears the gate when it claims the
 * job (clear-before-read), so under normal flow the gate is short-lived. */
export const RESUME_GATE_TTL_SEC = 900;

/**
 * Builds the Valkey key that coalesces pending incident resumes.
 *
 * @param incidentId - Incident whose resume work should be coalesced.
 */
export const resumeGateKey = (incidentId: string): string => `resume:pending:${incidentId}`;

/**
 * Cap on every work-stream XADD, mirroring hub.ts's SURFACE_STREAM_MAXLEN. Unbounded, one tenant's
 * flood grows Valkey until the instance OOMs, taking down EVERY stream (triage, classify, resume,
 * runbook) and the hub with it — a self-inflicted tenant burst escalating into a platform outage.
 *
 * Trimming drops NO work. Postgres is the durable source of truth and the stream carries
 * only a jobId POINTER. Two different mechanisms cover that, so do not assume reconcile is universal:
 *  - One-shot streams (triage, classify, runbook): a trimmed entry leaves the job `queued` with a stale
 *    `updated_at`, exactly the second clause of {@link reconcile}'s predicate, so a later pass re-XADDs
 *    it. A job trimmed while `processing`, after its worker crashed mid-run, is stranded the same way
 * and the same pass recovers it — XAUTOCLAIM cannot re-deliver an entry that was trimmed.
 *    Worst case is ~120s, because two 60s gates stack: the row is not reconcile-ELIGIBLE until
 *    `updated_at` is 60s stale, and the driver itself runs at most once per 60s window (poller.ts's NX
 *    window guard).
 *  - The poll stream has no reconcile driver, by design (index.ts: "Poll no longer reconciles"). A
 *    trimmed poll row lingers `queued`, or `processing` when its worker had already claimed it and
 *    crashed ({@link handleOne}'s atomic claim sets that status), and with no pass to re-XADD it the
 *    row never leaves whichever state it stranded in. The next window's enqueue still covers the WORK,
 *    because poll is periodic and the next tick re-polls the same connector (poller.ts), but it does
 *    not supersede the stranded ROW: it is a plain INSERT of a new row that never touches the old one,
 *    so both leak. Nor can the stranded row block that insert, on either unique index that could raise
 *    a 23505. A poll payload carries no incidentId, so `jobs_resume_coalesce_idx`'s key expression
 *    `payload->>'incidentId'` is NULL and btree NULLs are distinct: poll rows never conflict there in
 *    ANY status, stranded or not. And `jobs_runbook_coalesce_idx` pins `type='runbook.generate'` in its
 *    predicate, so it never covers a poll row at all. That NULL key is load-bearing rather than
 *    incidental, because `poll` is absent from {@link COALESCING_TYPES} and so takes the bare insert: a
 *    conflict here would RAISE, not be absorbed. The cost is a slow row leak, never a dropped job and
 *    never a stopped poll.
 * Either way the cost of a trim is latency, never lost work.
 *
 * 100k pointers is ~10 MB per stream: a hard ceiling on the blast radius, yet far above any healthy
 * backlog, so normal load is never trimmed into paying that re-dispatch latency for nothing.
 * hub.ts caps at 10_000 because its entries carry full message payloads; pointers are ~100x smaller.
 */
export const JOB_STREAM_MAXLEN = 100_000;

/**
 * Job types whose duplicate enqueue is a no-op the caller wants ABSORBED. Opt-in, because the
 * coalescing indexes on `jobs` key on type and so cover every incident-scoped type: absorbing a `triage`
 * conflict would drop the re-alert's newer payload while reporting success. Anything not listed keeps the
 * 23505 and lets its caller decide.
 */
export const COALESCING_TYPES: ReadonlySet<string> = new Set([
  'runbook.generate',
  'postmortem.generate',
  'assessment.grade',
  'relation.reassess',
  'recovery.verify',
  'signal.reassess',
  'subject.sync',
]);

/** Marks a job failure as a transient dependency outage eligible for extended retries. */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Stops automatic delivery when retrying requires an explicit responder decision. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** Marks a retryable failure as incident lease or lock contention. */
export class LockContentionError extends RetryableError {
  constructor(message: string) {
    super(message);
    this.name = 'LockContentionError';
  }
}

/** The requested incident was joined while this job producer was waiting for its durable fence. */
export class IncidentMovedError extends Error {
  constructor(
    readonly incidentId: string,
    readonly targetIncidentId: string,
  ) {
    super('incident was joined into another investigation');
    this.name = 'IncidentMovedError';
  }
}

/** A deleted incident cannot accept new durable work. */
export class IncidentUnavailableError extends Error {
  constructor(readonly incidentId: string) {
    super('incident is unavailable');
    this.name = 'IncidentUnavailableError';
  }
}

export interface QueueOptions {
  stream?: string;
  group?: string;
  deadStream?: string;
  maxAttempts?: number;
  /** Per-attempt processing ceiling. Default {@link DEFAULT_MAX_PROCESSING_MS}. */
  maxProcessingMs?: number;
  /**
   * Dead-letter ceiling for deadline failures. Like `lockContentionMaxAttempts`, `jobs.attempts`
   * remains the single shared counter, so a job that burned retryable redeliveries can dead-letter on
   * its first deadline. Default 2.
   */
  deadlineMaxAttempts?: number;
  /** Grace after deadline abort before a pending handler is declared stuck. Default {@link DEFAULT_STUCK_GRACE_MS}. */
  stuckGraceMs?: number;
  /**
   * When omitted, a stuck handler keeps its lease, nothing is requeued or dead-lettered, and the
   * event is only logged. Supplying this opts the queue into the requeue-then-recycle sequence.
   * Production must terminate the process synchronously, with no awaited log flush or graceful
   * shutdown.
   */
  onStuck?: (info: StuckJobInfo) => void;
  /** Dead-letter ceiling for RetryableError redeliveries; higher than maxAttempts. Default 50. */
  retryableMaxAttempts?: number;
  /**
   * Dead-letter ceiling applied when the most-recent failure is a LockContentionError, distinct from
   * the provider-outage `retryableMaxAttempts`. `jobs.attempts` stays a single monotonic counter — this
   * is a per-redelivery cap chosen by the last error type, not a separate tally. Default 200.
   */
  lockContentionMaxAttempts?: number;
  /** Approximate cap on this queue's stream and dead stream. Default {@link JOB_STREAM_MAXLEN}. */
  streamMaxLen?: number;
  /** Fail-fast connection for post-commit commands; blocking consumption continues on the primary. */
  dispatchRedis?: Redis;
}

export type StreamEntry = [id: string, fields: string[]];

export function fieldValue(fields: string[], key: string): string {
  const i = fields.indexOf(key);
  return i >= 0 ? (fields[i + 1] ?? '') : '';
}
