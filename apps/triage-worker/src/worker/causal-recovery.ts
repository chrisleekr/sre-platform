import {
  clearRecoveryTx,
  getIncidentLifecycleTx,
  listResponseGroupSignalsTx,
  lockResponseGroupWorkTx,
  prepareResponseGroupRecoveryTx,
  promoteCausalFindingsTx,
  resolveResponseRootTx,
  transitionIncidentTx,
  type Tx,
} from '@sre/db';
import type { HubMessage } from '@sre/hub';
import type { TriageResult } from '../engine/types';
import type { WorkerRuntime } from './runtime';

export interface CausalResponseEffects {
  recoveryJobId: string | null;
  lifecycleMessage: HubMessage | null;
  relationshipMessages: HubMessage[];
}

/**
 * Promotes cited causal findings and reconciles lifecycle work for the new response group.
 *
 * @param runtime - Worker dependencies used to persist lifecycle and recovery effects.
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the investigation.
 * @param incidentId - Incident whose conclusive assessment is promoted.
 * @param runId - Completed investigation run supporting the causal decision.
 * @param result - Conclusive assessment containing causal findings.
 * @param evidenceIds - Durable evidence accepted for the completed run.
 */
export async function promoteCausalityAndRefreshRecovery(
  runtime: WorkerRuntime,
  tx: Tx,
  tenantId: string,
  incidentId: string,
  runId: string,
  result: TriageResult,
  evidenceIds: string[],
  candidates: Parameters<typeof promoteCausalFindingsTx>[6],
): Promise<CausalResponseEffects> {
  const findings = result.causalFindings ?? [];
  if (findings.length === 0)
    return { recoveryJobId: null, lifecycleMessage: null, relationshipMessages: [] };
  const previousRoots = new Map<string, string>();
  for (const endpointId of [incidentId, ...candidates.map((candidate) => candidate.incidentId)])
    previousRoots.set(endpointId, await resolveResponseRootTx(tx, tenantId, endpointId));
  const promoted = await promoteCausalFindingsTx(
    tx,
    tenantId,
    incidentId,
    runId,
    findings,
    evidenceIds,
    candidates,
  );
  if (promoted.length === 0)
    return { recoveryJobId: null, lifecycleMessage: null, relationshipMessages: [] };
  const relationshipMessages: HubMessage[] = [];
  for (const relation of promoted)
    for (const endpointId of [relation.sourceIncidentId, relation.targetIncidentId]) {
      const role = endpointId === relation.sourceIncidentId ? 'direct cause' : 'direct symptom';
      const appended = await runtime.deps.hub.appendTxOnce(tx, tenantId, endpointId, {
        author: 'agent',
        kind: 'relationship',
        content: `Causal relationship established: review the ${role} in the relationship panel.`,
        originMessageId: `causal-promotion:${relation.id}:${endpointId}`,
      });
      relationshipMessages.push(appended.message);
    }
  const { rootIncidentId } = await lockResponseGroupWorkTx(tx, tenantId, incidentId);
  const invalidatedRoots = new Set([
    rootIncidentId,
    ...promoted.flatMap((relation) =>
      [relation.sourceIncidentId, relation.targetIncidentId].flatMap((endpointId) => {
        const previousRoot = previousRoots.get(endpointId);
        return previousRoot ? [previousRoot] : [];
      }),
    ),
  ]);
  for (const previousRootId of invalidatedRoots)
    await clearRecoveryTx(tx, tenantId, previousRootId);
  const signals = await listResponseGroupSignalsTx(tx, tenantId, rootIncidentId);
  const root = await getIncidentLifecycleTx(tx, rootIncidentId);
  let lifecycleMessage: HubMessage | null = null;
  if (root && ['resolved', 'closed'].includes(root.status)) {
    const transition = await transitionIncidentTx(tx, rootIncidentId, 'open');
    if (transition.outcome === 'applied')
      lifecycleMessage = await runtime.deps.hub.appendTx(tx, tenantId, rootIncidentId, {
        author: 'system',
        kind: 'lifecycle',
        content: signals.some((signal) => signal.state === 'firing')
          ? 'Incident reopened: A newly confirmed causal symptom is firing.'
          : 'Incident reopened: The response group changed and requires fresh recovery verification.',
        originSurface: 'automation',
        lifecycleFrom: transition.from,
        lifecycleTo: transition.to,
        lifecycleVersion: transition.version!,
        transitionKey: `causal-promotion-refire:${runId}:${rootIncidentId}`,
      });
  }
  const recovery = await prepareResponseGroupRecoveryTx(tx, tenantId, incidentId);
  if (recovery)
    return {
      recoveryJobId: (
        await runtime.deps.queue.insertRecoveryTx(
          tx,
          tenantId,
          recovery.rootIncidentId,
          recovery.lifecycleVersion,
          recovery.signalFence,
        )
      ).jobId,
      lifecycleMessage,
      relationshipMessages,
    };
  return { recoveryJobId: null, lifecycleMessage, relationshipMessages };
}

/**
 * Publishes committed causal lifecycle and recovery effects without replaying the assessment.
 *
 * @param runtime - Worker dependencies used to publish committed effects.
 * @param effects - Lifecycle message and recovery job produced by the assessment transaction.
 */
export async function publishCausalResponseEffects(
  runtime: WorkerRuntime,
  effects: CausalResponseEffects,
): Promise<void> {
  if (effects.lifecycleMessage)
    await runtime.deps.hub.publishAppendedBestEffort(effects.lifecycleMessage);
  for (const message of effects.relationshipMessages)
    await runtime.deps.hub.publishAppendedBestEffort(message);
  if (!effects.recoveryJobId) return;
  await runtime.deps.queue.publishJob(effects.recoveryJobId).catch((error) =>
    console.warn(
      JSON.stringify({
        level: 'warn',
        app: 'triage-worker',
        event: 'causal_recovery.dispatch_failed',
        jobId: effects.recoveryJobId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    ),
  );
}
