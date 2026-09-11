import { and, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Tx } from './rls';
import {
  incidentMessages,
  incidents,
  surfaceBindings,
  surfaceConfigs,
  surfaceDeliveries,
  type SurfaceDeliveryState,
} from './schema';

export type SurfaceDeliveryOperation = 'post' | 'update' | 'delete' | 'composite';
export type SurfaceDeliveryAudience =
  'dashboard_only' | 'current_binding' | 'specific_binding' | 'status_bindings';

export interface SurfaceDeliveryReceipt {
  messageId: string;
  bindingId: string;
  surface: string;
  state: SurfaceDeliveryState;
  operation: SurfaceDeliveryOperation;
  remoteMessageId: string | null;
  reasonCode: string | null;
  attemptedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Queue one outbox row per currently connected destination, excluding the message's origin surface.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param messageId - Durable message targeted by the operation.
 * @param messageKind - Hub message kind being scheduled for delivery.
 * @param originSurface - Surface that originated the message, if any.
 * @param routing - Explicit delivery audience when the message overrides policy defaults.
 */
export async function enqueueConnectedSurfaceDeliveriesTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  messageId: string,
  messageKind: string,
  originSurface?: string | null,
  routing?: { audience: SurfaceDeliveryAudience; bindingId?: string },
): Promise<void> {
  const audience =
    routing?.audience ??
    (messageKind === 'relationship'
      ? 'dashboard_only'
      : messageKind === 'lifecycle'
        ? 'status_bindings'
        : 'current_binding');
  if (audience === 'dashboard_only') return;
  if (audience === 'specific_binding' && !routing?.bindingId)
    throw new Error('specific surface delivery requires a binding id');
  const configs = await tx
    .select({
      surface: surfaceConfigs.surface,
      bindingId: surfaceBindings.id,
      bindingAssignmentVersion: surfaceBindings.assignmentVersion,
      projectionMode: surfaceBindings.projectionMode,
    })
    .from(surfaceConfigs)
    .innerJoin(
      surfaceBindings,
      and(
        eq(surfaceBindings.tenantId, surfaceConfigs.tenantId),
        eq(surfaceBindings.surface, surfaceConfigs.surface),
        eq(surfaceBindings.incidentId, incidentId),
      ),
    )
    .where(eq(surfaceConfigs.tenantId, tenantId));
  const destinations = configs.filter(
    (config) =>
      (audience === 'status_bindings' ||
        (audience === 'current_binding' && config.projectionMode === 'full') ||
        (audience === 'specific_binding' && config.bindingId === routing?.bindingId)) &&
      (audience !== 'current_binding' || config.surface !== originSurface),
  );
  if (destinations.length === 0) return;
  await tx
    .insert(surfaceDeliveries)
    .values(
      destinations.map(({ surface, bindingId, bindingAssignmentVersion }) => ({
        tenantId,
        incidentId,
        messageId,
        surface,
        bindingId,
        bindingAssignmentVersion,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Connected destinations durably queued for this message. An absent row is intentionally untracked.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param messageId - Durable message targeted by the operation.
 */
export async function listMessageDeliveryTargets(
  db: Db,
  tenantId: string,
  messageId: string,
): Promise<Array<{ surface: string; bindingId: string; bindingAssignmentVersion: number }>> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        surface: surfaceDeliveries.surface,
        bindingId: surfaceDeliveries.bindingId,
        bindingAssignmentVersion: surfaceDeliveries.bindingAssignmentVersion,
      })
      .from(surfaceDeliveries)
      .where(eq(surfaceDeliveries.messageId, messageId));
    return rows;
  });
}

/**
 * Claim exactly one queued attempt. A prior terminal or in-flight row returns false.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 * @param messageId - Durable message targeted by the operation.
 */
export async function claimSurfaceDelivery(
  db: Db,
  tenantId: string,
  surface: string,
  bindingId: string,
  messageId: string,
): Promise<boolean> {
  return withTenant(db, tenantId, (tx) =>
    claimSurfaceDeliveryTx(tx, surface, bindingId, messageId),
  );
}

/**
 * Transactional claim used when the caller needs the incident lock to remain held until commit.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param surface - Surface adapter targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 * @param messageId - Durable message targeted by the operation.
 */
export async function claimSurfaceDeliveryTx(
  tx: Tx,
  surface: string,
  bindingId: string,
  messageId: string,
): Promise<boolean> {
  const delivery = await tx
    .select({ incidentId: surfaceDeliveries.incidentId })
    .from(surfaceDeliveries)
    .where(
      and(
        eq(surfaceDeliveries.surface, surface),
        eq(surfaceDeliveries.bindingId, bindingId),
        eq(surfaceDeliveries.messageId, messageId),
        eq(surfaceDeliveries.state, 'queued'),
      ),
    )
    .limit(1);
  if (!delivery[0]) return false;
  const visible = await tx
    .select({ id: incidents.id })
    .from(incidents)
    .where(and(eq(incidents.id, delivery[0].incidentId), sql`${incidents.archivedAt} is null`))
    .limit(1)
    .for('update');
  if (!visible[0]) {
    await tx
      .update(surfaceDeliveries)
      .set({
        state: 'blocked',
        operation: 'composite',
        reasonCode: 'incident_archived',
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(surfaceDeliveries.surface, surface),
          eq(surfaceDeliveries.bindingId, bindingId),
          eq(surfaceDeliveries.messageId, messageId),
          eq(surfaceDeliveries.state, 'queued'),
        ),
      );
    return false;
  }
  const rows = await tx
    .update(surfaceDeliveries)
    .set({ state: 'sending', attemptedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(surfaceDeliveries.surface, surface),
        eq(surfaceDeliveries.bindingId, bindingId),
        eq(surfaceDeliveries.messageId, messageId),
        eq(surfaceDeliveries.state, 'queued'),
        lte(surfaceDeliveries.nextAttemptAt, sql`now()`),
      ),
    )
    .returning({ id: surfaceDeliveries.id });
  return rows.length === 1;
}

/**
 * Durably delay a retry that is known not to have reached the remote surface.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 * @param messageId - Durable message targeted by the operation.
 * @param expectedState - Delivery state required for the conditional transition.
 * @param retryAt - Timestamp for the next delivery attempt.
 * @param reasonCode - Stable operator-facing reason category.
 */
export async function scheduleSurfaceDeliveryRetry(
  db: Db,
  tenantId: string,
  surface: string,
  bindingId: string,
  messageId: string,
  expectedState: 'queued' | 'sending',
  retryAt: Date,
  reasonCode: 'dependency_unavailable' | 'projection_busy' | 'rate_limited',
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(surfaceDeliveries)
      .set({
        state: 'queued',
        reasonCode,
        nextAttemptAt: retryAt,
        attemptedAt: null,
        completedAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(surfaceDeliveries.surface, surface),
          eq(surfaceDeliveries.bindingId, bindingId),
          eq(surfaceDeliveries.messageId, messageId),
          eq(surfaceDeliveries.state, expectedState),
        ),
      )
      .returning({ id: surfaceDeliveries.id });
    return rows.length === 1;
  });
}

/**
 * Finish a claimed delivery. CAS prevents a late worker from overwriting reconciliation.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 * @param messageId - Durable message targeted by the operation.
 * @param result - Validated operation result to persist.
 */
export async function finishSurfaceDelivery(
  db: Db,
  tenantId: string,
  surface: string,
  bindingId: string,
  messageId: string,
  result: {
    state: Exclude<SurfaceDeliveryState, 'queued' | 'sending'>;
    operation: SurfaceDeliveryOperation;
    remoteMessageId?: string | null;
    reasonCode?: string | null;
  },
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(surfaceDeliveries)
      .set({
        state: result.state,
        operation: result.operation,
        remoteMessageId: result.remoteMessageId ?? null,
        reasonCode: result.reasonCode ?? null,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(surfaceDeliveries.surface, surface),
          eq(surfaceDeliveries.bindingId, bindingId),
          eq(surfaceDeliveries.messageId, messageId),
          eq(surfaceDeliveries.state, 'sending'),
        ),
      )
      .returning({ id: surfaceDeliveries.id });
    return rows.length === 1;
  });
}

/**
 * Mark a pre-request configuration failure without ever claiming an external attempt.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 * @param messageId - Durable message targeted by the operation.
 * @param reasonCode - Stable operator-facing reason category.
 */
export async function blockQueuedSurfaceDelivery(
  db: Db,
  tenantId: string,
  surface: string,
  bindingId: string,
  messageId: string,
  reasonCode: 'not_connected' | 'missing_binding' | 'adapter_unavailable',
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx
      .update(surfaceDeliveries)
      .set({
        state: 'blocked',
        operation: 'composite',
        reasonCode,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(surfaceDeliveries.surface, surface),
          eq(surfaceDeliveries.bindingId, bindingId),
          eq(surfaceDeliveries.messageId, messageId),
          eq(surfaceDeliveries.state, 'queued'),
        ),
      ),
  );
}

/**
 * Lists surface deliveries for messages.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param messageIds - Identifiers considered by the operation.
 * @param incidentId - Incident targeted by the operation.
 */
export async function listSurfaceDeliveriesForMessages(
  db: Db,
  tenantId: string,
  messageIds: string[],
  incidentId?: string,
): Promise<SurfaceDeliveryReceipt[]> {
  if (messageIds.length === 0) return [];
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        messageId: surfaceDeliveries.messageId,
        bindingId: surfaceDeliveries.bindingId,
        surface: surfaceDeliveries.surface,
        state: surfaceDeliveries.state,
        operation: surfaceDeliveries.operation,
        remoteMessageId: surfaceDeliveries.remoteMessageId,
        reasonCode: surfaceDeliveries.reasonCode,
        attemptedAt: surfaceDeliveries.attemptedAt,
        completedAt: surfaceDeliveries.completedAt,
      })
      .from(surfaceDeliveries)
      .where(
        and(
          inArray(surfaceDeliveries.messageId, messageIds),
          incidentId ? eq(surfaceDeliveries.incidentId, incidentId) : undefined,
        ),
      ),
  ) as Promise<SurfaceDeliveryReceipt[]>;
}

/**
 * Checks whether ambiguous lifecycle post creation.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 * @param currentMessageId - Current surface message excluded from ambiguity checks.
 */
export async function hasAmbiguousLifecyclePostCreation(
  db: Db,
  tenantId: string,
  surface: string,
  bindingId: string,
  currentMessageId: string,
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: surfaceDeliveries.id })
      .from(surfaceDeliveries)
      .innerJoin(incidentMessages, eq(incidentMessages.id, surfaceDeliveries.messageId))
      .where(
        and(
          eq(surfaceDeliveries.surface, surface),
          eq(surfaceDeliveries.bindingId, bindingId),
          ne(surfaceDeliveries.messageId, currentMessageId),
          inArray(surfaceDeliveries.state, ['sending', 'uncertain']),
          eq(incidentMessages.kind, 'lifecycle'),
        ),
      )
      .limit(1);
    return rows.length === 1;
  });
}

export * from './surface-delivery-repo/system';
