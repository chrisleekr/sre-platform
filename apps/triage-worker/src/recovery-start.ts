import { prepareResponseGroupRecoveryTx, resolveReportedSignalsTx, type Tx } from '@sre/db';
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
  // active, an earlier clear may already have queued it; insertRecoveryTx merges into that job.
  const recovery =
    resolved.length > 0 || (active === 0 && !durable)
      ? await prepareResponseGroupRecoveryTx(tx, tenantId, incidentId)
      : null;
  const { jobId, coalesced } = recovery
    ? await queue.insertRecoveryTx(
        tx,
        tenantId,
        recovery.rootIncidentId,
        recovery.lifecycleVersion,
        recovery.signalFence,
      )
    : { jobId: null, coalesced: undefined };
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
