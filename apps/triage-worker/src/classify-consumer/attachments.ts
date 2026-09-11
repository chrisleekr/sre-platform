import type { InboundCandidate } from '@sre/connectors';
import {
  activateSurfaceBinding,
  bumpIncidentOccurrenceOnce,
  recordSurfaceBinding,
  withTenant,
} from '@sre/db';
import type { HubMessage, NewMessage } from '@sre/hub';
import type { ClassifyCore } from './core';

export class ClassifyAttachments {
  constructor(private readonly core: ClassifyCore) {}

  async attachBot(
    tenantId: string,
    incidentId: string,
    candidate: InboundCandidate,
    content: string,
    enqueueReassessment = true,
  ): Promise<void> {
    const { deps } = this.core;
    const { hub } = deps;
    if (!hub) throw new Error('classify correlation path is not wired (hub)');
    const jobIds = new Set<string>();
    const published: HubMessage[] = [];
    const applied = await withTenant(deps.appDb, tenantId, async (tx) => {
      let anyApplied = false;
      const sourceBinding = await recordSurfaceBinding(tx, tenantId, {
        incidentId,
        surface: 'slack',
        channel: candidate.channel,
        threadId: candidate.externalId,
        role: 'source',
      });
      const targetIncidentId = sourceBinding.incidentId;
      let ownerIncidentId: string | null = null;
      for (const signal of this.core.signalsFor({ ...candidate, text: content })) {
        const result = await hub.observeSignalTx(
          tx,
          tenantId,
          { incidentId: targetIncidentId, ...signal },
          signal.summary,
        );
        ownerIncidentId ??= result.observation.signal.incidentId;
        if (ownerIncidentId !== result.observation.signal.incidentId)
          throw new Error('grouped Slack observations belong to different incidents');
        if (result.message) published.push(result.message);
        if (!result.observation.applied) continue;
        anyApplied = true;
        if (enqueueReassessment) {
          const { jobId } = await deps.queue.insertReassessmentTx(
            tx,
            tenantId,
            result.observation.signal.incidentId,
            result.observation.signal.id,
            result.observation.signal.version,
            result.observation.investigationTriggerReason ?? 'material_change',
          );
          if (jobId) jobIds.add(jobId);
        }
      }
      const firstOccurrence = await bumpIncidentOccurrenceOnce(
        tx,
        tenantId,
        ownerIncidentId ?? targetIncidentId,
        this.core.messageKey(candidate.channel, candidate.externalId),
      );
      if (sourceBinding.role === 'source' && firstOccurrence)
        await activateSurfaceBinding(
          tx,
          tenantId,
          'slack',
          ownerIncidentId ?? targetIncidentId,
          sourceBinding.id,
        );
      return anyApplied;
    });
    for (const message of published) await this.core.publishAppended(message);
    if (applied) for (const jobId of jobIds) await this.core.publishJob(jobId);
  }

  async attachHuman(
    tenantId: string,
    incidentId: string,
    channel: string,
    messageId: string,
    content: string,
    breadcrumb?: () => Promise<void>,
    enqueueResume = true,
    authorUserId: string | null = null,
    priorThread = '',
  ): Promise<void> {
    const { deps } = this.core;
    const { hub } = deps;
    if (!hub) throw new Error('classify correlation path is not wired (hub)');
    if (priorThread.trim())
      await hub.appendOnce(
        tenantId,
        incidentId,
        priorThreadMessage(priorThread, this.core.messageKey(channel, messageId)),
      );
    const { message } = await hub.appendOnce(tenantId, incidentId, {
      author: 'human',
      authorUserId,
      kind: 'text',
      content,
      originSurface: 'slack',
      originMessageId: this.core.messageKey(channel, messageId),
    });
    if (enqueueResume) await deps.queue.enqueueResume(tenantId, message.incidentId, message.id);
    if (breadcrumb)
      await breadcrumb().catch((error) =>
        this.core.warnPostCommitFailure('breadcrumb', error, { incidentId: message.incidentId }),
      );
  }

  foldIntoOwner(
    tenantId: string,
    candidate: InboundCandidate,
    scrubbedText: string,
  ): (owner: string) => Promise<void> {
    return async (owner) => {
      if (candidate.author === 'bot') {
        await this.attachBot(tenantId, owner, candidate, scrubbedText);
        return;
      }
      await this.attachHuman(
        tenantId,
        owner,
        candidate.channel,
        candidate.externalId,
        scrubbedText,
      );
    };
  }
}

/** Keep imported history distinct from the authenticated current request.
 * @param content - Scrubbed prior provider messages.
 * @param sourceId - Idempotent current-message origin.
 */
export function priorThreadMessage(content: string, sourceId: string): NewMessage {
  return {
    author: 'system',
    kind: 'status',
    content: `Prior Slack thread (context only):\n${content}`,
    originMessageId: `thread-context:${sourceId}`,
  };
}
