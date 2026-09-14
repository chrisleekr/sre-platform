import {
  activeResponderTx,
  humanMessageFenceMatchesTx,
  invalidateCaptureProposalsTx,
  knowledgeCaptureProposals,
  lockIncidentWorkTx,
  withTenant,
  type HumanMessage,
} from '@sre/db';
import { RetryableError } from '@sre/queue';
import { and, eq } from 'drizzle-orm';
import type { WorkerRuntime } from './runtime';

/** A bare answer is capture-related only while this incident has durable pending capture context.
 * @param runtime - Existing worker dependencies.
 * @param tenantId - Current workspace.
 * @param incidentId - Current incident.
 */
export async function hasPendingKnowledgeCapture(
  runtime: WorkerRuntime,
  tenantId: string,
  incidentId: string,
): Promise<boolean> {
  return withTenant(runtime.deps.appDb, tenantId, async (tx) => {
    const [proposal] = await tx
      .select({ id: knowledgeCaptureProposals.id })
      .from(knowledgeCaptureProposals)
      .where(
        and(
          eq(knowledgeCaptureProposals.incidentId, incidentId),
          eq(knowledgeCaptureProposals.status, 'pending'),
        ),
      )
      .limit(1);
    return !!proposal;
  });
}

/** Persist capture authority before publishing its code-owned offer.
 * @param runtime - Existing worker dependencies.
 * @param tenantId - Workspace selected by the job.
 * @param incidentId - Current incident.
 * @param request - Authenticated request for an unsupported external write.
 * @param fence - Latest interpreted human message.
 */
export async function offerKnowledgeCapture(
  runtime: WorkerRuntime,
  tenantId: string,
  incidentId: string,
  request: HumanMessage,
  fence: string,
): Promise<void> {
  const { deps } = runtime;
  const message = await withTenant(deps.appDb, tenantId, async (tx) => {
    await lockIncidentWorkTx(tx, tenantId, [incidentId]);
    if (!(await humanMessageFenceMatchesTx(tx, incidentId, fence)))
      throw new RetryableError(
        'New input arrived before the capture offer; reinterpret the request.',
      );
    const allowed = await activeResponderTx(tx, tenantId, request.authorUserId);
    const available = allowed && !!deps.runbookQueue && request.id === fence;
    await invalidateCaptureProposalsTx(tx, incidentId, request.id);
    const { message: offer } = await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
      author: 'system',
      kind: 'reply',
      content: available
        ? 'I cannot commit a document to a repository. I can save a diagnostic guide from this incident in this workspace instead. Reply Yes within 15 minutes to save it, or No to cancel. This will not change any external system. Other input supersedes this offer.'
        : request.id !== fence
          ? 'Newer input superseded this capture offer. No document was saved. Ask explicitly to save a diagnostic guide if still needed.'
          : 'I cannot commit a document to a repository. Platform knowledge capture requires an active, linked workspace member and a configured capture worker. No document was saved.',
      originMessageId: `knowledge-offer:${request.id}`,
    });
    if (available && offer)
      await tx
        .insert(knowledgeCaptureProposals)
        .values({
          tenantId,
          incidentId,
          requestedBy: request.authorUserId!,
          sourceMessageId: request.id,
          offerMessageId: offer.id,
          fenceMessageId: fence,
        })
        .onConflictDoNothing();
    return offer;
  });
  await deps.hub.publishAppendedBestEffort(message);
}

/** Invalidate prior offers when conversation context changes.
 * @param runtime - Existing worker dependencies.
 * @param tenantId - Current workspace.
 * @param incidentId - Current incident.
 * @param message - New persisted human message.
 * @param cancelled - Whether the message explicitly declines the offer.
 */
export async function invalidateKnowledgeCapture(
  runtime: WorkerRuntime,
  tenantId: string,
  incidentId: string,
  message: HumanMessage,
  cancelled = false,
): Promise<void> {
  await withTenant(runtime.deps.appDb, tenantId, async (tx) => {
    await lockIncidentWorkTx(tx, tenantId, [incidentId]);
    await invalidateCaptureProposalsTx(
      tx,
      incidentId,
      message.id,
      cancelled ? 'cancelled' : 'superseded',
    );
  });
}
