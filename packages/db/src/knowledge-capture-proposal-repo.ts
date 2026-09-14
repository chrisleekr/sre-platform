import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from './rls';
import { incidentMessages, knowledgeCaptureProposals } from './schema';

/** New requests supersede old capture offers, but a redelivered offer does not cancel itself.
 * @param tx - Tenant transaction holding the incident work lock.
 * @param incidentId - Current incident.
 * @param sourceMessageId - New human input.
 * @param status - Cancellation or superseding context.
 */
export async function invalidateCaptureProposalsTx(
  tx: Tx,
  incidentId: string,
  sourceMessageId: string,
  status: 'cancelled' | 'superseded' = 'superseded',
): Promise<void> {
  await tx
    .update(knowledgeCaptureProposals)
    .set({ status })
    .where(
      and(
        eq(knowledgeCaptureProposals.incidentId, incidentId),
        eq(knowledgeCaptureProposals.status, 'pending'),
        ne(knowledgeCaptureProposals.sourceMessageId, sourceMessageId),
      ),
    );
}

/** Consume only the requester's current offer, within its deadline and without intervening input.
 * @param tx - Tenant transaction holding the incident work lock and latest-message fence.
 * @param incidentId - Current incident.
 * @param requester - Authenticated linked user, reauthorized by the caller.
 * @param messageId - Persisted confirmation.
 */
export async function consumeCaptureProposalTx(
  tx: Tx,
  incidentId: string,
  requester: string,
  messageId: string,
): Promise<boolean> {
  const [proposal] = await tx
    .select()
    .from(knowledgeCaptureProposals)
    .where(
      and(
        eq(knowledgeCaptureProposals.incidentId, incidentId),
        eq(knowledgeCaptureProposals.status, 'pending'),
      ),
    )
    .orderBy(desc(knowledgeCaptureProposals.createdAt), desc(knowledgeCaptureProposals.id))
    .limit(1)
    .for('update');
  if (!proposal) return false;
  const recent = await tx
    .select({ id: incidentMessages.id })
    .from(incidentMessages)
    .where(
      and(
        eq(incidentMessages.incidentId, incidentId),
        eq(incidentMessages.author, 'human'),
        eq(incidentMessages.kind, 'text'),
      ),
    )
    .orderBy(desc(incidentMessages.createdAt), desc(incidentMessages.id))
    .limit(2);
  const [clock] = await tx
    .select({ expired: sql<boolean>`${knowledgeCaptureProposals.expiresAt} <= now()` })
    .from(knowledgeCaptureProposals)
    .where(eq(knowledgeCaptureProposals.id, proposal.id));
  const status = clock?.expired
    ? 'expired'
    : recent[0]?.id !== messageId || recent[1]?.id !== proposal.fenceMessageId
      ? 'superseded'
      : null;
  if (status) {
    await tx
      .update(knowledgeCaptureProposals)
      .set({ status })
      .where(eq(knowledgeCaptureProposals.id, proposal.id));
    return false;
  }
  if (proposal.requestedBy !== requester) return false;
  await tx
    .update(knowledgeCaptureProposals)
    .set({ status: 'consumed', consumedMessageId: messageId })
    .where(eq(knowledgeCaptureProposals.id, proposal.id));
  return true;
}
