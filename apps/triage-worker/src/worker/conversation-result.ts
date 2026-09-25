import {
  advanceResumeWatermark,
  advanceResumeWatermarkTx,
  approvalMessageExistsTx,
  completeInvestigationRunTx,
  createApprovalTx,
  humanMessageFenceMatchesTx,
  withTenant,
  type Tx,
} from '@sre/db';
import type { TriageResult } from '../engine/types';
import { approvalActionId } from '../engine/approval-id';
import { publicModelText } from '../public-output';
import type { PersistOptions } from './contracts';
import { incidentFindingPayload, investigationRunCompletion } from './run-result';
import type { WorkerRuntime } from './runtime';
import { persistNonPromotingRun } from './terminal';

/** Publish a conversation result under the same fence as the context it consumed.
 * @param runtime - Persistence and live publication dependencies.
 * @param tenantId - Server-selected workspace.
 * @param incidentId - Current case.
 * @param result - Reviewed reply or proposal.
 * @param options - Consumed input and immutable run.
 */
export async function persistConversationResult(
  runtime: WorkerRuntime,
  tenantId: string,
  incidentId: string,
  result: TriageResult,
  options: PersistOptions,
): Promise<boolean> {
  const { runId, resumeMessageId, priorInvestigationStatus, humanMessageFence } = options;
  const { deps } = runtime;
  const disposition = result.disposition;
  if (disposition === 'reply') {
    const content = publicModelText(result.detail ?? '');
    const summary = publicModelText(result.summary);
    const replyKind =
      result.replyPurpose === 'clarification_request'
        ? priorInvestigationStatus === 'degraded'
          ? 'degraded_reask'
          : 'clarification_request'
        : 'reply';
    const message = runId
      ? await withTenant(deps.appDb, tenantId, async (tx) => {
          if (!(await humanMessageFenceMatchesTx(tx, incidentId, humanMessageFence)))
            return undefined;
          const completed = await completeInvestigationRunTx(
            tx,
            incidentId,
            investigationRunCompletion(runId, result),
          );
          if (!completed) return null;
          if (resumeMessageId) await advanceResumeWatermarkTx(tx, incidentId, resumeMessageId);
          const allowed = new Set(completed.evidenceIds);
          const finding = incidentFindingPayload(
            result,
            runId,
            'conversation_only',
            'responder_reply',
          );
          return (
            await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
              author: 'agent',
              kind: replyKind,
              content,
              summary,
              finding: {
                ...finding,
                evidenceIds: finding.evidenceIds.filter((id) => allowed.has(id)),
              },
              originMessageId: `run-result:${runId}`,
            })
          ).message;
        })
      : await deps.hub.append(tenantId, incidentId, {
          author: 'agent',
          kind: replyKind,
          content,
          summary,
          finding: incidentFindingPayload(
            result,
            undefined,
            'conversation_only',
            'responder_reply',
          ),
        });
    if (message === undefined)
      return persistNewerContext(runtime, tenantId, incidentId, result, {
        runId,
        resumeMessageId,
        priorInvestigationStatus,
      });
    if (!message) return false;
    if (runId) await deps.hub.publishAppendedBestEffort(message);
    if (resumeMessageId && !runId)
      await advanceResumeWatermark(deps.appDb, tenantId, incidentId, resumeMessageId);
    return true;
  }
  if (disposition === 'approval') {
    const outcome = await withTenant(deps.appDb, tenantId, async (tx) => {
      if (!(await humanMessageFenceMatchesTx(tx, incidentId, humanMessageFence))) return undefined;
      if (
        runId &&
        !(await completeInvestigationRunTx(
          tx,
          incidentId,
          investigationRunCompletion(runId, result),
        ))
      )
        return null;
      const message = await persistApprovalTx(
        runtime,
        tx,
        tenantId,
        incidentId,
        result,
        resumeMessageId,
      );
      return { message };
    });
    if (outcome === undefined)
      return persistNewerContext(runtime, tenantId, incidentId, result, {
        runId,
        resumeMessageId,
        priorInvestigationStatus,
      });
    if (outcome === null) return false;
    if (outcome.message) await deps.hub.publishAppendedBestEffort(outcome.message);
    return true;
  }
  return false;
}

async function persistApprovalTx(
  runtime: WorkerRuntime,
  tx: Tx,
  tenantId: string,
  incidentId: string,
  result: TriageResult,
  resumeMessageId?: string,
) {
  const { deps } = runtime;
  const approval = result.approval;
  let message = null;
  if (approval) {
    const prompt = publicModelText(approval.prompt);
    const options = approval.options.map((option) => ({
      ...option,
      label: publicModelText(option.label),
    }));
    let { row, inserted } = await createApprovalTx(tx, tenantId, {
      incidentId,
      actionId: approvalActionId(prompt, options),
      prompt,
      options,
    });
    const base = resumeMessageId ?? incidentId;
    for (let attempt = 1; !inserted && row.decision !== null && attempt <= 10; attempt++) {
      ({ row, inserted } = await createApprovalTx(tx, tenantId, {
        incidentId,
        actionId: approvalActionId(prompt, options, `${base}#${attempt}`),
        prompt,
        options,
      }));
    }
    const needsMessage = inserted || !(await approvalMessageExistsTx(tx, row.id));
    if (needsMessage) {
      message = await deps.hub.appendTx(tx, tenantId, incidentId, {
        author: 'agent',
        kind: 'approval',
        content: prompt,
        approvalId: row.id,
        approval: { id: row.id, options },
      });
    }
  }
  if (resumeMessageId) await advanceResumeWatermarkTx(tx, incidentId, resumeMessageId);
  return message;
}

function persistNewerContext(
  runtime: WorkerRuntime,
  tenantId: string,
  incidentId: string,
  result: TriageResult,
  options: Pick<PersistOptions, 'runId' | 'resumeMessageId' | 'priorInvestigationStatus'>,
) {
  return persistNonPromotingRun({
    runtime: runtime,
    tenantId,
    incidentId,
    runId: options.runId,
    result: {
      ...result,
      outcome: 'inconclusive',
      disposition: undefined,
      summary:
        'New responder context is pending. This earlier draft was not published as the current answer.',
      // The superseded draft's open checks and next step no longer apply.
      reviewGaps: undefined,
      nextStep: null,
    },
    completion: investigationRunCompletion,
    investigationStatus: options.priorInvestigationStatus === 'assessed' ? 'assessed' : 'degraded',
    resumeMessageId: options.resumeMessageId,
    promotionReason: 'state_changed',
  });
}
