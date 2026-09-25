import type { IncidentFindingPayload } from '@sre/contracts';
import type { CompleteInvestigationRunInput } from '@sre/db';
import type { TriageResult } from '../engine/types';
import { publicModelText } from '../public-output';

export function restrictEvidenceToReceipts(result: TriageResult): TriageResult {
  const receipts = [
    ...new Map(
      (result.evidenceReceipts ?? []).map((receipt) => [receipt.evidenceId, receipt]),
    ).values(),
  ];
  const attempted = new Set(receipts.map((receipt) => receipt.evidenceId));
  const factual = new Set(
    receipts
      .filter((receipt) => receipt.outcome === 'complete' || receipt.outcome === 'partial')
      .map((receipt) => receipt.evidenceId),
  );
  let rejectedFactualCitation = false;
  const keepFactual = (ids: string[] | undefined): string[] => {
    const proposed = [...new Set(ids ?? [])];
    const accepted = proposed.filter((id) => factual.has(id));
    if (accepted.length !== proposed.length) rejectedFactualCitation = true;
    return accepted;
  };
  const keepAttempted = (ids: string[] | undefined): string[] =>
    [...new Set(ids ?? [])].filter((id) => attempted.has(id));
  const evidenceIds =
    result.evidenceIds !== undefined ? keepFactual(result.evidenceIds) : undefined;
  const rankedHypotheses = result.rankedHypotheses?.map((hypothesis) => ({
    ...hypothesis,
    ...(hypothesis.supportingEvidenceIds !== undefined
      ? { supportingEvidenceIds: keepFactual(hypothesis.supportingEvidenceIds) }
      : {}),
    ...(hypothesis.contradictingEvidenceIds !== undefined
      ? { contradictingEvidenceIds: keepFactual(hypothesis.contradictingEvidenceIds) }
      : {}),
  }));
  const recoveryEvidenceIds =
    result.recovery?.evidenceIds !== undefined
      ? keepFactual(result.recovery.evidenceIds)
      : undefined;
  const causalFindings = result.causalFindings?.flatMap((finding) => {
    const causalEvidenceIds = keepFactual(finding.evidenceIds);
    return causalEvidenceIds.length === 0 ? [] : [{ ...finding, evidenceIds: causalEvidenceIds }];
  });
  return {
    ...result,
    outcome:
      result.outcome === 'conclusive' && rejectedFactualCitation ? 'inconclusive' : result.outcome,
    evidenceReceipts: receipts,
    ...(evidenceIds !== undefined ? { evidenceIds } : {}),
    ...(rankedHypotheses !== undefined ? { rankedHypotheses } : {}),
    ...(causalFindings !== undefined ? { causalFindings } : {}),
    ...(result.unknowns !== undefined
      ? {
          unknowns: result.unknowns.map((gap) => ({
            ...gap,
            attemptedEvidenceIds: keepAttempted(gap.attemptedEvidenceIds),
          })),
        }
      : {}),
    ...(result.recovery !== undefined
      ? {
          recovery: {
            ...result.recovery,
            ...(result.recovery.questions !== undefined
              ? {
                  questions: result.recovery.questions.map((question) => ({
                    ...question,
                    attemptedEvidenceIds: keepAttempted(question.attemptedEvidenceIds),
                  })),
                }
              : {}),
            ...(recoveryEvidenceIds !== undefined ? { evidenceIds: recoveryEvidenceIds } : {}),
          },
        }
      : {}),
  };
}

export function investigationRunEvidenceIds(result: TriageResult): string[] {
  return [...new Set((result.evidenceReceipts ?? []).map((receipt) => receipt.evidenceId))];
}

/** Converts a receipt-scoped engine result into the immutable investigation-run completion. */
export function investigationRunCompletion(
  runId: string,
  result: TriageResult,
): CompleteInvestigationRunInput {
  result = restrictEvidenceToReceipts(result);
  return {
    id: runId,
    provider: result.provider || null,
    engineModel: result.model ?? null,
    engineSessionId: result.sessionId || null,
    turnBudget: Math.max(0, Math.trunc(result.turnBudget)),
    outcome: result.outcome,
    result: investigationRunResult(result),
    evidenceIds: investigationRunEvidenceIds(result),
  };
}

/** Builds the structured provenance persisted beside one human-visible finding. */
export function incidentFindingPayload(
  result: TriageResult,
  runId: string | undefined,
  promotion: IncidentFindingPayload['promotion'],
  promotionReason: IncidentFindingPayload['promotionReason'],
): IncidentFindingPayload {
  return {
    runId: runId ?? null,
    outcome: result.outcome,
    promotion,
    promotionReason,
    evidenceIds: [...new Set(result.evidenceIds ?? [])],
    currentState: result.currentState ? publicModelText(result.currentState) : null,
    impact: result.impact ? publicModelText(result.impact) : null,
    nextStep: result.nextStep ? publicModelText(result.nextStep) : null,
    ...(result.reviewGaps?.length ? { gaps: result.reviewGaps.map(publicModelText) } : {}),
  };
}

export function investigationRunResult(result: TriageResult): Record<string, unknown> {
  return {
    disposition: result.disposition ?? null,
    summary: publicModelText(result.summary),
    confidence: result.confidence,
    ...(result.evidenceIds !== undefined ? { evidenceIds: result.evidenceIds } : {}),
    ...(result.detail !== undefined ? { detail: publicModelText(result.detail) } : {}),
    ...(result.rankedHypotheses !== undefined
      ? {
          rankedHypotheses: result.rankedHypotheses.map((hypothesis) => ({
            hypothesis: publicModelText(hypothesis.hypothesis),
            confidence: hypothesis.confidence,
            evidence: publicModelText(hypothesis.evidence),
            ...(hypothesis.state !== undefined ? { state: hypothesis.state } : {}),
            supportingEvidenceIds: hypothesis.supportingEvidenceIds ?? [],
            contradictingEvidenceIds: hypothesis.contradictingEvidenceIds ?? [],
          })),
        }
      : {}),
    ...(result.currentState !== undefined
      ? { currentState: result.currentState ? publicModelText(result.currentState) : null }
      : {}),
    ...(result.impact !== undefined
      ? { impact: result.impact ? publicModelText(result.impact) : null }
      : {}),
    ...(result.unknowns !== undefined
      ? {
          unknowns: result.unknowns.map((gap) => ({
            question: publicModelText(gap.question),
            category: gap.category,
            evidenceKind: gap.evidenceKind,
            attemptedEvidenceIds: gap.attemptedEvidenceIds,
          })),
        }
      : {}),
    ...(result.nextStep !== undefined
      ? { nextStep: result.nextStep ? publicModelText(result.nextStep) : null }
      : {}),
    ...(result.reviewGaps?.length ? { gaps: result.reviewGaps.map(publicModelText) } : {}),
    ...(result.causalFindings !== undefined
      ? {
          causalFindings: result.causalFindings.map((finding) => ({
            ...finding,
            rationale: publicModelText(finding.rationale),
            evidenceIds: [...new Set(finding.evidenceIds)],
          })),
        }
      : {}),
    ...(result.approval !== undefined
      ? {
          approval: {
            prompt: publicModelText(result.approval.prompt),
            options: result.approval.options.map((option) => ({
              id: option.id,
              label: publicModelText(option.label),
            })),
          },
        }
      : {}),
    ...(result.recovery !== undefined
      ? {
          recovery: {
            outcome:
              result.recovery.outcome ?? (result.recovery.recovered ? 'recovered' : 'needs_human'),
            recovered: result.recovery.recovered,
            evidenceIds: result.recovery.evidenceIds ?? [],
            evidence: result.recovery.evidence.map((check) => ({
              name: publicModelText(check.name),
              before: check.before ? publicModelText(check.before) : null,
              now: publicModelText(check.now),
            })),
            unknowns: (
              result.recovery.questions?.map((question) => question.question) ??
              result.recovery.unknowns
            ).map(publicModelText),
            ...(result.recovery.questions !== undefined
              ? {
                  questions: result.recovery.questions.map((question) => ({
                    ...question,
                    question: publicModelText(question.question),
                    nextAction: publicModelText(question.nextAction),
                  })),
                }
              : {}),
            nextStep: result.recovery.nextStep ? publicModelText(result.recovery.nextStep) : null,
            recheckAfterMinutes: result.recovery.recheckAfterMinutes ?? null,
            scheduleReason: result.recovery.scheduleReason
              ? publicModelText(result.recovery.scheduleReason)
              : null,
          },
        }
      : {}),
  };
}
