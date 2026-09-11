import { scrubSecrets } from '@sre/agent-tools';
import {
  getIncident,
  listIncidentRelations,
  listIncidentSignals,
  setInvestigationStatus,
  type IncidentEvidence,
} from '@sre/db';
import type { Job, JobContext } from '@sre/queue';
import { reloadIncidentEvidence } from './evidence';
import { captureResponderContext } from './responder-context';
import { renderIncidentRelationContext } from '../relation-context';
import type { WorkerDisposition } from './disposition';
import type { EngineToolRuntime, WorkerRuntime } from './runtime';

/** Reassesses one incident after bounded cohort analysis introduces a plausible relation. */
export class RelationReassessmentHandler {
  constructor(
    private readonly runtime: WorkerRuntime,
    private readonly disposition: WorkerDisposition,
  ) {}

  /** Runs evidence-gathering causal comparison without merging either incident. */
  async handle(job: Job, ctx: JobContext): Promise<void> {
    const incidentId = (job.payload as { incidentId?: unknown } | null)?.incidentId;
    if (typeof incidentId !== 'string') return;
    const { deps } = this.runtime;
    await this.runtime.withEngineLock(incidentId, async () => {
      const originMessageId = `relation-assessment:${job.id}`;
      const committed = await deps.hub.appendedByOrigin(job.tenantId, incidentId, originMessageId);
      if (committed) {
        await deps.hub.publishAppended(committed);
        return;
      }
      const [incident, relations, signals] = await Promise.all([
        getIncident(deps.appDb, job.tenantId, incidentId),
        listIncidentRelations(deps.appDb, job.tenantId, incidentId),
        listIncidentSignals(deps.appDb, job.tenantId, incidentId),
      ]);
      if (!incident || (incident.status !== 'open' && incident.status !== 'mitigated')) return;
      const candidates = relations
        .filter((relation) => relation.type === 'possible_related')
        .slice(0, 5);
      if (candidates.length === 0) return;
      const admission = await this.disposition.admitRun(job, incident, 'reassess');
      if (!admission.admitted) return;
      const runId = admission.id;
      const responder = await captureResponderContext(this.runtime, job.tenantId, incidentId);
      const causalCandidates = candidates.map((relation, index) => ({
        ref: index + 1,
        relationId: relation.id,
        incidentId:
          relation.sourceIncidentId === incidentId
            ? relation.targetIncidentId
            : relation.sourceIncidentId,
      }));
      let toolRuntime: EngineToolRuntime | undefined;
      try {
        let evidence: IncidentEvidence[] = [];
        try {
          evidence = await reloadIncidentEvidence(deps, job.tenantId, incidentId);
        } catch {
          console.warn(
            JSON.stringify({
              level: 'warn',
              app: 'triage-worker',
              event: 'relation_reassessment.evidence_reload_failed',
              tenantId: job.tenantId,
              incidentId,
            }),
          );
        }
        await setInvestigationStatus(deps.appDb, job.tenantId, incidentId, 'gathering');
        const runtime = await this.runtime.tools(job.tenantId, incident, { signal: ctx.signal });
        toolRuntime = runtime;
        const context = scrubSecrets(renderIncidentRelationContext(incidentId, candidates));
        await this.disposition.runEngine(
          job.tenantId,
          incident,
          runtime,
          () =>
            this.runtime.executeEngine(job, incidentId, 'reassess', ctx.signal, (engine) =>
              engine.investigate(
                {
                  incident: this.runtime.incidentInput(job.tenantId, incident),
                  mode: incident.trustedAssessmentRunId || incident.rcaSummary ? 'focused' : 'full',
                  alert: {
                    priorAssessment: incident.rcaSummary,
                    signals: signals.map((signal) => ({
                      id: signal.id,
                      state: signal.state,
                      summary: signal.summary,
                    })),
                  },
                  context: `Investigate whether the numbered incident candidate shares a cause with this incident. Establish direction only with current cited evidence. Do not merge records.\n\n${context}\n\n${responder.text}`,
                  evidence,
                },
                runtime,
              ),
            ),
          {
            operation: 'reassess',
            humanMessageFence: responder.fence,
            runId,
            resultOriginMessageId: originMessageId,
            assessmentSignalScope: 'complete',
            assessedMaterials: signals.flatMap((signal) =>
              signal.materialHash
                ? [
                    {
                      signalId: signal.id,
                      signalVersion: signal.version,
                      materialHash: signal.materialHash,
                    },
                  ]
                : [],
            ),
            causalCandidates,
          },
        );
      } catch (error) {
        const completed = await this.disposition.failRun(
          job.tenantId,
          incidentId,
          runId,
          'Causal relation reassessment failed.',
          toolRuntime,
        );
        if (completed)
          await setInvestigationStatus(
            deps.appDb,
            job.tenantId,
            incidentId,
            incident.investigationStatus,
          );
        throw error;
      }
    });
  }
}
