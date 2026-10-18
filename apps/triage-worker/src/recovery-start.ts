import { and, eq, inArray, sql } from 'drizzle-orm';
import { jobs, prepareResponseGroupRecoveryTx, resolveReportedSignalsTx, type Tx } from '@sre/db';
import type { Queue } from '@sre/queue';

/** Status text when every alert cleared but no verification job could be queued. */
export const RECOVERY_NOT_QUEUED =
  'Recovery verification is not available for this incident: its check budget is spent or recovery was already judged not verified. Resolve it from the lifecycle controls once the service is confirmed healthy.';

/** Resolve Slack-born alerts covered by recorded recovery reports, then queue verification.
 * @param tx - Tenant transaction.
 * @param queue - Durable work queue.
 * @param tenantId - Owning tenant.
 * @param incidentId - Incident whose recovery is checked.
 */
export async function startReportedRecoveryTx(
  tx: Tx,
  queue: Pick<Queue, 'insertRecoveryTx'>,
  tenantId: string,
  incidentId: string,
) {
  const { resolved, active, durable } = await resolveReportedSignalsTx(tx, tenantId, incidentId);
  // Verification starts only when every signal in the response group is resolved. With nothing left
  // active, an earlier clear already decided it. Only a clear that changed a signal queues: merging
  // into the job would make a scheduled recheck due now and spend the check budget early.
  const recovery =
    resolved.length > 0 || (active === 0 && !durable)
      ? await prepareResponseGroupRecoveryTx(tx, tenantId, incidentId)
      : null;
  const { jobId, coalesced } = !recovery
    ? { jobId: null, coalesced: undefined }
    : resolved.length > 0
      ? await queue.insertRecoveryTx(
          tx,
          tenantId,
          recovery.rootIncidentId,
          recovery.lifecycleVersion,
          recovery.signalFence,
        )
      : { jobId: null, coalesced: await recoveryPendingTx(tx, tenantId, recovery.rootIncidentId) };
  // A prepared recovery can still queue nothing: the check budget is spent or recovery was already
  // judged not verified. A merge into an already queued check still counts as queued.
  return {
    resolved,
    active,
    durable,
    prepared: recovery !== null,
    queued: jobId !== null || coalesced === true,
    jobId,
  };
}

// Whether a recovery check is queued or running for the response root.
async function recoveryPendingTx(tx: Tx, tenantId: string, rootIncidentId: string) {
  const [pending] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.type, 'recovery.verify'),
        inArray(jobs.status, ['queued', 'processing']),
        sql`${jobs.payload}->>'incidentId' = ${rootIncidentId}`,
      ),
    )
    .limit(1);
  return pending ? (true as const) : undefined;
}
