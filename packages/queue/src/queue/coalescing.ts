import { jobs, type Db, type Executor } from '@sre/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { JobInput } from './contracts';

const TOPOLOGY_TYPE = 'topology.discover';
const TOPOLOGY_COALESCE_INDEX = 'jobs_topology_discover_coalesce_idx';

/**
 * Predicate matching rows that share this job's coalescing key, or null when the payload has none.
 * Maps `topology.discover` to `connectorId` and every other type to `incidentId`. `cohort.analyze`
 * coalesces on `cohortId` and is not looked up here. The field is inlined, not bound: it is a closed
 * pair, and an untyped bound key would make `jsonb ->>` ambiguous between its text and integer
 * overloads.
 */
export function coalesceKeyFilter(type: string, payload: unknown): SQL | null {
  const field = type === TOPOLOGY_TYPE ? 'connectorId' : 'incidentId';
  const key = (payload as Record<string, unknown> | null | undefined)?.[field];
  return typeof key === 'string' ? sql`payload->>${sql.raw(`'${field}'`)} = ${key}` : null;
}

/**
 * After a `topology.discover` insert coalesced, widen the queued row to a full pass when the incoming
 * payload is one. A queued page continuation reads only some collections, so absorbing the scheduler's
 * full pass into it would skip the other collections for that cycle. A continuation colliding with a
 * queued full pass stays absorbed, because the full pass resumes the stored cursors. Runs on the
 * enqueue transaction so the widen and the conflict see the same row.
 */
export async function widenCoalescedTopologyPass(exec: Executor, input: JobInput): Promise<void> {
  if (input.type !== TOPOLOGY_TYPE) return;
  const payload = input.payload as Record<string, unknown> | null | undefined;
  if (payload && 'collections' in payload) return;
  const sameKey = coalesceKeyFilter(input.type, input.payload);
  if (!sameKey) return;
  await exec
    .update(jobs)
    .set({
      payload: sql`${jobs.payload} - 'collections' - 'pageCount'`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(jobs.tenantId, input.tenantId),
        eq(jobs.type, TOPOLOGY_TYPE),
        eq(jobs.status, 'queued'),
        sameKey,
      ),
    );
}

/**
 * The constraint of a 23505 unique violation, or undefined for any other error. Drizzle wraps driver
 * errors, so the SQLSTATE can sit a few `cause` links down.
 */
function uniqueViolationConstraint(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: string; constraint_name?: string; cause?: unknown };
    if (value.code === '23505') return value.constraint_name ?? '';
    current = value.cause;
  }
  return undefined;
}

/**
 * Put a row back to `queued`, or retire it when a queued topology successor already holds its
 * coalescing slot. The successor redoes the work, so competing with it would only violate the queued
 * uniqueness fence. Only the topology index retires: every other type rethrows its 23505 and keeps its
 * existing retry behaviour. Returns whether the row was requeued.
 */
export async function requeueUnlessSuperseded(
  db: Db,
  job: { id: string; type: string },
  where: SQL | undefined,
  fields: { lastError?: string; streamId?: string | null },
): Promise<boolean> {
  try {
    const rows = await db
      .update(jobs)
      .set({ status: 'queued', ...fields, updatedAt: sql`now()` })
      .where(where)
      .returning({ id: jobs.id });
    return rows.length > 0;
  } catch (error) {
    if (uniqueViolationConstraint(error) !== TOPOLOGY_COALESCE_INDEX) throw error;
    await db
      .update(jobs)
      .set({ status: 'done', lastError: fields.lastError, updatedAt: sql`now()` })
      .where(and(where, eq(jobs.status, 'processing')));
    // A pass that keeps failing is retired each time a successor exists, so it never reaches the
    // dead-letter cap; this line is the only trace of the failure.
    console.warn(
      JSON.stringify({
        level: 'warn',
        pkg: '@sre/queue',
        msg: 'retired superseded job after failure',
        jobId: job.id,
        type: job.type,
        hadError: fields.lastError !== undefined,
      }),
    );
    return false;
  }
}
