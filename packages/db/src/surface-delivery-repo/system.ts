import { and, asc, eq, lt, lte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  approvals,
  incidentMessages,
  surfaceDeliveries,
  type RecoveryMessagePayload,
} from '../schema';

export interface QueuedSurfaceMessage {
  tenantId: string;
  surface: string;
  bindingId: string;
  bindingAssignmentVersion: number;
  message: {
    id: string;
    incidentId: string;
    author: string;
    kind: string;
    content: string;
    summary: string | null;
    recovery: RecoveryMessagePayload | null;
    originSurface: string | null;
    authorUserId: string | null;
    approvalId: string | null;
    approval?: { id: string; options: { id: string; label: string }[] };
    lifecycleFrom: string | null;
    lifecycleTo: string | null;
    lifecycleVersion: number | null;
    transitionKey: string | null;
    signalId: string | null;
    signalState: string | null;
    signalEventType: string | null;
    createdAt: string;
  };
}

/**
 * System outbox scan. The worker owns this admin reader and applies tenant scope before all mutations.
 *
 * @param db - Database connection used for the operation.
 * @param limit - Maximum number of rows to return.
 */
export async function listQueuedSurfaceMessagesSystem(
  db: Db,
  limit = 20,
): Promise<QueuedSurfaceMessage[]> {
  const rows = await db
    .select({
      delivery: surfaceDeliveries,
      message: incidentMessages,
      approvalId: approvals.id,
      approvalOptions: approvals.options,
    })
    .from(surfaceDeliveries)
    .innerJoin(incidentMessages, eq(incidentMessages.id, surfaceDeliveries.messageId))
    .leftJoin(
      approvals,
      and(
        eq(approvals.id, incidentMessages.approvalId),
        eq(approvals.tenantId, incidentMessages.tenantId),
      ),
    )
    .where(
      and(eq(surfaceDeliveries.state, 'queued'), lte(surfaceDeliveries.nextAttemptAt, sql`now()`)),
    )
    .orderBy(
      asc(surfaceDeliveries.nextAttemptAt),
      asc(surfaceDeliveries.createdAt),
      asc(surfaceDeliveries.id),
    )
    .limit(Math.max(1, Math.min(limit, 100)));
  return rows.map(({ delivery, message, approvalId, approvalOptions }) => ({
    tenantId: delivery.tenantId,
    surface: delivery.surface,
    bindingId: delivery.bindingId,
    bindingAssignmentVersion: delivery.bindingAssignmentVersion,
    message: {
      id: message.id,
      incidentId: message.incidentId,
      author: message.author,
      kind: message.kind,
      content: message.content,
      summary: message.summary,
      recovery: message.recovery,
      originSurface: message.originSurface,
      authorUserId: message.authorUserId,
      approvalId: message.approvalId,
      lifecycleFrom: message.lifecycleFrom,
      lifecycleTo: message.lifecycleTo,
      lifecycleVersion: message.lifecycleVersion,
      transitionKey: message.transitionKey,
      signalId: message.signalId,
      signalState: message.signalState,
      signalEventType: message.signalEventType,
      ...(message.kind === 'approval' && approvalId
        ? {
            approval: {
              id: approvalId,
              options: approvalOptions as { id: string; label: string }[],
            },
          }
        : {}),
      createdAt: message.createdAt.toISOString(),
    },
  }));
}

/**
 * A crashed `sending` attempt is ambiguous. It must never be automatically posted again.
 *
 * @param db - Database connection used for the operation.
 * @param olderThan - Age boundary for stale delivery rows.
 */
export async function markStaleSurfaceDeliveriesUncertainSystem(
  db: Db,
  olderThan: Date,
): Promise<number> {
  const rows = await db
    .update(surfaceDeliveries)
    .set({
      state: 'uncertain',
      reasonCode: 'worker_interrupted',
      completedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(surfaceDeliveries.state, 'sending'), lt(surfaceDeliveries.attemptedAt, olderThan)),
    )
    .returning({ id: surfaceDeliveries.id });
  return rows.length;
}
