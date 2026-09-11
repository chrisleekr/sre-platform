import {
  advanceResumeWatermarkTx,
  completeInvestigationRunTx,
  degradeIncidentTx,
  setInvestigationStatus,
  setInvestigationStatusTx,
  restoreRecoveryVerificationTx,
  withTenant,
  type CompleteInvestigationRunInput,
  type InvestigationStatus,
} from '@sre/db';
import type { IncidentFindingPromotionReason } from '@sre/contracts';
import { buildEvidenceBrief } from '../evidence-brief';
import type { TriageResult } from '../engine/types';
import { publicModelText } from '../public-output';
import type { EngineToolRuntime, WorkerRuntime } from './runtime';
import { incidentFindingPayload } from './run-result';

/**
 * Builds a failed run without losing evidence collected before the error.
 * @param runtime - Worker dependencies and fallback engine identity.
 * @param runId - Admitted investigation run.
 * @param toolRuntime - Execution metadata and retained evidence receipts.
 * @param summary - Safe failure description for responders.
 */
export function failureCompletion(
  runtime: WorkerRuntime,
  runId: string,
  toolRuntime: EngineToolRuntime | undefined,
  summary: string,
): CompleteInvestigationRunInput {
  const metadata = toolRuntime?.executionMetadata;
  return {
    id: runId,
    provider: metadata?.provider ?? runtime.deps.engine?.provider ?? null,
    engineModel: metadata?.model ?? null,
    engineSessionId: metadata?.sessionId ?? null,
    turnBudget: metadata?.turnBudget ?? 0,
    outcome: 'failed',
    result: { summary },
    evidenceIds: [
      ...new Set((toolRuntime?.evidenceReceipts ?? []).map((receipt) => receipt.evidenceId)),
    ],
  };
}

function nonPromotionReason(result: TriageResult): IncidentFindingPromotionReason {
  switch (result.outcome) {
    case 'inconclusive':
      return 'investigation_inconclusive';
    case 'blocked_missing_capability':
      return 'missing_capability';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'failed':
      return 'investigation_failed';
    default:
      throw new Error('conclusive results require a promotion decision');
  }
}

function scopedFinding(
  result: TriageResult,
  runId: string,
  reason: IncidentFindingPromotionReason,
  allowedEvidenceIds: string[],
) {
  const allowed = new Set(allowedEvidenceIds);
  const finding = incidentFindingPayload(result, runId, 'not_promoted', reason);
  return {
    ...finding,
    evidenceIds: finding.evidenceIds.filter((evidenceId) => allowed.has(evidenceId)),
  };
}

interface NonPromotingRunInput {
  runtime: WorkerRuntime;
  tenantId: string;
  incidentId: string;
  result: TriageResult;
  runId?: string;
  completion: (runId: string, result: TriageResult) => CompleteInvestigationRunInput;
  investigationStatus: InvestigationStatus;
  resumeMessageId?: string;
  originMessageId?: string;
  promotionReason?: IncidentFindingPromotionReason;
  recoveryRestoreStatus?: InvestigationStatus;
}

/** Completes a non-promoting run with its run-linked finding and operator state in one transaction. */
export async function persistNonPromotingRun(input: NonPromotingRunInput): Promise<boolean> {
  const { runtime, tenantId, incidentId, result, runId } = input;
  const summary = publicModelText(result.summary);
  const reason = input.promotionReason ?? nonPromotionReason(result);
  if (!runId) {
    await setInvestigationStatus(
      runtime.deps.appDb,
      tenantId,
      incidentId,
      input.investigationStatus,
    );
    await runtime.deps.hub.append(tenantId, incidentId, {
      author: 'agent',
      kind: 'finding',
      content: summary,
      summary,
      finding: incidentFindingPayload(result, undefined, 'not_promoted', reason),
      originMessageId: input.originMessageId,
    });
    return true;
  }
  const message = await withTenant(runtime.deps.appDb, tenantId, async (tx) => {
    const completed = await completeInvestigationRunTx(
      tx,
      incidentId,
      input.completion(runId, result),
    );
    if (!completed) return null;
    if (input.recoveryRestoreStatus)
      await restoreRecoveryVerificationTx(tx, incidentId, input.recoveryRestoreStatus, runId);
    else await setInvestigationStatusTx(tx, incidentId, input.investigationStatus);
    if (input.resumeMessageId)
      await advanceResumeWatermarkTx(tx, incidentId, input.resumeMessageId);
    return (
      await runtime.deps.hub.appendTxOnce(tx, tenantId, incidentId, {
        author: 'agent',
        kind: 'finding',
        content: summary,
        summary,
        finding: scopedFinding(result, runId, reason, completed.evidenceIds),
        originMessageId: input.originMessageId ?? `run-result:${runId}`,
      })
    ).message;
  });
  if (!message) return false;
  await runtime.deps.hub.publishAppendedBestEffort(message);
  return true;
}

interface EngineFailureInput {
  runtime: WorkerRuntime;
  tenantId: string;
  incidentId: string;
  service: string;
  toolRuntime: EngineToolRuntime;
  completion: CompleteInvestigationRunInput;
  reason: 'provider unavailable' | 'engine error' | 'AI provider rate limit reached';
  originBase?: string;
  preserveProgress?: InvestigationStatus;
  restoreRecovery?: boolean;
}

/** Persists an engine failure, its evidence brief, and surface outbox atomically with run completion. */
export async function persistEngineFailure(input: EngineFailureInput): Promise<boolean> {
  const brief = await buildEvidenceBrief(input.toolRuntime.ctx, input.service);
  const factualEvidenceIds = input.toolRuntime.evidenceReceipts
    .filter((receipt) => receipt.outcome === 'complete' || receipt.outcome === 'partial')
    .map((receipt) => receipt.evidenceId);
  const originBase = input.originBase ?? `run-failed:${input.completion.id}`;
  const messages = await withTenant(input.runtime.deps.appDb, input.tenantId, async (tx) => {
    const completed = await completeInvestigationRunTx(tx, input.incidentId, input.completion);
    if (!completed) return null;
    if (input.restoreRecovery && input.preserveProgress)
      await restoreRecoveryVerificationTx(
        tx,
        input.incidentId,
        input.preserveProgress,
        input.completion.id,
      );
    else if (input.preserveProgress)
      await setInvestigationStatusTx(tx, input.incidentId, input.preserveProgress);
    else await degradeIncidentTx(tx, input.incidentId);
    const allowed = new Set(completed.evidenceIds);
    const finding = await input.runtime.deps.hub.appendTxOnce(
      tx,
      input.tenantId,
      input.incidentId,
      {
        author: 'system',
        kind: 'finding',
        content: `AI triage could not complete (${input.reason}). Assembled evidence brief:\n\n${brief}`,
        summary:
          input.reason === 'AI provider rate limit reached'
            ? 'Investigation stopped: AI provider rate limit reached. No automatic retry will be made. Check the provider account limit, then ask the SRE to retry when ready.'
            : `Investigation blocked: ${input.reason}. A responder must investigate manually or retry after the blocker clears.`,
        finding: {
          runId: input.completion.id,
          outcome: 'failed',
          promotion: 'not_promoted',
          promotionReason: 'investigation_failed',
          evidenceIds: factualEvidenceIds.filter((id) => allowed.has(id)),
          currentState: null,
          impact: null,
          nextStep: 'Investigate manually or retry after the blocker clears.',
        },
        originMessageId: `${originBase}:finding`,
      },
    );
    const escalation = await input.runtime.deps.hub.appendTxOnce(
      tx,
      input.tenantId,
      input.incidentId,
      {
        author: 'system',
        kind: 'text',
        content: 'Escalated: AI triage degraded, a human should investigate.',
        originMessageId: `${originBase}:escalation`,
      },
    );
    return [finding.message, escalation.message];
  });
  if (!messages) return false;
  for (const message of messages) await input.runtime.deps.hub.publishAppendedBestEffort(message);
  return true;
}
