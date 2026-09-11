import * as z from 'zod';
import {
  claimAlertCohortAnalysis,
  admitInvestigationRun,
  completeInvestigationRun,
  completeInvestigationRunTx,
  getIncident,
  incidentInvestigationMonitorKeys,
  listIncidentSignals,
  recordAgentCohortRelationTx,
  settleAlertCohortTx,
  withTenant,
} from '@sre/db';
import { RetryableError, type Job } from '@sre/queue';
import { encodeForModel } from '../engine/toon';
import { ProviderUnavailableError } from '../engine/types';
import { publicModelText } from '../public-output';
import { automaticInvestigationBudgetLimits } from './admission';
import type { WorkerRuntime } from './runtime';

const cohortDecisionSchema = z.object({
  decisions: z
    .array(
      z.object({
        sourceRef: z.number().int().min(1).max(5),
        targetRef: z.number().int().min(1).max(5),
        decision: z.enum(['possible_related', 'unrelated']),
        rationale: z.string().min(1).max(1_000),
        confidence: z.number().min(0).max(100),
      }),
    )
    .max(10),
});

/** Runs one bounded relationship analysis after a fixed alert cohort finishes collecting. */
export class CohortAnalysisHandler {
  constructor(private readonly runtime: WorkerRuntime) {}

  /** Handles one coalesced cohort job without changing incident ownership. */
  async handle(job: Job, signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const cohortId = (job.payload as { cohortId?: unknown } | null)?.cohortId;
    if (typeof cohortId !== 'string') return;
    const { deps } = this.runtime;
    const analysis = await claimAlertCohortAnalysis(deps.appDb, job.tenantId, cohortId, job.id);
    if (!analysis) return;
    if (analysis.incidents.length < 2) {
      await withTenant(deps.appDb, job.tenantId, (tx) => settleAlertCohortTx(tx, cohortId));
      return;
    }
    const anchor = await getIncident(deps.appDb, job.tenantId, analysis.incidents[0]!.id);
    if (!anchor) return;
    await this.runtime.withEngineLock(anchor.id, async () => {
      const anchorSignals = await listIncidentSignals(deps.appDb, job.tenantId, anchor.id);
      const monitorKeys = incidentInvestigationMonitorKeys(anchor, anchorSignals);
      const admission = await admitInvestigationRun(deps.appDb, job.tenantId, anchor.id, {
        jobId: job.id,
        operation: 'reassess',
        trigger: {
          reason: 'material_change',
          automatic: true,
          monitorKey: monitorKeys.length === 1 ? monitorKeys[0]! : null,
          monitorKeys,
        },
        limits: await automaticInvestigationBudgetLimits(this.runtime),
        turnBudget: 1,
      });
      if (!admission.admitted) {
        await withTenant(deps.appDb, job.tenantId, (tx) => settleAlertCohortTx(tx, cohortId));
        return;
      }
      const prompt = [
        'Compare this provider-scoped, time-bounded alert cohort.',
        'Timing is candidate generation only, never proof. Return possible_related only when content suggests a plausible shared cause. Return unrelated when the evidence distinguishes the conditions. Omit uncertain pairs. Do not merge incidents and do not infer causal direction.',
        encodeForModel(analysis.incidents.map(({ id: _id, ...incident }) => incident)),
      ].join('\n\n');
      let result: z.infer<typeof cohortDecisionSchema>;
      try {
        if (deps.llm)
          result = await deps.llm.execute(
            { tenantId: job.tenantId, jobId: job.id, operation: 'cohort-correlate', signal },
            ({ generator }) => generator.generate(prompt, cohortDecisionSchema, { signal }),
          );
        else if (deps.generator)
          result = await deps.generator.generate(prompt, cohortDecisionSchema, { signal });
        else throw new RetryableError('cohort analysis model is unavailable');
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        await completeInvestigationRun(deps.appDb, job.tenantId, anchor.id, {
          id: admission.id,
          provider: deps.engine?.provider ?? null,
          engineModel: null,
          engineSessionId: null,
          turnBudget: 1,
          outcome: 'failed',
          result: { summary: 'Cohort relationship analysis failed.' },
          evidenceIds: [],
        });
        if (error instanceof ProviderUnavailableError)
          throw new RetryableError('cohort analysis provider unavailable');
        throw error;
      }
      const incidentByRef = new Map(
        analysis.incidents.map((incident) => [incident.ref, incident.id]),
      );
      const reassessmentJobIds = await withTenant(deps.appDb, job.tenantId, async (tx) => {
        const jobIds = new Set<string>();
        for (const decision of result.decisions) {
          const sourceIncidentId = incidentByRef.get(decision.sourceRef);
          const targetIncidentId = incidentByRef.get(decision.targetRef);
          if (!sourceIncidentId || !targetIncidentId || sourceIncidentId === targetIncidentId)
            continue;
          const relation = await recordAgentCohortRelationTx(tx, job.tenantId, {
            sourceIncidentId,
            targetIncidentId,
            type: decision.decision,
            rationale: publicModelText(decision.rationale),
            evidence: [
              `cohort:${cohortId}`,
              `window_started_at:${analysis.cohort.windowStartedAt.toISOString()}`,
              `window_ends_at:${analysis.cohort.windowEndsAt.toISOString()}`,
              `confidence:${Math.round(decision.confidence)}`,
            ],
          });
          if (relation?.type === 'possible_related') {
            const { jobId } = await deps.queue.insertRelationReassessmentTx(
              tx,
              job.tenantId,
              sourceIncidentId,
            );
            if (jobId) jobIds.add(jobId);
          }
        }
        const completed = await completeInvestigationRunTx(tx, anchor.id, {
          id: admission.id,
          provider: deps.engine?.provider ?? null,
          engineModel: null,
          engineSessionId: null,
          turnBudget: 1,
          outcome: 'conclusive',
          result: {
            summary: `Compared ${analysis.incidents.length} incidents in one bounded cohort.`,
            decisions: result.decisions.length,
          },
          evidenceIds: [],
        });
        if (!completed) throw new Error('cohort analysis run completion lost its admission fence');
        await settleAlertCohortTx(tx, cohortId);
        return [...jobIds];
      });
      for (const jobId of reassessmentJobIds) await deps.queue.publishJob(jobId);
    });
  }
}
