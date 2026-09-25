import {
  getIncident,
  getIncidentLifecycleTx,
  incidentSignalInvestigationTriggerReason,
  listIncidentSignals,
  lockResponseGroupWorkTx,
  setInvestigationStatus,
  transitionIncidentTx,
  withTenant,
  type IncidentEvidence,
} from '@sre/db';
import {
  reassessmentSignalChanges,
  reassessmentTriggerReason,
  type Job,
  type JobContext,
} from '@sre/queue';
import { reloadIncidentEvidence } from './evidence';
import { captureResponderContext } from './responder-context';
import type { WorkerDisposition } from './disposition';
import type { WorkerRuntime } from './runtime';

async function reopenCausalRoot(
  runtime: WorkerRuntime,
  job: Job,
  incidentId: string,
  signal: { id: string; version: number; surface: string },
): Promise<void> {
  const message = await withTenant(runtime.deps.appDb, job.tenantId, async (tx) => {
    const { rootIncidentId } = await lockResponseGroupWorkTx(tx, job.tenantId, incidentId);
    if (rootIncidentId === incidentId) return null;
    const root = await getIncidentLifecycleTx(tx, rootIncidentId);
    if (!root || (root.status !== 'resolved' && root.status !== 'closed')) return null;
    const transition = await transitionIncidentTx(tx, rootIncidentId, 'open', {
      expectedVersion: root.version,
    });
    if (transition.outcome !== 'applied') return null;
    return runtime.deps.hub.appendTx(tx, job.tenantId, rootIncidentId, {
      author: 'system',
      kind: 'lifecycle',
      content: 'Incident reopened: A causal child signal fired again.',
      originSurface: signal.surface,
      lifecycleFrom: transition.from,
      lifecycleTo: transition.to,
      lifecycleVersion: transition.version!,
      transitionKey: `causal-child-refire:${signal.id}:${signal.version}`,
    });
  });
  if (message) await runtime.deps.hub.publishAppendedBestEffort(message);
}

export class ReassessmentHandler {
  constructor(
    private readonly runtime: WorkerRuntime,
    private readonly disposition: WorkerDisposition,
  ) {}

  async handle(job: Job, ctx: JobContext): Promise<void> {
    const { deps } = this.runtime;
    const payload = (job.payload ?? {}) as { incidentId?: string };
    const causalChanges = reassessmentSignalChanges(job.payload);
    if (!payload.incidentId || causalChanges.length === 0) return;
    await this.runtime.withEngineLock(payload.incidentId, async () => {
      const resultOriginMessageId = `signal-assessment:${job.id}`;
      const committed = await deps.hub.appendedByOrigin(
        job.tenantId,
        payload.incidentId!,
        resultOriginMessageId,
      );
      if (committed) {
        await deps.hub.publishAppended(committed);
        return;
      }
      let incident = await getIncident(deps.appDb, job.tenantId, payload.incidentId!);
      if (!incident) return;
      const signals = await listIncidentSignals(deps.appDb, job.tenantId, incident.id);
      const changedSignals = causalChanges.flatMap((change) => {
        const signal = signals.find(
          (row) => row.id === change.signalId && row.version === change.signalVersion,
        );
        return signal && signal.lastInvestigatedVersion !== signal.version ? [signal] : [];
      });
      if (changedSignals.length === 0) return;
      const triggerReason = reassessmentTriggerReason(
        changedSignals.map((signal) => ({
          signalId: signal.id,
          signalVersion: signal.version,
          triggerReason: incidentSignalInvestigationTriggerReason(signals, signal),
        })),
      );
      const firingChange = changedSignals.find((signal) => signal.state === 'firing');
      if (firingChange) await reopenCausalRoot(this.runtime, job, incident.id, firingChange);
      if (firingChange && (incident.status === 'resolved' || incident.status === 'closed')) {
        const reason =
          triggerReason === 'new_episode'
            ? 'A new provider episode started.'
            : 'The monitored signal materially changed while still firing.';
        const reopened = await deps.hub.transitionIncident(job.tenantId, incident.id, {
          to: 'open',
          reason,
          transitionKey: `signal:${firingChange.id}:${firingChange.version}:${firingChange.lastEventType}`,
          author: 'system',
          originSurface: firingChange.surface,
          expectedVersion: incident.lifecycleVersion,
          expectedSignals: changedSignals.map((signal) => ({
            id: signal.id,
            version: signal.version,
            state: signal.state,
          })),
        });
        if (reopened.transition.outcome !== 'applied' && reopened.transition.outcome !== 'noop')
          return;
        incident = (await getIncident(deps.appDb, job.tenantId, incident.id)) ?? incident;
      } else if (incident.status === 'resolved' || incident.status === 'closed') {
        return;
      }
      const admission = await this.disposition.admitRun(job, incident, 'reassess');
      if (!admission.admitted) return;
      const runId = admission.id;
      const responder = await captureResponderContext(this.runtime, job.tenantId, incident.id);
      const focused =
        triggerReason === 'material_change' &&
        Boolean(incident.trustedAssessmentRunId || incident.rcaSummary);
      const assessedMaterials = (focused ? changedSignals : signals).flatMap((current) =>
        current.materialHash
          ? [
              {
                signalId: current.id,
                signalVersion: current.version,
                materialHash: current.materialHash,
              },
            ]
          : [],
      );
      let toolRuntime: Awaited<ReturnType<WorkerRuntime['tools']>>;
      let evidence: IncidentEvidence[] = [];
      try {
        await setInvestigationStatus(deps.appDb, job.tenantId, incident.id, 'gathering');
        try {
          evidence = await reloadIncidentEvidence(deps, job.tenantId, incident.id);
        } catch {
          console.warn(
            JSON.stringify({
              level: 'warn',
              app: 'triage-worker',
              event: 'reassessment.evidence_reload_failed',
              tenantId: job.tenantId,
              incidentId: incident.id,
            }),
          );
        }
        toolRuntime = await this.runtime.tools(job.tenantId, incident, { signal: ctx.signal });
      } catch (error) {
        const completed = await this.disposition.failRun(
          job.tenantId,
          incident.id,
          runId,
          'Investigation setup failed.',
        );
        if (completed)
          await setInvestigationStatus(
            deps.appDb,
            job.tenantId,
            incident.id,
            incident.investigationStatus,
          );
        throw error;
      }
      await this.disposition.runEngine(
        job.tenantId,
        incident,
        toolRuntime,
        () =>
          this.runtime.executeEngine(job, incident.id, 'reassess', ctx.signal, (engine) =>
            engine.investigate(
              {
                incident: this.runtime.incidentInput(job.tenantId, incident),
                mode: focused ? 'focused' : 'full',
                alert: {
                  priorAssessment: {
                    trustedRunId: incident.trustedAssessmentRunId,
                    summary: incident.rcaSummary,
                    confidence: incident.confidence,
                    currentState: incident.currentState,
                    impact: incident.impact,
                    rankedHypotheses: incident.rankedHypotheses,
                    unknowns: incident.unknowns,
                    nextStep: incident.nextStep,
                    evidenceIds: incident.assessmentEvidenceIds,
                  },
                  materialDeltas: changedSignals.map((signal) => ({
                    triggerReason: incidentSignalInvestigationTriggerReason(signals, signal),
                    signalId: signal.id,
                    state: signal.state,
                    eventType: signal.lastEventType,
                    summary: signal.summary,
                    version: signal.version,
                  })),
                  signals: signals.map((current) => ({
                    id: current.id,
                    state: current.state,
                    eventType: current.lastEventType,
                    summary: current.summary,
                    version: current.version,
                  })),
                },
                context: [
                  responder.text,
                  toolRuntime.platformIdentity,
                  focused
                    ? 'Reassess only the material delta against the trusted prior assessment and durable evidence. Preserve conclusions the new evidence does not contradict.'
                    : triggerReason === 'new_episode'
                      ? 'A new provider episode started. Perform a full investigation of the complete current signal set.'
                      : 'Investigate the complete current signal set because no focused material-delta path applies.',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
                evidence,
              },
              toolRuntime,
            ),
          ),
        {
          operation: 'reassess',
          humanMessageFence: responder.fence,
          runId,
          assessmentCause: 'signal',
          resultOriginMessageId,
          assessmentSignalScope: focused ? 'causal' : 'complete',
          assessedMaterials,
        },
      );
    });
  }
}
