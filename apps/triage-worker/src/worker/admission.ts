import type { InvestigationOperation, InvestigationTrigger } from '@sre/contracts';
import {
  admitInvestigationRunTx,
  getInvestigationSubject,
  incidentInvestigationMonitorKeys,
  incidentSignalInvestigationTriggerReason,
  listIncidentSignals,
  setInvestigationStatusTx,
  withTenant,
  type Tx,
} from '@sre/db';
import type { HubMessage } from '@sre/hub';
import { reassessmentSignalChanges, reassessmentTriggerReason, type Job } from '@sre/queue';

import type { IncidentRow } from './contracts';
import type { WorkerRuntime } from './runtime';

/** Loads the automatic rolling-budget policy used by one admission transaction. */
export async function automaticInvestigationBudgetLimits(runtime: WorkerRuntime) {
  return (
    (await runtime.deps.getAutomaticInvestigationBudget?.()) ?? {
      tenantRunLimit: 0,
      monitorRunLimit: 0,
      tenantConfiguredCostLimitUsd: 0,
      monitorConfiguredCostLimitUsd: 0,
      configuredCostReady: false,
    }
  );
}

async function investigationTrigger(
  runtime: WorkerRuntime,
  job: Job,
  incident: IncidentRow,
  operation: InvestigationOperation,
): Promise<InvestigationTrigger> {
  if (operation === 'resume')
    return { reason: 'human_continuation', automatic: false, monitorKey: null };

  const signals = await listIncidentSignals(runtime.deps.appDb, job.tenantId, incident.id);
  const automaticMonitorKeys = incidentInvestigationMonitorKeys(incident, signals);
  if (operation === 'verify-recovery') {
    return {
      reason: 'recovery_verification',
      automatic: true,
      monitorKey: automaticMonitorKeys.length === 1 ? automaticMonitorKeys[0]! : null,
      monitorKeys: automaticMonitorKeys,
    };
  }
  if (operation === 'reassess') {
    if (job.type === 'relation.reassess')
      return {
        reason: 'material_change',
        automatic: true,
        monitorKey: automaticMonitorKeys.length === 1 ? automaticMonitorKeys[0]! : null,
        monitorKeys: automaticMonitorKeys,
      };
    const changes = reassessmentSignalChanges(job.payload);
    const changedSignals = changes.flatMap((change) => {
      const signal = signals.find(
        (current) => current.id === change.signalId && current.version === change.signalVersion,
      );
      return signal && signal.lastInvestigatedVersion !== signal.version
        ? [{ signal, change }]
        : [];
    });
    if (changedSignals.length === 0)
      throw new Error('reassessment trigger signals are unavailable');
    const derivedChanges = changedSignals.map(({ signal, change }) => ({
      ...change,
      triggerReason: incidentSignalInvestigationTriggerReason(signals, signal),
    }));
    const monitorKeys = incidentInvestigationMonitorKeys(
      incident,
      changedSignals.map(({ signal }) => signal),
    );
    return {
      reason: reassessmentTriggerReason(derivedChanges),
      automatic: true,
      monitorKey: monitorKeys.length === 1 ? monitorKeys[0]! : null,
      monitorKeys,
    };
  }

  const [opener, subject] = await Promise.all([
    runtime.deps.hub.opener(job.tenantId, incident.id),
    getInvestigationSubject(runtime.deps.appDb, job.tenantId, incident.id),
  ]);
  const manual =
    incident.alertSource === 'manual' || opener?.author === 'human' || subject !== null;
  return manual
    ? { reason: 'manual_investigation', automatic: false, monitorKey: null }
    : {
        reason: 'new_episode',
        automatic: true,
        monitorKey: automaticMonitorKeys.length === 1 ? automaticMonitorKeys[0]! : null,
        monitorKeys: automaticMonitorKeys,
      };
}

/**
 * Applies the configured rolling guard before one worker run starts.
 *
 * @param runtime - Worker dependencies and settings access.
 * @param job - Durable queue job carrying trigger provenance.
 * @param incident - Incident targeted by the job.
 * @param operation - Investigation operation the worker will execute.
 */
export async function admitWorkerRun(
  runtime: WorkerRuntime,
  job: Job,
  incident: IncidentRow,
  operation: InvestigationOperation,
) {
  const trigger = await investigationTrigger(runtime, job, incident, operation);
  const limits = trigger.automatic
    ? await automaticInvestigationBudgetLimits(runtime)
    : {
        tenantRunLimit: 0,
        monitorRunLimit: 0,
        tenantConfiguredCostLimitUsd: 0,
        monitorConfiguredCostLimitUsd: 0,
        configuredCostReady: false,
      };
  const result = await withTenant(runtime.deps.appDb, job.tenantId, async (tx) => {
    const admission = await admitInvestigationRunTx(tx, job.tenantId, incident.id, {
      jobId: job.id,
      operation,
      trigger,
      limits,
    });
    const message = admission.admitted
      ? null
      : await appendWorkerBudgetExhaustedTx(runtime, tx, job.tenantId, incident, admission.id);
    return { admission, message };
  });
  if (result.message) await runtime.deps.hub.publishAppendedBestEffort(result.message);
  return result.admission;
}

/**
 * Appends the budget blocker beside its rejected run inside the admission transaction.
 *
 * @param runtime - Worker dependencies used for incident and conversation writes.
 * @param tx - Tenant transaction that inserted the rejected run.
 * @param tenantId - Tenant that owns the incident.
 * @param incident - Incident whose automatic budget was exhausted.
 * @param runId - Terminal budget-exhausted run identifier.
 */
export async function appendWorkerBudgetExhaustedTx(
  runtime: WorkerRuntime,
  tx: Tx,
  tenantId: string,
  incident: IncidentRow,
  runId: string,
): Promise<HubMessage> {
  await setInvestigationStatusTx(
    tx,
    incident.id,
    incident.trustedAssessmentRunId || incident.rcaSummary ? 'assessed' : 'degraded',
  );
  return (
    await runtime.deps.hub.appendTxOnce(tx, tenantId, incident.id, {
      author: 'system',
      kind: 'finding',
      content:
        'Automatic investigation paused because its rolling budget is exhausted. Send a responder message to continue now.',
      summary:
        'Investigation blocked by the automatic budget. A responder can continue the investigation manually.',
      finding: {
        runId,
        outcome: 'budget_exhausted',
        promotion: 'not_promoted',
        promotionReason: 'budget_exhausted',
        evidenceIds: [],
        currentState: null,
        impact: null,
        nextStep: 'Send a responder message to continue outside the automatic budget.',
      },
      originMessageId: `budget-exhausted:${runId}`,
    })
  ).message;
}
