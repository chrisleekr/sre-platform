import type { Db } from '@sre/db';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { Queue, type ClaimedDelivery, type QueueOptions } from './queue';

/**
 * Dedicated classify stream, isolated from the triage stream (`sre:jobs`) so classification volume
 * cannot head-of-line-block triage: the two ride separate Valkey streams + consumer groups, drained by
 * independent consumers. The scoping comes free from construction: `Queue.reconcile()` and the
 * claim only touch rows whose `jobs.stream` matches, so a classify reconcile never scoops a stuck
 * triage row and vice versa.
 */
export const CLASSIFY_STREAM = 'sre:classify';
export const CLASSIFY_GROUP = 'classify-workers';
export const CLASSIFY_DEAD_STREAM = 'sre:classify:dead';

/** Default lookback bounding the last-served derivation (1 hour). See {@link ClassifyQueue}. */
export const DEFAULT_FAIRNESS_WINDOW_SEC = 3600;

/** Fairly selects queued classification work across tenants from the shared stream. */
export class ClassifyQueue extends Queue {
  private readonly getFairnessWindowSec: () => Promise<number>;

  constructor(
    db: Db,
    redis: Redis,
    opts: QueueOptions & {
      fairnessWindowSec?: number;
      getFairnessWindowSec?: () => Promise<number>;
    } = {},
  ) {
    // Pin the classify identifiers by default, but let opts override the stream (tests bind a per-run
    // suffixed stream so the shared Valkey's real sre:classify is never touched). The spread is last so
    // a caller-supplied stream/group wins; production supplies the live window provider.
    super(db, redis, {
      stream: CLASSIFY_STREAM,
      group: CLASSIFY_GROUP,
      deadStream: CLASSIFY_DEAD_STREAM,
      ...opts,
    });
    const fairnessWindowSec = opts.fairnessWindowSec ?? DEFAULT_FAIRNESS_WINDOW_SEC;
    this.getFairnessWindowSec = opts.getFairnessWindowSec ?? (async () => fairnessWindowSec);
  }

  /**
   * The fair-select. Claims the least-recently-served tenant's oldest queued classify row in ONE atomic
   * statement, ignoring the delivered doorbell id.
   *
   * `served` aggregates each tenant's most-recent NON-queued (processing/done/dead = "recently served")
   * `updated_at`, bounded to the last `fairnessWindowSec` so a growing `done` history cannot make the
   * scan unbounded; a tenant older than the window (or never served) has no `served` row, sorts first via
   * NULLS FIRST, and so is preferred. The OUTER query then picks that tenant's oldest `queued` row
   * (created_at ASC tiebreak = work-conserving within a tenant).
   *
   * `FOR UPDATE OF j SKIP LOCKED` is legal here even though `served` aggregates: the aggregation is
   * confined to the CTE, and the OUTER SELECT that carries the lock clause has no GROUP BY / aggregate of
   * its own (it only LEFT JOINs the already-materialized `served`), so the row-level lock has a concrete
   * base row `j` to attach to. SKIP LOCKED is what stops a deterministic fair-select from stampeding: two
   * replicas that would both pick the same "fairest" row instead take DISTINCT rows, and a row
   * another tx already locked is skipped rather than blocked on.
   *
   * The base's `idleMs` staleness reclaim is deliberately absent (see the class doc): a stranded classify
   * row is recovered by reconcile, not here.
   */
  protected override async claimForDelivery(
    _deliveredJobId: string,
    _idleMs: number,
  ): Promise<ClaimedDelivery | null> {
    const fairnessWindowSec = await this.getFairnessWindowSec();
    const rows = (await this.db.execute(sql`
      UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = now()
      WHERE id = (
        WITH served AS (
          SELECT tenant_id, MAX(updated_at) AS last_served
          FROM jobs
          WHERE stream = ${this.stream} AND status <> 'queued'
            AND updated_at >= now() - make_interval(secs => ${fairnessWindowSec})
          GROUP BY tenant_id
        )
        SELECT j.id FROM jobs j
        LEFT JOIN served s ON s.tenant_id = j.tenant_id
        WHERE j.stream = ${this.stream} AND j.status = 'queued' AND j.available_at <= now()
        ORDER BY s.last_served ASC NULLS FIRST, j.created_at ASC
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, tenant_id, type, payload, attempts, created_at
    `)) as unknown as Array<Record<string, unknown>>;
    if (rows.length === 0) return null; // no queued classify work for this doorbell — acked, safe
    const r = rows[0]!;
    const attempts = Number(r.attempts);
    return {
      job: {
        id: String(r.id),
        tenantId: String(r.tenant_id),
        type: String(r.type),
        payload: r.payload,
        attempts,
        createdAt: r.created_at as Date,
      },
      attempts,
    };
  }
}

/**
 * Builds the isolated classification queue with tenant-fair selection.
 *
 * @param db - Database containing durable jobs and fairness history.
 * @param redis - Valkey connection carrying classification doorbells.
 * @param opts - Optional fairness window provider and queue overrides.
 */
export function makeClassifyQueue(
  db: Db,
  redis: Redis,
  opts?: QueueOptions & {
    fairnessWindowSec?: number;
    getFairnessWindowSec?: () => Promise<number>;
  },
): Queue {
  return new ClassifyQueue(db, redis, opts);
}
