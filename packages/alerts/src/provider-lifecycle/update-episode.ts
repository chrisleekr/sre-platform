import { assertAlertConnectorGeneration } from './generation';
import { getIncidentLifecycleTx, prepareResponseGroupRecoveryTx, withTenant } from '@sre/db';
import type { HubMessage } from '@sre/hub';
import type { NativeLifecycleDeps as AlertmanagerWebhookDeps } from './contracts';
import { signalObservation, alertText, type NormalizedAlert } from './normalize';
import { recordAlertmanagerDisposition } from './disposition';
export async function updateAcceptedEpisode(
  deps: AlertmanagerWebhookDeps,
  tenantId: string,
  connectorId: string,
  incidentId: string,
  groupKey: string,
  alert: NormalizedAlert,
  materialHash: string,
  observedAt: Date,
  thread: { channel: string; threadId: string },
  lifecycleVersion?: number,
  observationLifecycleVersion?: number,
): Promise<void> {
  let currentIncidentId = incidentId;
  for (let attempt = 0; attempt < 2; attempt++) {
    let message: HubMessage | null = null;
    let jobId: string | null = null;
    let movedTo: string | null = null;
    await withTenant(deps.appDb, tenantId, async (tx) => {
      await assertAlertConnectorGeneration(tx, { id: connectorId, tenantId, lifecycleVersion });
      const observed = await deps.hub.observeSignalTx(
        tx,
        tenantId,
        {
          incidentId: currentIncidentId,
          ...signalObservation(
            connectorId,
            groupKey,
            alert,
            materialHash,
            observedAt,
            observationLifecycleVersion,
          ),
        },
        alertText(alert),
      );
      message = observed.message;
      if (!observed.observation.applied) {
        // A human merge can move the episode after this delivery read its intake. Retry against the
        // signal's current owner in a fresh transaction so the provider update is not silently lost.
        if (!observed.message && observed.observation.signal.incidentId !== currentIncidentId)
          movedTo = observed.observation.signal.incidentId;
        return;
      }
      const lifecycle = await getIncidentLifecycleTx(tx, currentIncidentId);
      if (!lifecycle) throw new Error('provider episode incident disappeared');
      if (observed.observation.allResolved) {
        const recovery = await prepareResponseGroupRecoveryTx(tx, tenantId, currentIncidentId);
        if (!recovery) return;
        jobId = (
          await deps.route.queue.insertRecoveryTx(
            tx,
            tenantId,
            recovery.rootIncidentId,
            recovery.lifecycleVersion,
            recovery.signalFence,
          )
        ).jobId;
      } else {
        jobId = (
          await deps.route.queue.insertReassessmentTx(
            tx,
            tenantId,
            currentIncidentId,
            observed.observation.signal.id,
            observed.observation.signal.version,
            observed.observation.investigationTriggerReason,
          )
        ).jobId;
      }
    });
    if (movedTo) {
      currentIncidentId = movedTo;
      continue;
    }
    if (message)
      await deps.hub.publishAppended(message).catch((error) =>
        deps.log?.error('Alertmanager signal publish failed; durable replay will recover', {
          tenantId,
          incidentId: currentIncidentId,
          operation: 'hub_publish',
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
    if (jobId)
      await deps.route.queue.publishJob(jobId).catch((error) =>
        deps.log?.error('Alertmanager job publish failed; queue reconciliation will recover', {
          tenantId,
          incidentId: currentIncidentId,
          jobId,
          operation: 'job_publish',
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
    await recordAlertmanagerDisposition({
      db: deps.appDb,
      tenantId,
      connectorId,
      incidentId: currentIncidentId,
      channel: thread.channel,
      threadId: thread.threadId,
      eventKey: `${alert.provider ?? 'alertmanager'}:${connectorId}:${alert.fingerprint}:${alert.startsAt.toISOString()}:${alert.status}:${materialHash}`,
      signalKey: `${alert.provider ?? 'alertmanager'}:${connectorId}:${alert.fingerprint}:${alert.startsAt.toISOString()}`,
      observedAt,
      alert,
    });
    return;
  }
  throw new Error('provider episode moved repeatedly during update');
}
