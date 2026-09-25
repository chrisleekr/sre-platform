import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../rls';
import {
  INVESTIGATION_STATUSES,
  incidents,
  investigationRuns,
  jobs,
  type InvestigationStatus,
} from '../schema';

/**
 * Returns the stable investigation state saved in a recovery job payload.
 *
 * @param payload - Durable recovery job payload inspected for the saved state.
 */
export function recoveryRestoreStatus(payload: unknown): InvestigationStatus | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).restoreInvestigationStatus;
  return INVESTIGATION_STATUSES.includes(value as InvestigationStatus)
    ? (value as InvestigationStatus)
    : null;
}

/**
 * Invalidates recovery projection while retaining enough ownership to restore an in-flight run.
 *
 * @param tx - Existing transaction carrying tenant scope and the incident row lock.
 * @param tenantId - Tenant that owns the incident and recovery jobs.
 * @param incidentId - Incident whose recovery projection is invalidated.
 * @param responseGroupIds - Locked group whose joint resolution basis is invalidated.
 */
export async function clearRecoveryTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  responseGroupIds: string[] = [incidentId],
): Promise<void> {
  if (responseGroupIds.length > 1)
    await tx
      .update(incidents)
      .set({ resolutionBasis: null })
      .where(inArray(incidents.id, responseGroupIds));
  const [active] = await tx
    .select({
      investigationStatus: incidents.investigationStatus,
      recoveryRunId: incidents.recoveryRunId,
      jobPayload: jobs.payload,
    })
    .from(incidents)
    .leftJoin(investigationRuns, eq(investigationRuns.id, incidents.recoveryRunId))
    .leftJoin(jobs, and(eq(jobs.tenantId, tenantId), eq(jobs.id, investigationRuns.jobId)))
    .where(eq(incidents.id, incidentId))
    .limit(1);
  const savedStatus = recoveryRestoreStatus(active?.jobPayload);
  const restoreStatus =
    active?.investigationStatus === 'gathering' && savedStatus && savedStatus !== 'gathering'
      ? savedStatus
      : null;

  await tx
    .update(jobs)
    .set({ status: 'done', updatedAt: sql`now()` })
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.type, 'recovery.verify'),
        eq(jobs.status, 'queued'),
        sql`${jobs.payload}->>'incidentId' = ${incidentId}`,
      ),
    );
  await tx
    .update(incidents)
    .set({
      ...(restoreStatus ? { investigationStatus: restoreStatus } : {}),
      resolutionBasis: null,
      recoveryState: null,
      recoverySummary: null,
      recoveryEvidenceIds: null,
      recoveryUnknowns: null,
      recoveryQuestions: null,
      recoveryQuestionsUpdatedAt: null,
      recoveryNextStep: null,
      recoveryUpdatedAt: null,
      recoveryRunId:
        active?.investigationStatus === 'gathering' && !restoreStatus ? active.recoveryRunId : null,
      recoveryAttempt: null,
      recoveryMaxChecks: null,
      recoveryNextCheckAt: null,
      recoveryScheduleReason: null,
      updatedAt: sql`now()`,
    })
    .where(eq(incidents.id, incidentId));
}
