import { jobs, type Db } from '@sre/db';
import { and, eq, lte, or, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  DEFAULT_MAX_PROCESSING_MS,
  DEFAULT_STUCK_GRACE_MS,
  DeadlineExceededError,
  JOB_STREAM_MAXLEN,
  LockContentionError,
  RetryableError,
  NonRetryableError,
  fieldValue,
  type ClaimedDelivery,
  type JobHandler,
  type QueueOptions,
  type StuckJobInfo,
  type StreamEntry,
} from './contracts';
import { coalesceKeyFilter, requeueUnlessSuperseded } from './coalescing';

function warn(msg: string, details: object): void {
  console.warn(JSON.stringify({ level: 'warn', pkg: '@sre/queue', msg, ...details }));
}

export class QueueConsumer {
  protected readonly stream: string;
  private readonly group: string;
  private readonly deadStream: string;
  private readonly maxAttempts: number;
  private readonly maxProcessingMs: number;
  private readonly deadlineMaxAttempts: number;
  private readonly stuckGraceMs: number;
  private readonly onStuck: ((info: StuckJobInfo) => void) | undefined;
  private readonly retryableMaxAttempts: number;
  private readonly lockContentionMaxAttempts: number;
  private readonly streamMaxLen: number;

  constructor(
    protected readonly db: Db,
    private readonly redis: Redis,
    opts: QueueOptions = {},
  ) {
    this.stream = opts.stream ?? 'sre:jobs';
    this.group = opts.group ?? 'workers';
    this.deadStream = opts.deadStream ?? 'sre:jobs:dead';
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.maxProcessingMs = opts.maxProcessingMs ?? DEFAULT_MAX_PROCESSING_MS;
    if (this.maxProcessingMs <= 0) {
      throw new RangeError('maxProcessingMs must be greater than 0');
    }
    this.deadlineMaxAttempts = opts.deadlineMaxAttempts ?? 2;
    this.stuckGraceMs = opts.stuckGraceMs ?? DEFAULT_STUCK_GRACE_MS;
    this.onStuck = opts.onStuck;
    this.retryableMaxAttempts = opts.retryableMaxAttempts ?? 50;
    this.lockContentionMaxAttempts = opts.lockContentionMaxAttempts ?? 200;
    this.streamMaxLen = opts.streamMaxLen ?? JOB_STREAM_MAXLEN;
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '$', 'MKSTREAM');
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes('BUSYGROUP')) throw e;
    }
  }

  /**
   * Process up to `count` entries (reclaimed idle + new). Returns the number handled.
   * Heartbeats preserve a live handler's claim. idleMs must stay well below maxProcessingMs so a
   * deadline retry is promptly reclaimable; idleMs:0 is for single-consumer test reclaim only
   * (concurrent consumers with idleMs:0 can double-claim).
   */
  async process(
    consumer: string,
    handler: JobHandler,
    opts: { count?: number; idleMs?: number } = {},
  ): Promise<number> {
    const count = opts.count ?? 10;
    const idleMs = opts.idleMs ?? 30_000;
    const entries: StreamEntry[] = [];

    const claimed = (await this.redis.xautoclaim(
      this.stream,
      this.group,
      consumer,
      idleMs,
      '0',
      'COUNT',
      count,
    )) as unknown as [string, StreamEntry[], string[]];
    entries.push(...(claimed[1] ?? []));

    const read = (await this.redis.xreadgroup(
      'GROUP',
      this.group,
      consumer,
      'COUNT',
      count,
      'STREAMS',
      this.stream,
      '>',
    )) as unknown as Array<[string, StreamEntry[]]> | null;
    if (read) {
      for (const [, msgs] of read) entries.push(...msgs);
    }

    let handled = 0;
    for (const [streamId, fields] of entries) {
      await this.handleOne(streamId, fieldValue(fields, 'jobId'), handler, idleMs);
      handled++;
    }
    return handled;
  }

  /**
   * Claims the delivered job, or returns null so the caller acknowledges a stale delivery.
   * ClassifyQueue may select a different due job fairly. Postgres remains authoritative;
   * reconciliation republishes queued work whose stream pointer was acknowledged or lost.
   */
  protected async claimForDelivery(
    deliveredJobId: string,
    idleMs: number,
  ): Promise<ClaimedDelivery | null> {
    const rows = await this.db.select().from(jobs).where(eq(jobs.id, deliveredJobId));
    const job = rows[0];
    if (!job || job.status === 'done' || job.status === 'dead') {
      return null;
    }
    // Defense-in-depth: a job that belongs to another stream must never be completed here.
    // Post-scoping this cannot arise via reconcile, but a stray XADD (manual op, a future producer bug)
    // could still misroute one. Drop OUR delivery (the caller acks this stream) and leave the job row
    // untouched, so its real stream can still recover it (that stream's reconcile driver, or for
    // periodic poll jobs the next enqueue supersedes it). Never mark a foreign job done.
    if (job.stream !== this.stream) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          pkg: '@sre/queue',
          msg: 'foreign job delivered to wrong stream; dropped',
          jobId: deliveredJobId,
          jobStream: job.stream,
          stream: this.stream,
        }),
      );
      return null;
    }
    // Atomic claim: win only from 'queued', or from a 'processing' row whose lease has expired
    // (crash recovery). A live consumer's fresh 'processing' fails the predicate, so a concurrent
    // duplicate delivery gets zero rows and no-ops. Staleness is anchored to the same idleMs the
    // reclaim (XAUTOCLAIM) uses, so claim and reclaim stay aligned. Consumers stay idempotent, so a
    // duplicate delivery is safe.
    // The claim's `attempts` (monotonic, bumped once per claim) is our lease token: every terminal
    // write in handleOne is fenced on it, so a consumer whose lease expired (handler outran idleMs, the
    // job was re-claimed by another consumer that bumped attempts) cannot clobber the new claim.
    const claimed = await this.db
      .update(jobs)
      .set({ status: 'processing', attempts: sql`${jobs.attempts} + 1`, updatedAt: sql`now()` })
      .where(
        and(
          eq(jobs.id, deliveredJobId),
          eq(jobs.stream, this.stream),
          lte(jobs.availableAt, sql`now()`),
          or(
            eq(jobs.status, 'queued'),
            and(
              eq(jobs.status, 'processing'),
              sql`${jobs.updatedAt} < now() - ${idleMs} * interval '1 millisecond'`,
            ),
          ),
        ),
      )
      .returning({ attempts: jobs.attempts });
    if (claimed.length === 0) {
      // Lost the claim (another consumer holds a fresh lease, or the row went terminal under us). The
      // caller acks its delivery. A concurrent reclaimer that loses this DB claim (because the holder's
      // heartbeat kept updated_at fresh) still acks its XAUTOCLAIM'd delivery. If the original handler
      // later fails and requeues, the stream entry is already acked, so immediate XAUTOCLAIM redelivery
      // does not fire; reconcile (the olderThanMs backstop) recovers it instead — bounded, no job loss.
      return null;
    }
    const attempts = claimed[0]!.attempts;
    return {
      job: {
        id: job.id,
        tenantId: job.tenantId,
        type: job.type,
        payload: job.payload,
        attempts,
        createdAt: job.createdAt,
      },
      attempts,
    };
  }

  private async handleOne(
    streamId: string,
    deliveredJobId: string,
    handler: JobHandler,
    idleMs: number,
  ): Promise<void> {
    const claim = await this.claimForDelivery(deliveredJobId, idleMs);
    if (!claim) {
      // Every "nothing to run" path (stale/terminal, foreign-stream, lost claim) acks the DELIVERED
      // entry exactly once — the doorbell:ack invariant. With a fair-select subclass the acked doorbell
      // may not name the row that ran (or any row), which is fine: reconcile re-doorbells stranded rows.
      await this.redis.xack(this.stream, this.group, streamId);
      return;
    }
    // Terminal writes and the heartbeat key on the CLAIMED row/attempts, not the delivered id. In the
    // base these are identical (the claim is the delivered job); a fair-select subclass claims a
    // different row, and keying here on the claim is what makes that correct.
    const { job, attempts } = claim;
    const jobId = job.id;
    // Lease heartbeat: a handler that outruns idleMs would otherwise let its own row go stale,
    // so the staleness predicate above treats a still-live lease as a crash and a second consumer
    // re-claims + runs the handler twice. Renew updated_at every ~idleMs/4 while the handler runs, so
    // >=3 renewals land before the staleness deadline at idleMs — one transient tick failure or an
    // event-loop delay does not reopen the reclaim window. The tick is FENCED on (processing, attempts)
    // like every terminal write: a live holder keeps renewing; a consumer that already lost the lease
    // (a re-claimer bumped attempts) refreshes 0 rows and cannot resurrect the job; a crashed replica
    // runs no loop, so reclaim still recovers it. idleMs<=0 means "immediately reclaimable" (crash-
    // recovery + dead-letter tests): skip the heartbeat so a 0-idle job stays reclaimable at once.
    let stopped = idleMs <= 0;
    let wake: () => void = () => {}; // resolves the current sleep so stop drains at once
    const heartbeatMs = Math.max(1, Math.floor(idleMs / 4));
    // Self-rescheduling loop that AWAITS each tick before scheduling the next: ticks can never stack,
    // so a slow DB cannot pile up overlapping UPDATEs and exhaust the connection pool.
    const beat = (async () => {
      if (stopped) return; // idleMs<=0 gate: a 0-idle job is reclaimable at once, run no heartbeat
      for (;;) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, heartbeatMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (stopped) return;
        try {
          await this.db
            .update(jobs)
            .set({ updatedAt: sql`now()` })
            .where(
              and(eq(jobs.id, jobId), eq(jobs.status, 'processing'), eq(jobs.attempts, attempts)),
            );
        } catch (e) {
          // Warn-and-continue (match the file's convention): a transient DB error on a tick must never
          // reject the handler promise or crash the process.
          console.warn(
            JSON.stringify({
              level: 'warn',
              pkg: '@sre/queue',
              msg: 'lease heartbeat failed',
              jobId,
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
    })();
    const deadline = new AbortController();
    const ceiling = setTimeout(
      () => deadline.abort(new DeadlineExceededError(this.maxProcessingMs)),
      this.maxProcessingMs,
    );
    let settled = false;
    const fail = async (err: unknown): Promise<void> => {
      if (settled) return;
      settled = true;
      const message = err instanceof Error ? err.message : String(err);
      // Deadline first: an aborted provider call can surface as a vendor or retryable error, but it
      // must be charged to the deadline cap.
      const cap = deadline.signal.aborted
        ? this.deadlineMaxAttempts
        : err instanceof LockContentionError
          ? this.lockContentionMaxAttempts
          : err instanceof RetryableError
            ? this.retryableMaxAttempts
            : this.maxAttempts;
      if (err instanceof NonRetryableError || attempts >= cap) {
        // Fenced dead-letter: only dead-letter + xadd if we still hold the lease.
        const dead = await this.db
          .update(jobs)
          .set({ status: 'dead', lastError: message, updatedAt: sql`now()` })
          .where(
            and(eq(jobs.id, jobId), eq(jobs.status, 'processing'), eq(jobs.attempts, attempts)),
          )
          .returning({ id: jobs.id });
        // Postgres retains the terminal state if approximate trimming drops the dead-stream pointer.
        if (dead.length > 0) {
          await this.redis.xadd(
            this.deadStream,
            'MAXLEN',
            '~',
            this.streamMaxLen,
            '*',
            'jobId',
            jobId,
          );
        }
        await this.redis.xack(this.stream, this.group, streamId);
      } else {
        // Leave a matched requeue pending for XAUTOCLAIM; ack a superseded or retired delivery.
        const requeued = await requeueUnlessSuperseded(
          this.db,
          job,
          and(eq(jobs.id, jobId), eq(jobs.status, 'processing'), eq(jobs.attempts, attempts)),
          { lastError: message },
        );
        if (!requeued) {
          await this.redis.xack(this.stream, this.group, streamId);
        }
      }
    };
    let stuckTimer: ReturnType<typeof setTimeout> | undefined;
    deadline.signal.addEventListener(
      'abort',
      () => {
        stuckTimer = setTimeout(() => {
          void (async () => {
            if (settled) return;
            const info = {
              jobId,
              attempts,
              ceilingMs: this.maxProcessingMs,
              graceMs: this.stuckGraceMs,
            };
            if (this.onStuck === undefined) {
              // Releasing the lease without recycling would let another replica start a second attempt while this one still runs.
              warn('handler ignored deadline; no recycler configured, holding lease', info);
              return;
            }
            const onStuck = this.onStuck;
            let recycled = false;
            const recycle = (): void => {
              if (recycled) return;
              recycled = true;
              onStuck({ ...info, tenantId: job.tenantId, type: job.type });
            };
            // A hung terminal write must not block recycling forever. Process exit covers the write, and reconcile recovers the processing row.
            const fallbackTimer = setTimeout(recycle, this.stuckGraceMs);
            await fail(deadline.signal.reason);
            stopped = true;
            warn('handler ignored deadline; declared stuck', { jobId, attempts });
            recycle();
            clearTimeout(fallbackTimer);
          })().catch((err: unknown) => {
            warn('stuck watchdog failed', {
              jobId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }, this.stuckGraceMs);
      },
      { once: true },
    );
    try {
      await handler(
        {
          id: job.id,
          tenantId: job.tenantId,
          type: job.type,
          payload: job.payload,
          attempts,
          createdAt: job.createdAt,
        },
        { signal: deadline.signal },
      );
      if (!settled) {
        settled = true;
        // A re-claimer bumps attempts, so a late completion cannot overwrite its claim.
        await this.db
          .update(jobs)
          .set({ status: 'done', updatedAt: sql`now()` })
          .where(
            and(eq(jobs.id, jobId), eq(jobs.status, 'processing'), eq(jobs.attempts, attempts)),
          );
        await this.redis.xack(this.stream, this.group, streamId);
      }
    } catch (err) {
      await fail(err);
    } finally {
      clearTimeout(ceiling);
      if (stuckTimer) clearTimeout(stuckTimer);
      // Wake the heartbeat sleep and drain any in-flight fenced update before returning.
      stopped = true;
      wake();
      await beat;
    }
  }

  /**
   * Re-dispatch jobs whose stream entry may have been lost: `queued` rows, and `processing` rows a
   * dead handler stranded. Scoped to THIS queue's stream: the `jobs` table is shared
   * across streams, so an un-scoped scan would re-XADD other streams' stuck jobs onto this one, where
   * a type-mismatched handler no-ops and handleOne marks them done, a silent cross-stream job loss.
   *
   * A stranded `processing` row cannot heal itself. XAUTOCLAIM works from the PEL and will not
   * re-deliver an entry the `MAXLEN ~` cap already trimmed out of the stream; it drops the PEL entry
   * instead (https://valkey.io/commands/xautoclaim/). So a crash plus a trim leaves reconcile as the
   * only backstop, and without this the row sits `processing` forever and the page is never answered.
   *
   * Taking a `processing` row is safe because only a DEAD handler goes stale: the heartbeat
   * renews `updated_at` every idleMs/4 while a handler runs, and the reconcile invariant beside
   * `TRIAGE_RECONCILE_MS` in apps/triage-worker/src/index.ts keeps this `olderThanMs` (60s) above
   * process()'s `idleMs` (30s). If that judgement is somehow wrong, the CAS in handleOne still refuses the delivery.
   *
   * A live handler that ignores its deadline is handled by handleOne's ceiling and stuck watchdog.
   * The watchdog's fenced requeue is exactly what this method's `queued` clause recovers. The
   * `processing` clause still only ever selects a DEAD holder whose heartbeat stopped.
   *
   * Returns the number of rows selected as stuck. The reset below is fenced, so a row re-claimed
   * mid-pass is counted here but deliberately left to its new owner.
   */
  async reconcile(olderThanMs = 60_000): Promise<number> {
    const stuck = await this.db
      .select({
        id: jobs.id,
        attempts: jobs.attempts,
        status: jobs.status,
        tenantId: jobs.tenantId,
        type: jobs.type,
        payload: jobs.payload,
      })
      .from(jobs)
      .where(
        sql`stream = ${this.stream} and available_at <= now() and (
             (status = 'queued' and (stream_id is null or updated_at < now() - make_interval(secs => ${olderThanMs} / 1000.0)))
          or (status = 'processing' and updated_at < now() - make_interval(secs => ${olderThanMs} / 1000.0))
        )`,
      );
    for (const { id, attempts, status, tenantId, type, payload } of stuck) {
      const sameKey = coalesceKeyFilter(type, payload);
      if (status === 'processing' && sameKey) {
        const successor = await this.db
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.tenantId, tenantId),
              eq(jobs.type, type),
              eq(jobs.status, 'queued'),
              sameKey,
            ),
          )
          .limit(1);
        if (successor[0]) {
          // The queued successor carries newer coalesced input and rebuilds durable context.
          // Retiring the stranded predecessor avoids violating the queued uniqueness fence while
          // preserving the only run that can still make progress.
          const retired = await this.db
            .update(jobs)
            .set({ status: 'done', updatedAt: sql`now()` })
            .where(and(eq(jobs.id, id), eq(jobs.status, 'processing'), eq(jobs.attempts, attempts)))
            .returning({ id: jobs.id });
          if (retired[0]) continue;
        }
      }
      const streamId = await this.redis.xadd(
        this.stream,
        'MAXLEN',
        '~',
        this.streamMaxLen,
        '*',
        'jobId',
        id,
      );
      // Reset to `queued` so the claim wins on its `status='queued'` branch. The fresh `updated_at`
      // this same write lands would fail the staleness branch, and handleOne would then refuse the
      // delivery AND ack it, destroying the last pointer to the job. The reset also fences out the
      // zombie: its terminal writes and heartbeat all require `status='processing'` at this attempts,
      // so they match 0 rows once status flips. `attempts` is not bumped, because a crash burned no
      // retry and none should be charged toward the dead-letter cap.
      //
      // Fenced on `attempts` because the XADD above already gave a consumer the chance to claim this
      // row, winning the CAS on its stale-processing branch and bumping attempts. Unfenced, this write
      // would clobber a LIVE claim back to `queued`, fence out the running handler and let a second
      // consumer claim it, the double-run the heartbeat exists to prevent. At 0 rows the live
      // claim stands and the surplus entry we just XADDed is refused and acked by handleOne.
      // A successor queued after the lookup above retires the row instead; handleOne refuses and acks
      // the surplus stream entry.
      await requeueUnlessSuperseded(
        this.db,
        { id, type },
        and(eq(jobs.id, id), eq(jobs.attempts, attempts)),
        { streamId },
      );
    }
    return stuck.length;
  }
}
