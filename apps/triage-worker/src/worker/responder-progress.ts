import { jobs, incidentMessages, withTenant, type Db } from '@sre/db';
import { and, eq, sql } from 'drizzle-orm';
import { RetryableError, type Job } from '@sre/queue';

export interface ResponderProgress {
  base: string | null;
  afterMessageId: string;
  pendingQuestionId: string | null;
}

/** Read the furthest interpreted input across coalesced resume jobs.
 * @param db - Worker database.
 * @param job - Tenant-scoped resume job.
 * @param incidentId - Current locked incident.
 * @param base - Last completed investigation input, distinct from interpretation progress.
 */
export async function readResponderProgress(
  db: Db,
  job: Job,
  incidentId: string,
  base: string | null,
) {
  return withTenant(db, job.tenantId, async (tx) => {
    const [row] = await tx
      .select({ progress: sql<ResponderProgress>`${jobs.payload} -> 'responderProgress'` })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, job.tenantId),
          eq(jobs.type, 'resume'),
          sql`${jobs.payload} ->> 'incidentId' = ${incidentId}`,
          sql`${jobs.payload} -> 'responderProgress' ->> 'base' is not distinct from ${base}`,
          sql`${jobs.payload} -> 'responderProgress' ->> 'afterMessageId' is not null`,
        ),
      )
      .orderBy(
        sql`(select m.created_at from ${incidentMessages} m where m.id::text = ${jobs.payload} -> 'responderProgress' ->> 'afterMessageId' and m.tenant_id = ${job.tenantId} and m.incident_id = ${incidentId}) desc`,
        sql`${jobs.payload} -> 'responderProgress' ->> 'afterMessageId' desc`,
      )
      .limit(1);
    return row?.progress ?? null;
  });
}

/** Checkpoint interpretation without consuming unanswered responder input.
 * @param db - Worker database.
 * @param job - Current attempt, fenced against a replacement lease.
 * @param progress - Last interpreted input and remaining question.
 */
export async function saveResponderProgress(db: Db, job: Job, progress: ResponderProgress) {
  const rows = await db
    .update(jobs)
    .set({
      payload: sql`${jobs.payload} || ${JSON.stringify({ responderProgress: progress })}::jsonb`,
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.tenantId, job.tenantId),
        eq(jobs.type, 'resume'),
        eq(jobs.status, 'processing'),
        eq(jobs.attempts, job.attempts),
      ),
    )
    .returning({ id: jobs.id });
  if (rows.length !== 1) throw new RetryableError('Resume interpretation lost its job lease.');
}

/** Fetch a durable pending question even after it leaves the transcript window.
 * @param db - Worker database.
 * @param tenantId - Authenticated tenant.
 * @param incidentId - Current locked incident.
 * @param id - Previously checkpointed human message.
 */
export async function readResponderMessage(
  db: Db,
  tenantId: string,
  incidentId: string,
  id: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(incidentMessages)
      .where(
        and(
          eq(incidentMessages.id, id),
          eq(incidentMessages.incidentId, incidentId),
          eq(incidentMessages.author, 'human'),
          eq(incidentMessages.kind, 'text'),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}
