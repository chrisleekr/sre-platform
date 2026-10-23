import { jobs, type Db, type Executor } from '@sre/db';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { JobInput } from './contracts';

const TOPOLOGY_TYPE = 'topology.discover';
const TOPOLOGY_COALESCE_INDEX = 'jobs_topology_discover_coalesce_idx';
const RUNBOOK_TYPE = 'runbook.generate';

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
 * Hands a responder's coalesced `runbook.generate` request to the pending automatic pass.
 *
 * @param exec - The enqueue transaction, so the update sees the row the conflict saw.
 * @param input - The incoming job; anything but a non-automatic `runbook.generate` is ignored.
 * @returns False when no pending job will answer the request: the automatic pass already chose
 *   silence or finished. The caller retries the request.
 */
export async function adoptCoalescedRunbookRequest(
  exec: Executor,
  input: JobInput,
): Promise<boolean> {
  if (input.type !== RUNBOOK_TYPE) return true;
  const payload = input.payload as Record<string, unknown> | null | undefined;
  if (!payload || payload.automatic === true) return true;
  // An automatic pass posts nothing when it finds nothing or fails, so the request would go
  // unanswered. The request payload, capture fence included, replaces the automatic marker. A queued
  // row then runs as the request; a processing row already read its payload, so the consumer re-reads
  // it before choosing a prompt. A row that already chose silence is skipped, and the request retries.
  const sameKey = coalesceKeyFilter(input.type, input.payload);
  if (!sameKey) return true;
  const pending = (...filters: SQL[]) =>
    and(
      eq(jobs.tenantId, input.tenantId),
      eq(jobs.type, RUNBOOK_TYPE),
      inArray(jobs.status, ['queued', 'processing']),
      sameKey,
      ...filters,
    );
  const adopted = await exec
    .update(jobs)
    .set({
      payload: sql`(${jobs.payload} - 'automatic') || ${JSON.stringify(payload)}::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(
      pending(
        sql`${jobs.payload}->>'automatic' = 'true'`,
        sql`coalesce(${jobs.payload}->>'silenced', 'false') <> 'true'`,
      ),
    )
    .returning({ id: jobs.id });
  if (adopted.length > 0) return true;
  // Another responder's pending request answers this one too.
  const [answering] = await exec
    .select({ id: jobs.id })
    .from(jobs)
    .where(pending(sql`coalesce(${jobs.payload}->>'automatic', 'false') <> 'true'`))
    .limit(1);
  return answering !== undefined;
}

/**
 * Find the pending job a coalescing index just rejected an insert for. Coalescing indexes on `jobs`
 * key on tenant + type + one payload field ({@link coalesceKeyFilter}). A payload without that field
 * can never conflict. Returns the newest non-terminal match, or null when none survives.
 */
export async function findPendingByCoalesceKey(
  exec: Executor,
  input: JobInput,
): Promise<string | null> {
  const sameKey = coalesceKeyFilter(input.type, input.payload);
  if (!sameKey) return null;
  const rows = await exec
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, input.tenantId),
        eq(jobs.type, input.type),
        sameKey,
        inArray(jobs.status, ['queued', 'processing']),
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
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
