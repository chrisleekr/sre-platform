import { jobs, type Tx } from '@sre/db';

/** Inserts the single delayed analysis job for a fixed alert cohort. */
export async function insertCohortAnalysisJobTx(
  tx: Tx,
  tenantId: string,
  cohortId: string,
  stream: string,
  availableAt: Date,
): Promise<{ jobId: string | null }> {
  const inserted = await tx
    .insert(jobs)
    .values({
      tenantId,
      type: 'cohort.analyze',
      payload: { cohortId },
      status: 'queued',
      stream,
      availableAt,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return { jobId: inserted[0]?.id ?? null };
}

/** Inserts the single pending causal-candidate reassessment for an incident. */
export async function insertRelationReassessmentJobTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  stream: string,
): Promise<{ jobId: string | null }> {
  const inserted = await tx
    .insert(jobs)
    .values({
      tenantId,
      type: 'relation.reassess',
      payload: { incidentId },
      status: 'queued',
      stream,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return { jobId: inserted[0]?.id ?? null };
}
