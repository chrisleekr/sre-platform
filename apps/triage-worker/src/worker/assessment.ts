import {
  advanceResumeWatermark,
  advanceResumeWatermarkTx,
  applyTriageResult,
  applyTriageResultTx,
  completeInvestigationRunTx,
  incidentSignals,
  incidents,
  recordAcceptedCauseTagSuggestionsTx,
  markSignalMaterialInvestigatedTx,
  withTenant,
  type CompleteInvestigationRunInput,
  type Tx,
} from '@sre/db';
import { and, eq, inArray } from 'drizzle-orm';

import type { TriageResult } from '../engine/types';
import { publicModelText } from '../public-output';
import {
  promoteCausalityAndRefreshRecovery,
  publishCausalResponseEffects,
  type CausalResponseEffects,
} from './causal-recovery';
import type { PersistOptions } from './contracts';
import { incidentFindingPayload } from './run-result';
import type { WorkerRuntime } from './runtime';
import { persistNonPromotingRun } from './terminal';

class StaleAssessmentMaterialError extends Error {
  constructor() {
    super('assessed signal material changed before promotion');
    this.name = 'StaleAssessmentMaterialError';
  }
}

class AssessmentPromotionRaceError extends Error {
  constructor() {
    super('incident state changed before assessment promotion');
    this.name = 'AssessmentPromotionRaceError';
  }
}

function scopeFindingEvidence(
  finding: ReturnType<typeof incidentFindingPayload>,
  allowedEvidenceIds: string[],
) {
  const allowed = new Set(allowedEvidenceIds);
  return {
    ...finding,
    evidenceIds: finding.evidenceIds.filter((evidenceId) => allowed.has(evidenceId)),
  };
}

async function markAssessedMaterials(
  tx: Tx,
  incidentId: string,
  materials: Array<{ signalId: string; signalVersion?: number; materialHash: string }>,
  signalScope: 'complete' | 'causal',
): Promise<void> {
  const incident = await tx
    .select({ id: incidents.id })
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1)
    .for('update');
  if (!incident[0]) throw new Error('assessment incident not found');
  const expected = [...materials].sort((left, right) =>
    left.signalId.localeCompare(right.signalId),
  );
  const current = (
    await tx
      .select({
        id: incidentSignals.id,
        version: incidentSignals.version,
        materialHash: incidentSignals.materialHash,
      })
      .from(incidentSignals)
      .where(
        signalScope === 'complete'
          ? eq(incidentSignals.incidentId, incidentId)
          : and(
              eq(incidentSignals.incidentId, incidentId),
              inArray(
                incidentSignals.id,
                expected.map((material) => material.signalId),
              ),
            ),
      )
      .for('update')
  )
    .flatMap((signal) =>
      signal.materialHash
        ? [
            {
              signalId: signal.id,
              signalVersion: signal.version,
              materialHash: signal.materialHash,
            },
          ]
        : [],
    )
    .sort((left, right) => left.signalId.localeCompare(right.signalId));
  if (
    current.length !== expected.length ||
    current.some(
      (signal, index) =>
        signal.signalId !== expected[index]?.signalId ||
        (expected[index]?.signalVersion !== undefined &&
          signal.signalVersion !== expected[index]?.signalVersion) ||
        signal.materialHash !== expected[index]?.materialHash,
    )
  )
    throw new StaleAssessmentMaterialError();
  for (const { signalId, signalVersion, materialHash } of materials)
    if (!(await markSignalMaterialInvestigatedTx(tx, signalId, materialHash, signalVersion)))
      throw new StaleAssessmentMaterialError();
}

async function promoteCurrent<T>(options: {
  promote: () => Promise<T>;
}): Promise<
  | { stale: true; reason: 'stale_evidence' | 'state_changed'; summary: string }
  | { stale: false; value: T }
> {
  try {
    return { stale: false, value: await options.promote() };
  } catch (error) {
    if (
      !(error instanceof StaleAssessmentMaterialError) &&
      !(error instanceof AssessmentPromotionRaceError)
    )
      throw error;
    return error instanceof StaleAssessmentMaterialError
      ? {
          stale: true,
          reason: 'stale_evidence',
          summary: 'The signal changed before this assessment could be promoted.',
        }
      : {
          stale: true,
          reason: 'state_changed',
          summary: 'The incident state changed before this assessment could be promoted.',
        };
  }
}

async function persistRejectedPromotion(
  runtime: WorkerRuntime,
  tenantId: string,
  incidentId: string,
  runId: string | undefined,
  result: TriageResult,
  rejected: { reason: 'stale_evidence' | 'state_changed'; summary: string },
  status: 'assessed' | 'degraded',
  runCompletion: (runId: string, result: TriageResult) => CompleteInvestigationRunInput,
  originMessageId?: string,
): Promise<void> {
  const failed = {
    ...result,
    outcome: 'failed' as const,
    summary: rejected.summary,
    nextStep: 'Wait for the current incident state, then run a fresh investigation if needed.',
  };
  await persistNonPromotingRun({
    runtime,
    tenantId,
    incidentId,
    result: failed,
    runId,
    completion: (id, current) => {
      const completed = runCompletion(id, current);
      return {
        ...completed,
        result: {
          ...completed.result,
          reason:
            rejected.reason === 'stale_evidence'
              ? 'stale_signal_material'
              : 'assessment_promotion_race',
        },
      };
    },
    investigationStatus: status,
    originMessageId,
    promotionReason: rejected.reason,
  });
}

/** Persists a conclusive assessment only while every assessed signal hash is still current. */
export async function persistAssessment(
  runtime: WorkerRuntime,
  tenantId: string,
  incidentId: string,
  result: TriageResult,
  options: Omit<PersistOptions, 'recovery'>,
  runCompletion: (runId: string, result: TriageResult) => CompleteInvestigationRunInput,
): Promise<boolean> {
  const { deps } = runtime;
  const {
    resumeMessageId,
    rcaFrozen,
    assessmentCause,
    resultOriginMessageId,
    assessedMaterials = [],
    causalCandidates = [],
    assessmentSignalScope = 'complete',
    runId,
    priorInvestigationStatus,
    humanMessageFence,
  } = options;
  const summary = publicModelText(result.summary);
  const finding = incidentFindingPayload(
    result,
    runId,
    rcaFrozen ? 'not_promoted' : 'trusted_assessment',
    rcaFrozen ? 'terminal_incident' : 'conclusive_assessment',
  );
  const assessment = {
    humanMessageFence,
    provider: result.provider,
    sessionId: result.sessionId,
    summary,
    confidence: result.confidence,
    rankedHypotheses: result.rankedHypotheses?.map((hypothesis) => ({
      hypothesis: publicModelText(hypothesis.hypothesis),
      confidence: hypothesis.confidence,
      evidence: publicModelText(hypothesis.evidence),
      state: hypothesis.state,
      supportingEvidenceIds: hypothesis.supportingEvidenceIds,
      contradictingEvidenceIds: hypothesis.contradictingEvidenceIds,
    })),
    currentState: result.currentState ? publicModelText(result.currentState) : null,
    impact: result.impact ? publicModelText(result.impact) : null,
    assessmentEvidenceIds: result.evidenceIds ?? [],
    unknowns: (result.unknowns ?? []).map((gap) => ({
      ...gap,
      question: publicModelText(gap.question),
    })),
    nextStep: result.nextStep ? publicModelText(result.nextStep) : null,
    engineModel: result.model,
    trustedAssessmentRunId: runId,
    resumeMessageId,
    assessmentCause,
  };
  if (rcaFrozen) {
    const message = runId
      ? await withTenant(deps.appDb, tenantId, async (tx) => {
          const completed = await completeInvestigationRunTx(
            tx,
            incidentId,
            runCompletion(runId, result),
          );
          if (!completed) return null;
          if (resumeMessageId) await advanceResumeWatermarkTx(tx, incidentId, resumeMessageId);
          return (
            await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
              author: 'agent',
              kind: 'finding',
              content: summary,
              summary,
              finding: scopeFindingEvidence(finding, completed.evidenceIds),
              originMessageId: resultOriginMessageId ?? `run-result:${runId}`,
            })
          ).message;
        })
      : await deps.hub.append(tenantId, incidentId, {
          author: 'agent',
          kind: 'finding',
          content: summary,
          summary,
          finding,
          originMessageId: resultOriginMessageId,
        });
    if (!message) return false;
    if (runId) await deps.hub.publishAppendedBestEffort(message);
    if (resumeMessageId && !runId)
      await advanceResumeWatermark(deps.appDb, tenantId, incidentId, resumeMessageId);
    return true;
  } else if (resultOriginMessageId !== undefined && resumeMessageId === undefined) {
    const promoted = await promoteCurrent({
      promote: () =>
        withTenant(deps.appDb, tenantId, async (tx) => {
          let persistedFinding = finding;
          let causalEffects: CausalResponseEffects = {
            recoveryJobId: null,
            lifecycleMessage: null,
            relationshipMessages: [],
          };
          if (runId) {
            const completed = await completeInvestigationRunTx(
              tx,
              incidentId,
              runCompletion(runId, result),
            );
            if (!completed) return null;
            persistedFinding = scopeFindingEvidence(finding, completed.evidenceIds);
            causalEffects = await promoteCausalityAndRefreshRecovery(
              runtime,
              tx,
              tenantId,
              incidentId,
              runId,
              result,
              completed.evidenceIds,
              causalCandidates,
            );
          }
          await markAssessedMaterials(tx, incidentId, assessedMaterials, assessmentSignalScope);
          if (!(await applyTriageResultTx(tx, incidentId, assessment)))
            throw new AssessmentPromotionRaceError();
          if (runId && result.causeTagSuggestions?.length)
            await recordAcceptedCauseTagSuggestionsTx(tx, tenantId, {
              incidentId,
              runId,
              suggestions: result.causeTagSuggestions,
            });
          return {
            message: (
              await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
                author: 'agent',
                kind: 'finding',
                content: summary,
                summary,
                finding: persistedFinding,
                originMessageId: resultOriginMessageId,
              })
            ).message,
            causalEffects,
          };
        }),
    });
    if (promoted.stale) {
      await persistRejectedPromotion(
        runtime,
        tenantId,
        incidentId,
        runId,
        result,
        promoted,
        priorInvestigationStatus === 'assessed' ? 'assessed' : 'degraded',
        runCompletion,
        resultOriginMessageId,
      );
      return false;
    }
    if (promoted.value) {
      await deps.hub.publishAppendedBestEffort(promoted.value.message);
      await publishCausalResponseEffects(runtime, promoted.value.causalEffects);
    }
    return promoted.value !== null;
  } else if (runId) {
    const promoted = await promoteCurrent({
      promote: () =>
        withTenant(deps.appDb, tenantId, async (tx) => {
          const completed = await completeInvestigationRunTx(
            tx,
            incidentId,
            runCompletion(runId, result),
          );
          if (!completed) return null;
          const causalEffects = await promoteCausalityAndRefreshRecovery(
            runtime,
            tx,
            tenantId,
            incidentId,
            runId,
            result,
            completed.evidenceIds,
            causalCandidates,
          );
          await markAssessedMaterials(tx, incidentId, assessedMaterials, assessmentSignalScope);
          if (!(await applyTriageResultTx(tx, incidentId, assessment)))
            throw new AssessmentPromotionRaceError();
          if (result.causeTagSuggestions?.length)
            await recordAcceptedCauseTagSuggestionsTx(tx, tenantId, {
              incidentId,
              runId,
              suggestions: result.causeTagSuggestions,
            });
          return {
            message: (
              await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
                author: 'agent',
                kind: 'finding',
                content: summary,
                summary,
                finding: scopeFindingEvidence(finding, completed.evidenceIds),
                originMessageId: resultOriginMessageId ?? `run-result:${runId}`,
              })
            ).message,
            causalEffects,
          };
        }),
    });
    if (promoted.stale || !promoted.value) {
      if (promoted.stale) {
        await persistRejectedPromotion(
          runtime,
          tenantId,
          incidentId,
          runId,
          result,
          promoted,
          priorInvestigationStatus === 'assessed' ? 'assessed' : 'degraded',
          runCompletion,
          resultOriginMessageId,
        );
      }
      return false;
    }
    await deps.hub.publishAppendedBestEffort(promoted.value.message);
    await publishCausalResponseEffects(runtime, promoted.value.causalEffects);
    return true;
  } else {
    await applyTriageResult(deps.appDb, tenantId, incidentId, assessment);
  }
  await deps.hub.append(tenantId, incidentId, {
    author: 'agent',
    kind: 'finding',
    content: summary,
    summary,
    finding,
    originMessageId: resultOriginMessageId,
  });
  return true;
}
