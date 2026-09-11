import type { InvestigationOperation } from '@sre/contracts';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Tx } from './rls';
import { investigationRuns } from './schema';

/**
 * Marks interrupted runs terminal before a newer manual attempt starts.
 *
 * @param tx - Existing transaction that carries tenant scope.
 * @param incidentId - Incident whose pending attempts are superseded.
 */
export async function supersedePendingRunsTx(tx: Tx, incidentId: string): Promise<void> {
  await tx
    .update(investigationRuns)
    .set({
      outcome: 'failed',
      result: {
        summary: 'A newer attempt superseded this interrupted investigation run.',
        reason: 'superseded_pending_run',
      },
      completedAt: sql`now()`,
    })
    .where(
      and(eq(investigationRuns.incidentId, incidentId), isNull(investigationRuns.completedAt)),
    );
}

/**
 * Reports whether an incident already owns an unfinished investigation attempt.
 *
 * @param tx - Existing transaction that carries tenant scope.
 * @param incidentId - Incident checked for pending work.
 */
export async function hasPendingIncidentRunTx(tx: Tx, incidentId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: investigationRuns.id })
    .from(investigationRuns)
    .where(and(eq(investigationRuns.incidentId, incidentId), isNull(investigationRuns.completedAt)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Reuses the admission created by an earlier delivery of the same durable queue job.
 *
 * @param tx - Existing transaction that carries tenant scope.
 * @param tenantId - Tenant that owns the queue job.
 * @param incidentId - Incident targeted by the queue job.
 * @param jobId - Durable queue job identifier.
 * @param operation - Investigation operation assigned to the job.
 */
export async function existingJobAdmissionTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  jobId: string,
  operation: InvestigationOperation,
) {
  const [existing] = await tx
    .select({
      id: investigationRuns.id,
      admissionDenied: investigationRuns.admissionDenied,
      budget: investigationRuns.triggerBudget,
    })
    .from(investigationRuns)
    .where(
      and(
        eq(investigationRuns.tenantId, tenantId),
        eq(investigationRuns.incidentId, incidentId),
        eq(investigationRuns.jobId, jobId),
        eq(investigationRuns.operation, operation),
        or(isNull(investigationRuns.completedAt), eq(investigationRuns.admissionDenied, true)),
      ),
    )
    .limit(1);
  return existing
    ? { id: existing.id, admitted: !existing.admissionDenied, budget: existing.budget }
    : null;
}
