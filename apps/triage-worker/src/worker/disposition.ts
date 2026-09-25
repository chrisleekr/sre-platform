import {
  advanceResumeWatermark,
  completeInvestigationRun,
  recoveryVerificationStartedAt,
} from '@sre/db';
import { reconcileAssessmentInput } from './reconcile';
import type { InvestigationOperation } from '@sre/contracts';
import { NonRetryableError, RetryableError, type Job } from '@sre/queue';
import { persistConversationResult } from './conversation-result';
import {
  ProviderConfigurationError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  type TriageResult,
} from '../engine/types';
import { publicModelText } from '../public-output';
import type {
  IncidentRow,
  PersistOptions,
  RecoveryOutcome,
  RecoveryPersistContext,
} from './contracts';
import { recoveryFinding } from './presentation';
import {
  investigationRunCompletion,
  incidentFindingPayload,
  restrictEvidenceToReceipts,
} from './run-result';
import type { EngineToolRuntime, WorkerRuntime } from './runtime';
import { admitWorkerRun } from './admission';
import { persistAssessment as persistConclusiveAssessment } from './assessment';
import {
  persistEngineFailure as persistTerminalEngineFailure,
  failureCompletion,
  persistNonPromotingRun,
} from './terminal';

/** Code-owned run summary and terminal reason for an engine failure; never provider text. */
function engineFailureText(error: unknown) {
  if (error instanceof ProviderRateLimitError)
    return {
      summary: 'AI provider rate limit reached.',
      reason: 'AI provider rate limit reached',
    } as const;
  if (error instanceof ProviderConfigurationError)
    return {
      summary: 'AI provider rejected the configured request.',
      reason: 'AI provider rejected the configured request',
    } as const;
  if (error instanceof ProviderUnavailableError)
    return { summary: 'Engine execution failed.', reason: 'provider unavailable' } as const;
  return { summary: 'Engine execution failed.', reason: 'engine error' } as const;
}

export class WorkerDisposition {
  constructor(private readonly runtime: WorkerRuntime) {}
  async runEngine(
    tenantId: string,
    incident: IncidentRow,
    toolRuntime: EngineToolRuntime,
    run: () => Promise<TriageResult>,
    options: PersistOptions & { runId: string },
  ): Promise<boolean> {
    const runId = options.runId;
    const consumed = options.resumeMessageId ?? options.humanMessageFence ?? null;
    let humanMessageFence = consumed;
    let result: TriageResult;
    try {
      result = restrictEvidenceToReceipts(await run());
      const reconciled = await reconcileAssessmentInput(
        this.runtime,
        tenantId,
        incident.id,
        result,
        consumed,
        toolRuntime.signal,
      );
      result = reconciled.result;
      humanMessageFence = reconciled.fence;
    } catch (error) {
      const completed = await this.persistEngineFailure(
        tenantId,
        incident,
        runId,
        toolRuntime,
        error,
        options.resultOriginMessageId ??
          (options.resumeMessageId ? `resume-degraded:${options.resumeMessageId}` : undefined),
        incident.trustedAssessmentRunId || incident.rcaSummary ? 'assessed' : undefined,
      );
      if (!completed) return false;
      return this.throwEngineError(error);
    }
    return this.persist(tenantId, incident.id, result, {
      ...options,
      humanMessageFence,
      runId,
      priorInvestigationStatus:
        incident.trustedAssessmentRunId || incident.rcaSummary
          ? 'assessed'
          : incident.investigationStatus,
    });
  }

  async admitRun(job: Job, incident: IncidentRow, operation: InvestigationOperation) {
    return admitWorkerRun(this.runtime, job, incident, operation);
  }
  async failRun(
    tenantId: string,
    incidentId: string,
    runId: string,
    summary: string,
    toolRuntime?: EngineToolRuntime,
  ): Promise<boolean> {
    return Boolean(
      await completeInvestigationRun(this.runtime.deps.appDb, tenantId, incidentId, {
        ...failureCompletion(this.runtime, runId, toolRuntime, summary),
      }),
    );
  }

  async persistEngineFailure(
    tenantId: string,
    incident: IncidentRow,
    runId: string,
    toolRuntime: EngineToolRuntime,
    error: unknown,
    originBase?: string,
    preserveProgress?: IncidentRow['investigationStatus'],
    restoreRecovery = false,
  ): Promise<boolean> {
    const failure = engineFailureText(error);
    return persistTerminalEngineFailure({
      runtime: this.runtime,
      tenantId,
      incidentId: incident.id,
      service: incident.service,
      toolRuntime,
      completion: failureCompletion(this.runtime, runId, toolRuntime, failure.summary),
      reason: failure.reason,
      originBase,
      preserveProgress,
      restoreRecovery,
    });
  }

  throwEngineError(error: unknown): never {
    if (error instanceof ProviderRateLimitError)
      throw new NonRetryableError('AI provider rate limit reached');
    if (error instanceof ProviderUnavailableError)
      throw new RetryableError('triage provider unavailable; redelivering');
    // Redelivering the same rejected model or credential burns every attempt for the same 4xx.
    if (error instanceof ProviderConfigurationError) throw new NonRetryableError(error.message);
    throw error instanceof Error ? error : new Error(String(error));
  }

  async recoveryMaxChecks(snapshot?: number): Promise<number> {
    const configured = snapshot ?? (await this.runtime.deps.getRecoveryMaxChecks?.()) ?? 3;
    return Math.max(1, Math.min(10, Math.trunc(configured)));
  }

  async completeRun(
    tenantId: string,
    incidentId: string,
    runId: string | undefined,
    result: TriageResult,
  ): Promise<boolean> {
    if (!runId) return true;
    return Boolean(
      await completeInvestigationRun(
        this.runtime.deps.appDb,
        tenantId,
        incidentId,
        investigationRunCompletion(runId, result),
      ),
    );
  }

  async persistRecovery(
    tenantId: string,
    incidentId: string,
    result: TriageResult,
    context: RecoveryPersistContext,
    investigationRunId = context.verificationRunId,
  ) {
    result = restrictEvidenceToReceipts(result);
    const { deps } = this.runtime;
    const recovery = result.recovery;
    let outcome: RecoveryOutcome =
      result.outcome !== 'conclusive'
        ? 'needs_human'
        : (recovery?.outcome ?? (recovery?.recovered ? 'recovered' : 'needs_human'));
    const delay = recovery?.recheckAfterMinutes;
    const scheduleReason = recovery?.scheduleReason
      ? publicModelText(recovery.scheduleReason)
      : null;
    const scheduleDelayMinutes =
      outcome === 'recheck' &&
      context.attempt < context.maxChecks &&
      Number.isInteger(delay) &&
      delay !== null &&
      delay !== undefined &&
      delay >= 1 &&
      delay <= 60 &&
      scheduleReason
        ? delay
        : null;
    if (outcome === 'recheck' && scheduleDelayMinutes === null) outcome = 'needs_human';
    let nextCheckAt: Date | null = null;
    if (scheduleDelayMinutes !== null) {
      const scheduleBase =
        (await recoveryVerificationStartedAt(
          deps.appDb,
          tenantId,
          context.responseRootIncidentId,
        )) ?? new Date();
      nextCheckAt = new Date(scheduleBase.getTime() + scheduleDelayMinutes * 60_000);
    }
    const requiredAction =
      recovery?.questions?.find((question) => question.resolutionRelevance === 'blocking')
        ?.nextAction ?? recovery?.nextStep;
    const nextStep = requiredAction
      ? publicModelText(requiredAction)
      : outcome === 'needs_human' && context.attempt >= context.maxChecks
        ? 'Automated recovery monitoring is exhausted; a responder must review the remaining condition.'
        : null;
    const finalized = await deps.hub.finalizeRecovery(tenantId, context.responseRootIncidentId, {
      conversationIncidentId: incidentId,
      recoveryRunId: context.verificationRunId,
      ...(investigationRunId
        ? { runCompletion: investigationRunCompletion(investigationRunId, { ...result, nextStep }) }
        : {}),
      recoveryJobId: context.recoveryJobId,
      expectedLifecycleVersion: context.expectedLifecycleVersion,
      expectedSignalFence: context.expectedSignalFence,
      restoreInvestigationStatus: context.restoreInvestigationStatus,
      verificationStartedAt: context.verificationStartedAt,
      eventKey: context.eventKey,
      content: publicModelText(
        recoveryFinding(result, outcome, context.attempt, context.maxChecks, nextCheckAt),
      ),
      summary: publicModelText(result.summary),
      outcome,
      attempt: context.attempt,
      maxChecks: context.maxChecks,
      recoveryEvidenceIds: recovery?.evidenceIds ?? [],
      recoveryUnknowns: (recovery?.unknowns ?? []).map(publicModelText),
      ...(recovery?.questions !== undefined
        ? {
            recoveryQuestions: recovery.questions.map((question) => ({
              ...question,
              question: publicModelText(question.question),
              nextAction: publicModelText(question.nextAction),
            })),
          }
        : {}),
      recoveryNextStep: nextStep,
      recoveryChecks: (recovery?.evidence ?? []).map((check) => ({
        name: publicModelText(check.name),
        before: check.before ? publicModelText(check.before) : null,
        now: publicModelText(check.now),
      })),
      finding: incidentFindingPayload(
        {
          ...result,
          evidenceIds: recovery?.evidenceIds ?? [],
          nextStep,
        },
        investigationRunId,
        result.outcome === 'inconclusive' ? 'not_promoted' : 'conversation_only',
        result.outcome === 'inconclusive' ? 'investigation_inconclusive' : 'terminal_incident',
      ),
      assessedMaterials: context.signals.flatMap((signal) =>
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
      ...(context.resumeMessageId ? { resumeMessageId: context.resumeMessageId } : {}),
      ...(nextCheckAt && scheduleReason
        ? {
            scheduleRecheck: {
              nextCheckAt,
              reason: scheduleReason,
              enqueueTx: async (tx) => {
                await deps.queue.insertRecoveryTx(
                  tx,
                  tenantId,
                  context.responseRootIncidentId,
                  context.expectedLifecycleVersion,
                  context.expectedSignalFence,
                  {
                    attempt: context.attempt + 1,
                    maxChecks: context.maxChecks,
                    availableAt: nextCheckAt,
                    scheduleReason,
                  },
                );
              },
            },
          }
        : {}),
      ...(outcome === 'recovered'
        ? {
            autoResolve: {
              reason: 'Provider signals cleared and recovery verification passed.',
              transitionKey: context.transitionKey,
            },
          }
        : {}),
    });
    if (finalized.applied) {
      console.log(
        JSON.stringify({
          level: 'info',
          app: 'triage-worker',
          event: 'recovery.decision_applied',
          tenantId,
          incidentId,
          outcome,
          attempt: context.attempt,
          maxChecks: context.maxChecks,
          nextCheckAt: nextCheckAt?.toISOString() ?? null,
          autoResolved: finalized.autoResolved,
        }),
      );
    }
    return finalized;
  }

  async persist(
    tenantId: string,
    incidentId: string,
    result: TriageResult,
    {
      resumeMessageId,
      rcaFrozen,
      assessmentCause,
      resultOriginMessageId,
      assessmentSignalScope,
      assessedMaterials = [],
      causalCandidates = [],
      recovery,
      runId,
      priorInvestigationStatus,
      humanMessageFence,
    }: PersistOptions = {},
  ): Promise<boolean> {
    result = restrictEvidenceToReceipts(result);
    const { deps } = this.runtime;
    if (result.outcome === 'inconclusive' && result.disposition === 'reply') {
      return persistConversationResult(this.runtime, tenantId, incidentId, result, {
        runId,
        resumeMessageId,
        priorInvestigationStatus,
        humanMessageFence,
      });
    }
    if (
      result.disposition === 'recovery' &&
      recovery &&
      result.outcome === 'inconclusive' &&
      result.recovery?.outcome === 'needs_human' &&
      result.recovery.recovered === false
    ) {
      const finalized = await this.persistRecovery(tenantId, incidentId, result, recovery, runId);
      return finalized.runCompleted;
    }
    if (result.outcome !== 'conclusive') {
      return persistNonPromotingRun({
        runtime: this.runtime,
        tenantId,
        incidentId,
        result,
        runId,
        completion: investigationRunCompletion,
        investigationStatus: priorInvestigationStatus === 'assessed' ? 'assessed' : 'degraded',
        resumeMessageId,
        originMessageId: resultOriginMessageId,
      });
    }
    const disposition = result.disposition ?? 'rca';
    if (disposition === 'recovery') {
      if (!recovery) {
        if (!(await this.completeRun(tenantId, incidentId, runId, result))) return false;
        if (resumeMessageId)
          await advanceResumeWatermark(deps.appDb, tenantId, incidentId, resumeMessageId);
        return true;
      }
      await this.persistRecovery(tenantId, incidentId, result, recovery, runId);
      return true;
    }
    if (disposition === 'silent') {
      if (!(await this.completeRun(tenantId, incidentId, runId, result))) return false;
      await deps.hub.append(tenantId, incidentId, {
        author: 'agent',
        kind: 'silent',
        content: publicModelText(result.summary),
      });
      if (resumeMessageId)
        await advanceResumeWatermark(deps.appDb, tenantId, incidentId, resumeMessageId);
      return true;
    }
    if (disposition === 'reply' || disposition === 'approval')
      return persistConversationResult(this.runtime, tenantId, incidentId, result, {
        runId,
        resumeMessageId,
        priorInvestigationStatus,
        humanMessageFence,
      });
    return this.persistAssessment(tenantId, incidentId, result, {
      humanMessageFence,
      resumeMessageId,
      rcaFrozen,
      assessmentCause,
      resultOriginMessageId,
      assessmentSignalScope,
      assessedMaterials,
      causalCandidates,
      runId,
      priorInvestigationStatus,
    });
  }

  private async persistAssessment(
    tenantId: string,
    incidentId: string,
    result: TriageResult,
    options: Omit<PersistOptions, 'recovery'>,
  ): Promise<boolean> {
    return persistConclusiveAssessment(
      this.runtime,
      tenantId,
      incidentId,
      result,
      options,
      investigationRunCompletion,
    );
  }
}
