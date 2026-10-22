import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  clearRecoveryTx,
  incidents,
  jobs,
  prepareResponseGroupRecoveryTx,
  resolveReportedSignalsTx,
  type Tx,
} from '@sre/db';
import type { Queue } from '@sre/queue';

/** Status text when every alert cleared but no verification job could be queued. */
export const RECOVERY_NOT_QUEUED =
  'Recovery verification is not available for this incident: its check budget is spent or recovery was already judged not verified. Resolve it from the lifecycle controls once the service is confirmed healthy.';

/** Resolve Slack-born alerts covered by recorded recovery reports, then queue verification.
 * @param tx - Tenant transaction.
 * @param queue - Durable work queue.
 * @param tenantId - Owning tenant.
 * @param incidentId - Incident whose recovery is checked.
 * @param options - `restartFinished` lets a responder's explicit request start a new check after an
 * earlier one ended not verified or spent its budget. Without it that verdict is final until the
 * alert re-fires, so an alert that stays quiet would leave the incident open forever.
 */
export async function startReportedRecoveryTx(
  tx: Tx,
  queue: Pick<Queue, 'insertRecoveryTx'>,
  tenantId: string,
  incidentId: string,
  options: { restartFinished?: boolean } = {},
) {
  const { resolved, active, durable, closed } = await resolveReportedSignalsTx(
    tx,
    tenantId,
    incidentId,
  );
  // Verification starts only when every signal in the response group is resolved. With nothing left
  // active, an earlier clear already decided it. Only a clear that changed a signal queues: merging
  // into the job would make a scheduled recheck due now and spend the check budget early.
  const recovery =
    resolved.length > 0 || (active === 0 && !durable && !closed)
      ? await prepareResponseGroupRecoveryTx(tx, tenantId, incidentId)
      : null;
  const restart =
    recovery !== null &&
    options.restartFinished === true &&
    (await recoveryFinishedTx(tx, tenantId, recovery.rootIncidentId));
  // The signal locks taken above cover the clear; the next check starts with a fresh budget.
  if (restart) await clearRecoveryTx(tx, tenantId, recovery.rootIncidentId);
  const { jobId, coalesced } = !recovery
    ? { jobId: null, coalesced: undefined }
    : resolved.length > 0 || restart
      ? await queue.insertRecoveryTx(
          tx,
          tenantId,
          recovery.rootIncidentId,
          recovery.lifecycleVersion,
          recovery.signalFence,
        )
      : { jobId: null, coalesced: await recoveryPendingTx(tx, tenantId, recovery.rootIncidentId) };
  // A prepared recovery can still queue nothing: the queue refuses a finished verdict that was not
  // restarted, or no signal changed and no check is pending. A merge into a queued check still counts.
  return {
    resolved,
    active,
    durable,
    closed: closed === true,
    prepared: recovery !== null,
    queued: jobId !== null || coalesced === true,
    jobId,
  };
}

// Mirrors the queue's refusal: a not-verified verdict, or a spent budget with no check in flight.
async function recoveryFinishedTx(tx: Tx, tenantId: string, rootIncidentId: string) {
  const [incident] = await tx
    .select({
      resolutionPolicy: incidents.resolutionPolicy,
      recoveryState: incidents.recoveryState,
      recoveryAttempt: incidents.recoveryAttempt,
      recoveryMaxChecks: incidents.recoveryMaxChecks,
    })
    .from(incidents)
    .where(and(eq(incidents.tenantId, tenantId), eq(incidents.id, rootIncidentId)))
    .limit(1);
  if (!incident || incident.resolutionPolicy === 'provider_clear') return false;
  return (
    incident.recoveryState === 'not_verified' ||
    (incident.recoveryState !== 'verifying' &&
      incident.recoveryAttempt !== null &&
      incident.recoveryMaxChecks !== null &&
      incident.recoveryAttempt >= incident.recoveryMaxChecks)
  );
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
