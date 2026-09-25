// Tenant read model over the durable work queue. `jobs` is deliberately outside RLS (the worker
// dispatches across tenants), so withTenant does NOT scope it: every query here filters
// jobs.tenant_id explicitly. withTenant is still used so the incidents lookup runs under RLS.
// No index is added: live rows are few, and done/dead rows are pruned after the retention window,
// so jobs_status_idx bounds each scan to a small set.
import type { DeadJob, QueueHealth, QueueHealthRow } from '@sre/contracts';
import { scrubSecrets } from '@sre/contracts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type Executor } from './rls';
import { incidents, jobs } from './schema';

/** Keyset position in the dead-job list. */
export interface DeadJobCursor {
  /** Exact Postgres timestamp text; a JavaScript Date would drop the microseconds and skip rows. */
  updatedAt: string;
  id: string;
}

/** Longest last-error text returned for display. */
export const DEAD_JOB_ERROR_MAX = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Scrub before shortening: a cut could split a credential into a shape the scrubber no longer sees.
function displayError(value: string | null): string | null {
  if (!value) return null;
  const points = [...scrubSecrets(value)];
  return points.length > DEAD_JOB_ERROR_MAX
    ? `${points.slice(0, DEAD_JOB_ERROR_MAX - 1).join('')}…`
    : points.join('');
}

/**
 * Counts a tenant's queued, processing and dead jobs per type, with the oldest due queued job.
 *
 * @param exec - Database executor, or a transaction already bound to this tenant.
 * @param tenantId - Tenant whose jobs are counted.
 * @param now - Clock that decides whether a queued job is due.
 */
export async function readQueueHealth(
  exec: Executor,
  tenantId: string,
  now: Date = new Date(),
): Promise<QueueHealth> {
  // postgres-js binds a Date through drizzle's sql template as an object; pass the ISO text.
  const asOf = now.toISOString();
  const types = await withTenant(exec, tenantId, (tx) =>
    tx
      .select({
        type: jobs.type,
        queued: sql<number>`count(*) filter (where ${jobs.status} = 'queued')::int`,
        processing: sql<number>`count(*) filter (where ${jobs.status} = 'processing')::int`,
        dead: sql<number>`count(*) filter (where ${jobs.status} = 'dead')::int`,
        oldestDueAt: sql<string | null>`to_char(
          min(${jobs.availableAt}) filter (
            where ${jobs.status} = 'queued' and ${jobs.availableAt} <= ${asOf}::timestamptz
          ) at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )`,
      })
      .from(jobs)
      .where(
        and(eq(jobs.tenantId, tenantId), inArray(jobs.status, ['queued', 'processing', 'dead'])),
      )
      .groupBy(jobs.type)
      .orderBy(jobs.type),
  );
  return { asOf, types: types satisfies QueueHealthRow[] };
}

/**
 * Lists a tenant's dead jobs, newest first, without their payloads.
 *
 * @param exec - Database executor, or a transaction already bound to this tenant.
 * @param tenantId - Tenant whose dead jobs are listed.
 * @param input - Page size and the cursor returned by the previous page.
 */
export async function listDeadJobs(
  exec: Executor,
  tenantId: string,
  input: { limit: number; cursor?: DeadJobCursor },
): Promise<{ jobs: DeadJob[]; nextCursor: DeadJobCursor | null }> {
  return withTenant(exec, tenantId, async (tx) => {
    const after = input.cursor
      ? sql`(${jobs.updatedAt}, ${jobs.id}) < (${input.cursor.updatedAt}::timestamptz, ${input.cursor.id}::uuid)`
      : undefined;
    const rows = await tx
      .select({
        id: jobs.id,
        type: jobs.type,
        attempts: jobs.attempts,
        incidentRef: sql<string | null>`${jobs.payload} ->> 'incidentId'`,
        lastError: jobs.lastError,
        createdAt: jobs.createdAt,
        updatedAt: jobs.updatedAt,
        cursorUpdatedAt: sql<string>`${jobs.updatedAt}::text`,
      })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.status, 'dead'), after))
      .orderBy(desc(jobs.updatedAt), desc(jobs.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);

    // The payload is untrusted text: only a UUID that names an incident of this tenant is returned.
    const refs = [
      ...new Set(
        page.flatMap((row) =>
          row.incidentRef && UUID.test(row.incidentRef) ? [row.incidentRef] : [],
        ),
      ),
    ];
    const found = refs.length
      ? await tx
          .select({ id: incidents.id, title: incidents.title })
          .from(incidents)
          .where(and(eq(incidents.tenantId, tenantId), inArray(incidents.id, refs)))
      : [];
    const titles = new Map(found.map((incident) => [incident.id, incident.title]));

    const tail = rows.length > input.limit ? page.at(-1) : undefined;
    return {
      jobs: page.map((row) => {
        const incidentId = row.incidentRef && titles.has(row.incidentRef) ? row.incidentRef : null;
        return {
          id: row.id,
          type: row.type,
          attempts: row.attempts,
          incidentId,
          incidentTitle: incidentId ? (titles.get(incidentId) ?? null) : null,
          lastError: displayError(row.lastError),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
      nextCursor: tail ? { updatedAt: tail.cursorUpdatedAt, id: tail.id } : null,
    };
  });
}
