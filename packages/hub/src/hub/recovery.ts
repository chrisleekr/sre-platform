import {
  ACTIVE_STATUSES,
  advanceResumeWatermarkTx,
  approvals,
  completeInvestigationRunTx,
  filterRecoveryEvidenceIdsTx,
  filterRecoveryAttemptIdsTx,
  incidentMessages,
  incidents,
  jobs,
  lockResponseGroupWorkTx,
  markSignalMaterialInvestigatedTx,
  listResponseGroupSignalsTx,
  restoreRecoveryVerificationTx,
  serializeSignalFence,
  withTenant,
  type Db,
  type CompleteInvestigationRunInput,
  type IncidentFindingPayload,
  type InvestigationStatus,
  type RecoveryMessagePayload,
  type Tx,
} from '@sre/db';
import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { type HubMessage } from './contracts';
import type { HubStore } from './store';
import {
  appendResolvedResponseGroupTx,
  resolveProviderClearTx,
  completeVerifiedRecoveryAfterApprovalTx,
  type EnqueueRecoveryTx,
} from './response-group';

async function hasOnlyActiveLifecycleTransitions(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  fromVersion: number,
  toVersion: number,
): Promise<boolean> {
  if (toVersion <= fromVersion) return false;
  const transitions = await tx
    .select({
      version: incidentMessages.lifecycleVersion,
      to: incidentMessages.lifecycleTo,
    })
    .from(incidentMessages)
    .where(
      and(
        eq(incidentMessages.tenantId, tenantId),
        eq(incidentMessages.incidentId, incidentId),
        eq(incidentMessages.kind, 'lifecycle'),
        gt(incidentMessages.lifecycleVersion, fromVersion),
        lte(incidentMessages.lifecycleVersion, toVersion),
      ),
    )
    .orderBy(asc(incidentMessages.lifecycleVersion));
  return (
    transitions.length === toVersion - fromVersion &&
    transitions.every(
      (transition, index) =>
        transition.version === fromVersion + index + 1 &&
        ACTIVE_STATUSES.includes(transition.to as (typeof ACTIVE_STATUSES)[number]),
    )
  );
}

export class HubRecovery {
  constructor(
    private readonly db: Db,
    private readonly store: HubStore,
    private readonly publishAppended: (message: HubMessage) => Promise<void>,
  ) {}

  /** Throws ProviderClearLockContendedError when a connector write holds the generation rows. */
  async resolveProviderClear(
    tenantId: string,
    incidentId: string,
    expected: { lifecycleVersion: number; signalFence: string },
    transitionKey: string,
  ): Promise<boolean> {
    const result = await withTenant(this.db, tenantId, (tx) =>
      resolveProviderClearTx(this.store, tx, tenantId, incidentId, transitionKey, expected),
    );
    for (const message of result.messages) await this.publishAppended(message);
    return result.handled;
  }

  /** Completes an eligible response group after its final pending approval is decided. */
  async completeVerifiedRecoveryAfterApprovalTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    approvalId: string,
    enqueueRecoveryTx?: EnqueueRecoveryTx,
  ): Promise<HubMessage[]> {
    return completeVerifiedRecoveryAfterApprovalTx(
      this.store,
      tx,
      tenantId,
      incidentId,
      approvalId,
      enqueueRecoveryTx,
    );
  }

  /** Commit a recovery finding only while the lifecycle and complete signal snapshot still match. */
  async finalizeRecovery(
    tenantId: string,
    incidentId: string,
    input: {
      /** Incident conversation that initiated this check; lifecycle remains owned by incidentId. */
      conversationIncidentId?: string;
      expectedLifecycleVersion: number;
      expectedSignalFence: string;
      recoveryRunId?: string;
      recoveryJobId?: string;
      runCompletion?: CompleteInvestigationRunInput;
      restoreInvestigationStatus: InvestigationStatus;
      verificationStartedAt: Date;
      eventKey: string;
      content: string;
      summary: string;
      outcome: 'recovered' | 'recheck' | 'needs_human';
      attempt: number;
      maxChecks: number;
      recoveryEvidenceIds: string[];
      recoveryUnknowns: string[];
      recoveryQuestions?: RecoveryMessagePayload['questions'];
      recoveryNextStep: string | null;
      recoveryChecks: RecoveryMessagePayload['checks'];
      finding?: IncidentFindingPayload;
      assessedMaterials: Array<{
        signalId: string;
        signalVersion?: number;
        materialHash: string;
      }>;
      resumeMessageId?: string;
      scheduleRecheck?: {
        nextCheckAt: Date;
        reason: string;
        enqueueTx: (tx: Tx) => Promise<void>;
      };
      autoResolve?: { reason: string; transitionKey: string };
    },
  ): Promise<{
    applied: boolean;
    retryable: boolean;
    autoResolved: boolean;
    runCompleted: boolean;
    message: HubMessage | null;
    replyMessage: HubMessage | null;
    lifecycleMessage: HubMessage | null;
    additionalLifecycleMessages: HubMessage[];
  }> {
    const conversationIncidentId = input.conversationIncidentId ?? incidentId;
    const result = await withTenant(this.db, tenantId, async (tx) => {
      const { incidentIds: responseGroupIds } = await lockResponseGroupWorkTx(
        tx,
        tenantId,
        incidentId,
      );
      const rows = await tx
        .select({
          id: incidents.id,
          status: incidents.status,
          lifecycleVersion: incidents.lifecycleVersion,
          recoveryRunId: incidents.recoveryRunId,
        })
        .from(incidents)
        .where(inArray(incidents.id, responseGroupIds))
        .orderBy(incidents.id)
        .for('update');
      const incident = rows.find((row) => row.id === incidentId);
      const signals = await listResponseGroupSignalsTx(tx, tenantId, incidentId);
      const signalFenceMatches = serializeSignalFence(signals) === input.expectedSignalFence;
      const lifecycleVersionMatches = incident?.lifecycleVersion === input.expectedLifecycleVersion;
      const lifecycleIsActive =
        !!incident && ACTIVE_STATUSES.includes(incident.status as (typeof ACTIVE_STATUSES)[number]);
      const runOwnsRecovery =
        !!incident &&
        (input.recoveryRunId === undefined || incident.recoveryRunId === input.recoveryRunId);
      if (
        !incident ||
        !runOwnsRecovery ||
        !lifecycleIsActive ||
        !lifecycleVersionMatches ||
        !signalFenceMatches
      ) {
        if (incident)
          await restoreRecoveryVerificationTx(
            tx,
            incidentId,
            input.restoreInvestigationStatus,
            input.recoveryRunId,
          );
        const retryable =
          !!input.recoveryJobId &&
          runOwnsRecovery &&
          lifecycleIsActive &&
          !lifecycleVersionMatches &&
          signalFenceMatches &&
          (await hasOnlyActiveLifecycleTransitions(
            tx,
            tenantId,
            incidentId,
            input.expectedLifecycleVersion,
            incident.lifecycleVersion,
          ));
        if (retryable) {
          await tx
            .update(jobs)
            .set({
              payload: sql`${jobs.payload} || ${JSON.stringify({ lifecycleVersion: incident!.lifecycleVersion })}::jsonb`,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(jobs.id, input.recoveryJobId!),
                eq(jobs.tenantId, tenantId),
                eq(jobs.type, 'recovery.verify'),
              ),
            );
        }
        let message: HubMessage | null = null;
        let replyMessage: HubMessage | null = null;
        let runCompleted = input.runCompletion === undefined;
        if (!retryable && input.runCompletion) {
          const completed = await completeInvestigationRunTx(tx, conversationIncidentId, {
            ...input.runCompletion,
            outcome: 'failed',
            result: {
              summary:
                'Recovery result was not applied because provider or lifecycle state changed.',
              reason: 'state_changed',
            },
          });
          runCompleted = completed !== null;
          if (completed) {
            message = (
              await this.store.appendTxOnce(tx, tenantId, conversationIncidentId, {
                author: 'agent',
                kind: 'finding',
                content:
                  'Recovery result was not applied because provider or lifecycle state changed during verification.',
                summary: 'Recovery result rejected because current state changed.',
                finding: {
                  runId: input.runCompletion.id,
                  outcome: 'failed',
                  promotion: 'not_promoted',
                  promotionReason: 'state_changed',
                  evidenceIds: completed.evidenceIds,
                  currentState: null,
                  impact: null,
                  nextStep: null,
                },
                originMessageId: `recovery-state-changed:${input.runCompletion.id}`,
              })
            ).message;
          }
        }
        if (!retryable && incident && input.resumeMessageId && runCompleted) {
          await advanceResumeWatermarkTx(tx, conversationIncidentId, input.resumeMessageId);
          replyMessage = (
            await this.store.appendTxOnce(tx, tenantId, conversationIncidentId, {
              author: 'agent',
              kind: 'reply',
              content:
                'The provider state changed while I was checking recovery, so I did not apply the stale result.',
              originMessageId: `recovery-state-changed-reply:${input.resumeMessageId}`,
            })
          ).message;
        }
        return {
          applied: false,
          // Mitigation does not invalidate recovery evidence. Redeliver so the next
          // attempt captures the newer active lifecycle version. Terminal lifecycle or changed signals
          // make this job obsolete and must not retry it.
          retryable,
          autoResolved: false,
          runCompleted,
          message,
          replyMessage,
          lifecycleMessage: null,
          additionalLifecycleMessages: [],
        };
      }

      let completedEvidenceIds: string[] | null = null;
      if (input.runCompletion) {
        const completed = await completeInvestigationRunTx(
          tx,
          conversationIncidentId,
          input.runCompletion,
        );
        if (!completed) {
          await restoreRecoveryVerificationTx(
            tx,
            incidentId,
            input.restoreInvestigationStatus,
            input.recoveryRunId,
          );
          return {
            applied: false,
            retryable: false,
            autoResolved: false,
            runCompleted: false,
            message: null,
            replyMessage: null,
            lifecycleMessage: null,
            additionalLifecycleMessages: [],
          };
        }
        completedEvidenceIds = completed.evidenceIds;
      }

      let recoveryEvidenceIds = await filterRecoveryEvidenceIdsTx(
        tx,
        conversationIncidentId,
        input.recoveryEvidenceIds,
        input.verificationStartedAt,
      );
      if (completedEvidenceIds) {
        const completed = new Set(completedEvidenceIds);
        recoveryEvidenceIds = recoveryEvidenceIds.filter((id) => completed.has(id));
      }
      const proposedQuestions = input.recoveryQuestions;
      const attemptedIds = await filterRecoveryAttemptIdsTx(
        tx,
        conversationIncidentId,
        proposedQuestions?.flatMap((question) => question.attemptedEvidenceIds) ?? [],
        input.verificationStartedAt,
      );
      const permittedAttempts = new Set(
        attemptedIds.filter((id) => !completedEvidenceIds || completedEvidenceIds.includes(id)),
      );
      let recoveryQuestions = proposedQuestions?.map((question) => ({
        ...question,
        attemptedEvidenceIds: question.attemptedEvidenceIds.filter((id) =>
          permittedAttempts.has(id),
        ),
      }));
      const evidenceRequired = input.outcome === 'recovered' || input.outcome === 'recheck';
      const missingRequiredEvidence = evidenceRequired && recoveryEvidenceIds.length === 0;
      const outcome =
        missingRequiredEvidence ||
        (input.outcome === 'recovered' &&
          recoveryQuestions?.some((question) => question.resolutionRelevance === 'blocking')) ||
        (input.outcome === 'recheck' &&
          (input.attempt >= input.maxChecks || !input.scheduleRecheck))
          ? 'needs_human'
          : input.outcome;
      const recovered = outcome === 'recovered';
      const summary = missingRequiredEvidence
        ? 'Recovery could not be verified because cited evidence was unavailable.'
        : input.summary;
      const content = missingRequiredEvidence
        ? `${summary}\nRun a current health check and cite its durable evidence before resolving.`
        : input.content;
      if (
        recoveryQuestions !== undefined &&
        outcome === 'needs_human' &&
        !recoveryQuestions.some((question) => question.resolutionRelevance === 'blocking')
      ) {
        recoveryQuestions = [
          ...recoveryQuestions,
          {
            question: missingRequiredEvidence
              ? 'Cited recovery evidence was unavailable.'
              : 'Automatic recovery monitoring could not continue.',
            category: 'partial_evidence',
            evidenceKind: null,
            attemptedEvidenceIds: [],
            resolutionRelevance: 'blocking',
            nextAction:
              'Run a current health check and cite its durable evidence before resolving.',
          },
        ];
      }
      const recoveryUnknowns =
        recoveryQuestions?.map((question) => question.question) ??
        (missingRequiredEvidence
          ? ['Cited recovery evidence was unavailable.']
          : input.recoveryUnknowns);
      const recoveryNextStep = missingRequiredEvidence
        ? 'Run a current health check and cite its durable evidence before resolving.'
        : input.recoveryNextStep;
      const recoveryChecks = missingRequiredEvidence ? [] : input.recoveryChecks;
      const schedule = outcome === 'recheck' ? input.scheduleRecheck! : null;
      if (schedule) await schedule.enqueueTx(tx);
      const { message } = await this.store.appendTxOnce(tx, tenantId, conversationIncidentId, {
        author: 'agent',
        kind: outcome === 'recheck' && !input.resumeMessageId ? 'status' : 'finding',
        content,
        summary,
        ...(input.finding
          ? {
              finding: {
                ...input.finding,
                evidenceIds: recoveryEvidenceIds,
                nextStep: recoveryNextStep,
              },
            }
          : {}),
        recovery: {
          recovered,
          outcome,
          checks: recoveryChecks,
          unknowns: recoveryUnknowns,
          ...(recoveryQuestions !== undefined ? { questions: recoveryQuestions } : {}),
          nextStep: recoveryNextStep,
          attempt: input.attempt,
          maxChecks: input.maxChecks,
          nextCheckAt: schedule?.nextCheckAt.toISOString() ?? null,
          scheduleReason: schedule?.reason ?? null,
        },
        originMessageId: input.eventKey,
      });
      await tx
        .update(incidents)
        .set({
          investigationStatus: 'assessed',
          recoveryState:
            outcome === 'recovered'
              ? 'verified'
              : outcome === 'recheck'
                ? 'monitoring'
                : 'not_verified',
          recoverySummary: summary,
          recoveryEvidenceIds,
          recoveryUnknowns,
          recoveryQuestions: recoveryQuestions ?? null,
          recoveryQuestionsUpdatedAt: recoveryQuestions !== undefined ? sql`now()` : null,
          recoveryNextStep,
          recoveryUpdatedAt: sql`now()`,
          recoveryRunId: null,
          recoveryAttempt: input.attempt,
          recoveryMaxChecks: input.maxChecks,
          recoveryNextCheckAt: schedule?.nextCheckAt ?? null,
          recoveryScheduleReason: schedule?.reason ?? null,
          updatedAt: sql`now()`,
        })
        .where(eq(incidents.id, incidentId));
      if (input.resumeMessageId)
        await advanceResumeWatermarkTx(tx, conversationIncidentId, input.resumeMessageId);
      for (const { signalId, signalVersion, materialHash } of input.assessedMaterials)
        await markSignalMaterialInvestigatedTx(tx, signalId, materialHash, signalVersion);
      let lifecycleMessage: HubMessage | null = null;
      const additionalLifecycleMessages: HubMessage[] = [];
      if (
        input.autoResolve &&
        outcome === 'recovered' &&
        ACTIVE_STATUSES.includes(incident.status as (typeof ACTIVE_STATUSES)[number]) &&
        signals.length > 0 &&
        signals.every((signal) => signal.state === 'resolved')
      ) {
        const pending = await tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(and(inArray(approvals.incidentId, responseGroupIds), isNull(approvals.decision)))
          .limit(1);
        if (!pending[0]) {
          const lifecycleMessages = await appendResolvedResponseGroupTx(
            this.store,
            tx,
            tenantId,
            incidentId,
            responseGroupIds,
            input.expectedLifecycleVersion,
            `Incident resolved: ${input.autoResolve.reason}`,
            input.autoResolve.transitionKey,
          );
          lifecycleMessage = lifecycleMessages[0] ?? null;
          additionalLifecycleMessages.push(...lifecycleMessages.slice(1));
        }
      }
      return {
        applied: true,
        retryable: false,
        autoResolved: lifecycleMessage !== null,
        runCompleted: true,
        message,
        replyMessage: null,
        lifecycleMessage,
        additionalLifecycleMessages,
      };
    });
    if (result.message) await this.publishAppended(result.message);
    if (result.replyMessage) await this.publishAppended(result.replyMessage);
    if (result.lifecycleMessage) await this.publishAppended(result.lifecycleMessage);
    for (const message of result.additionalLifecycleMessages) await this.publishAppended(message);
    return result;
  }
}
