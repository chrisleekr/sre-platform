import { scrubSecrets } from '@sre/agent-tools';
import type { HumanMessage } from '@sre/db';
import type { Job } from '@sre/queue';
import { NonRetryableError, RetryableError } from '@sre/queue';
import { ProviderRateLimitError } from '../engine/types';
import { classifyLifecycleIntent, type LifecycleIntent } from '../lifecycle-intent';
import type { WorkerRuntime } from './runtime';
import { responderMessageWithinBudget } from './transcript';
import { requestKnowledgeCapture } from './knowledge-capture';
import { draftConversationIssue, handleIssueDecision } from './issue-actions';
import {
  hasPendingKnowledgeCapture,
  invalidateKnowledgeCapture,
  offerKnowledgeCapture,
} from './knowledge-capture-offer';

/** Execute only bounded, explicit actions; every receipt follows the lifecycle transaction.
 * @param runtime - Worker dependencies and semantic model boundary.
 * @param job - Tenant-scoped resume job.
 * @param incidentId - Server-selected current case.
 * @param messages - Fresh durable human input, in order.
 * @param version - Lifecycle version before interpretation.
 * @param signal - Attempt deadline.
 * @param progress - Bounded look-ahead and durable per-message checkpoint.
 */
export async function processResponderActions(
  runtime: WorkerRuntime,
  job: Job,
  incidentId: string,
  messages: HumanMessage[],
  version: number,
  signal: AbortSignal,
  progress: {
    newer: HumanMessage[];
    pending: HumanMessage[];
    base: string | null;
    checkpoint: (messageId: string, pendingId: string | null) => Promise<void>;
  },
): Promise<HumanMessage[]> {
  let pendingQuestions = progress.pending;
  const checkpoint = (id: string) => progress.checkpoint(id, pendingQuestions.at(-1)?.id ?? null);
  for (const message of messages) {
    if (!responderMessageWithinBudget(message.content)) {
      await runtime.deps.hub.appendOnce(job.tenantId, incidentId, {
        author: 'system',
        kind: 'reply',
        content:
          'A pending request is too long to interpret safely. It was not sent for investigation and no lifecycle change was made for it. Please resend a shorter request; the original remains in the conversation.',
        originMessageId: `intent-message-limit:${incidentId}:${progress.base ?? 'initial'}`,
      });
      await checkpoint(message.id);
      continue;
    }
    const position = progress.newer.findIndex((item) => item.id === message.id);
    const newer =
      position < 0 ? [] : progress.newer.slice(position + 1).map((item) => item.content);
    if (
      position < 0 ||
      JSON.stringify({ currentMessage: message.content, newerMessages: newer }).length > 24_000
    ) {
      await runtime.deps.hub.appendOnce(job.tenantId, incidentId, {
        author: 'system',
        kind: 'reply',
        content:
          'This thread has more pending context than can be interpreted safely at once. Older requests remain in the conversation, but their lifecycle actions were not executed. Please restate any still-needed status change after the backlog clears.',
        originMessageId: `intent-context-limit:${incidentId}:${progress.base ?? 'initial'}`,
      });
      pendingQuestions = [message];
      await checkpoint(message.id);
      continue;
    }
    let intent: LifecycleIntent;
    if (await handleIssueDecision(runtime, job, incidentId, message)) {
      await invalidateKnowledgeCapture(runtime, job.tenantId, incidentId, message);
      pendingQuestions = [];
      await checkpoint(message.id);
      continue;
    }
    const confirmation = /^(yes|no)[.!]?$/i.exec(message.content.trim())?.[1]?.toLowerCase();
    if (confirmation) {
      if (!(await hasPendingKnowledgeCapture(runtime, job.tenantId, incidentId))) {
        pendingQuestions = [message];
        await checkpoint(message.id);
        continue;
      }
      if (confirmation === 'yes') {
        await requestKnowledgeCapture(
          runtime,
          job.tenantId,
          incidentId,
          message,
          progress.newer.at(-1)!.id,
          true,
        );
      } else {
        await invalidateKnowledgeCapture(runtime, job.tenantId, incidentId, message, true);
        await runtime.deps.hub.appendOnce(job.tenantId, incidentId, {
          author: 'system',
          kind: 'reply',
          content:
            'No knowledge capture was requested. Any pending capture offer has been cancelled.',
          originMessageId: `knowledge-declined:${message.id}`,
        });
      }
      pendingQuestions = [];
      await checkpoint(message.id);
      continue;
    }
    await invalidateKnowledgeCapture(runtime, job.tenantId, incidentId, message);
    try {
      intent = await runtime.executeSemantic(job, 'responder-intent', signal, (generator) =>
        classifyLifecycleIntent(generator, message.content, signal, newer),
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ProviderRateLimitError) {
        await runtime.deps.hub.appendOnce(job.tenantId, incidentId, {
          author: 'system',
          kind: 'reply',
          content:
            'The AI provider rate limit prevented interpreting this request. No change was made for this request. Use the lifecycle controls or send a new request after the limit clears; this request will not be retried automatically.',
          originMessageId: `intent-rate-limit:${message.id}`,
        });
        await checkpoint(message.id);
        throw new NonRetryableError('AI provider rate limit reached');
      }
      intent = {
        kind: 'clarify',
        target: 'ambiguous',
        to: null,
        reason:
          'I could not interpret this request safely. No incident changes were made. Please retry or use the lifecycle controls.',
      };
    }
    if (intent.kind === 'investigate') {
      pendingQuestions = [message];
      await checkpoint(message.id);
      continue;
    }
    if (intent.kind === 'clarify') {
      await runtime.deps.hub.appendOnce(job.tenantId, incidentId, {
        author: 'agent',
        kind: 'reply',
        content: scrubSecrets(intent.reason),
        originMessageId: `intent-clarification:${message.id}`,
      });
      await checkpoint(message.id);
      continue;
    }
    if (intent.kind === 'capture_knowledge') {
      await requestKnowledgeCapture(
        runtime,
        job.tenantId,
        incidentId,
        message,
        progress.newer.at(-1)!.id,
      );
      pendingQuestions = [];
      await checkpoint(message.id);
      continue;
    }
    if (intent.kind === 'offer_capture_knowledge') {
      await offerKnowledgeCapture(
        runtime,
        job.tenantId,
        incidentId,
        message,
        progress.newer.at(-1)!.id,
      );
      pendingQuestions = [];
      await checkpoint(message.id);
      continue;
    }
    if (intent.kind === 'manage_issue') {
      await draftConversationIssue(runtime, job, incidentId, message, signal);
      pendingQuestions = [];
      await checkpoint(message.id);
      continue;
    }
    const { transition, message: receipt } = await runtime.deps.hub.transitionIncident(
      job.tenantId,
      incidentId,
      {
        to: intent.to!,
        reason: scrubSecrets(intent.reason),
        transitionKey: `verbal:${incidentId}:${message.id}`,
        author: 'human',
        originSurface: message.originSurface ?? undefined,
        authorUserId: message.authorUserId,
        expectedVersion: version,
        humanMessageFence: progress.newer.at(-1)!.id,
      },
    );
    if (transition.outcome === 'precondition_failed')
      throw new RetryableError(
        'New responder input arrived before the lifecycle action; reconcile the current request batch.',
      );
    if (transition.version !== null) version = transition.version;
    if (transition.outcome === 'applied') {
      pendingQuestions = [];
      if (intent.to === 'closed')
        await runtime.deps.hub.appendOnce(job.tenantId, incidentId, {
          author: 'system',
          kind: 'status',
          content:
            'Case closed. This does not verify service recovery or change monitors. Findings and evidence are preserved.',
          originMessageId: `closure-scope:${message.id}`,
        });
    } else if (transition.outcome === 'noop') {
      pendingQuestions = [];
      if (!receipt)
        await runtime.deps.hub.appendOnce(job.tenantId, incidentId, {
          author: 'system',
          kind: 'status',
          content: `This case is already ${transition.to}. No lifecycle change was needed.`,
          originMessageId: `intent-noop:${message.id}`,
        });
    } else
      await runtime.deps.hub.appendOnce(job.tenantId, incidentId, {
        author: 'system',
        kind: 'reply',
        content:
          transition.outcome === 'forbidden'
            ? 'I could not change this case. An active, linked workspace member is required; its lifecycle is unchanged.'
            : `I could not apply that lifecycle change (${transition.outcome}). Please review the current case state.`,
        originMessageId: `verbal-rejected:${incidentId}:${message.id}`,
      });
    await checkpoint(message.id);
  }
  return pendingQuestions;
}
