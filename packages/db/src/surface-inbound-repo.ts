import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Tx } from './rls';
import { jobs, surfaceInboundEvents, type SurfaceInboundState } from './schema';

const CLASSIFICATION_ENQUEUE_OUTCOMES = [
  'classify_enqueued',
  'mention_enqueued',
  'edit_enqueued',
] as const;

export interface SurfaceInboundMetadata {
  tenantId?: string;
  configId?: string;
  surface: string;
  deliveryKey: string;
  envelopeType: string;
  eventType?: string;
  eventSubtype?: string;
  channel?: string;
  externalMessageId?: string;
}

/**
 * Provides accept surface inbound event tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param input - Validated input for the operation.
 */
export async function acceptSurfaceInboundEventTx(
  tx: Tx,
  input: SurfaceInboundMetadata,
): Promise<{ row: typeof surfaceInboundEvents.$inferSelect; inserted: boolean }> {
  const inserted = await tx
    .insert(surfaceInboundEvents)
    .values({
      tenantId: input.tenantId,
      configId: input.configId,
      surface: input.surface,
      deliveryKey: input.deliveryKey,
      envelopeType: input.envelopeType,
      eventType: input.eventType,
      eventSubtype: input.eventSubtype,
      channel: input.channel,
      externalMessageId: input.externalMessageId,
      state: 'queued',
    })
    .onConflictDoNothing({
      target: [surfaceInboundEvents.surface, surfaceInboundEvents.deliveryKey],
    })
    .returning();
  if (inserted[0]) return { row: inserted[0], inserted: true };
  const existing = await tx
    .select()
    .from(surfaceInboundEvents)
    .where(
      and(
        eq(surfaceInboundEvents.surface, input.surface),
        eq(surfaceInboundEvents.deliveryKey, input.deliveryKey),
      ),
    )
    .limit(1);
  if (!existing[0]) throw new Error('surface inbound receipt lost after conflict');
  return { row: existing[0], inserted: false };
}

/**
 * Provides link surface inbound job tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param intakeId - intake id targeted by the operation.
 * @param jobId - job id targeted by the operation.
 */
export async function linkSurfaceInboundJobTx(
  tx: Tx,
  intakeId: string,
  jobId: string,
): Promise<void> {
  await tx
    .update(surfaceInboundEvents)
    .set({ jobId, updatedAt: sql`now()` })
    .where(eq(surfaceInboundEvents.id, intakeId));
}

/**
 * Records dropped surface inbound.
 *
 * @param db - Database connection used for the operation.
 * @param input - Validated input for the operation.
 */
export async function recordDroppedSurfaceInbound(
  db: Db,
  input: SurfaceInboundMetadata & { outcome: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const accepted = await acceptSurfaceInboundEventTx(tx, input);
    if (!accepted.inserted) return;
    await tx
      .update(surfaceInboundEvents)
      .set({
        state: 'dropped',
        outcome: input.outcome,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(surfaceInboundEvents.id, accepted.row.id));
  });
}

/**
 * Updates surface inbound state.
 *
 * @param db - Database connection used for the operation.
 * @param intakeId - intake id targeted by the operation.
 * @param input - Validated input for the operation.
 */
export async function updateSurfaceInboundState(
  db: Db,
  intakeId: string,
  input: {
    state: SurfaceInboundState;
    outcome?: string;
    attemptCount?: number;
    errorCode?: string;
    completed?: boolean;
  },
): Promise<void> {
  await db
    .update(surfaceInboundEvents)
    .set({
      state: input.state,
      outcome: input.outcome,
      attemptCount: input.attemptCount,
      errorCode: input.errorCode,
      completedAt: input.completed ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(eq(surfaceInboundEvents.id, intakeId));
}

/**
 * Record the latest classify decision separately from the completed Socket intake stage.
 * A replayed supersession cannot replace an outcome already committed by the same durable job.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param intakeId - intake id targeted by the operation.
 * @param outcome - Value supplied for outcome.
 * @param errorCode - Safe failure category for retry and fail-open outcomes.
 */
export async function recordSurfaceInboundClassificationOutcome(
  db: Db,
  tenantId: string,
  intakeId: string,
  outcome: string,
  errorCode?: string,
): Promise<void> {
  await db
    .update(surfaceInboundEvents)
    .set({
      classificationOutcome: outcome,
      classificationUpdatedAt: sql`now()`,
      errorCode: errorCode ?? null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(surfaceInboundEvents.id, intakeId),
        eq(surfaceInboundEvents.tenantId, tenantId),
        outcome === 'superseded' ? isNull(surfaceInboundEvents.classificationOutcome) : undefined,
      ),
    );
}

export interface SurfaceInboundHealth {
  latest: {
    state: SurfaceInboundState;
    outcome: string | null;
    classificationOutcome: string | null;
    classificationUpdatedAt: Date | null;
    terminalDisposition: string | null;
    terminalDispositionAt: Date | null;
    terminalDispositionEventAt: Date | null;
    acceptedAt: Date;
    completedAt: Date | null;
    jobStatus: string | null;
    attemptCount: number;
    errorCode: string | null;
  } | null;
  pendingCount: number;
  failedLast24Hours: number;
}

/**
 * Returns surface inbound health.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param configId - config id targeted by the operation.
 * @param now - Value supplied for now.
 */
export async function getSurfaceInboundHealth(
  db: Db,
  tenantId: string,
  surface: string,
  configId: string,
  now = new Date(),
): Promise<SurfaceInboundHealth> {
  const scope = and(
    eq(surfaceInboundEvents.tenantId, tenantId),
    eq(surfaceInboundEvents.surface, surface),
    eq(surfaceInboundEvents.configId, configId),
  );
  const latestRows = await db
    .select({
      state: surfaceInboundEvents.state,
      outcome: surfaceInboundEvents.outcome,
      classificationOutcome: surfaceInboundEvents.classificationOutcome,
      classificationUpdatedAt: surfaceInboundEvents.classificationUpdatedAt,
      terminalDisposition: surfaceInboundEvents.terminalDisposition,
      terminalDispositionAt: surfaceInboundEvents.terminalDispositionAt,
      terminalDispositionEventAt: surfaceInboundEvents.terminalDispositionEventAt,
      acceptedAt: surfaceInboundEvents.acceptedAt,
      completedAt: surfaceInboundEvents.completedAt,
      jobStatus: jobs.status,
      attemptCount: surfaceInboundEvents.attemptCount,
      errorCode: surfaceInboundEvents.errorCode,
    })
    .from(surfaceInboundEvents)
    .leftJoin(jobs, eq(jobs.id, surfaceInboundEvents.jobId))
    .where(scope)
    .orderBy(desc(surfaceInboundEvents.acceptedAt))
    .limit(1);
  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(surfaceInboundEvents)
    .leftJoin(jobs, eq(jobs.id, surfaceInboundEvents.jobId))
    .where(
      and(
        scope,
        isNull(surfaceInboundEvents.terminalDisposition),
        or(
          and(
            inArray(surfaceInboundEvents.state, ['queued', 'processing', 'retrying']),
            or(isNull(jobs.status), notInArray(jobs.status, ['done', 'dead'])),
          ),
          and(
            eq(surfaceInboundEvents.state, 'processed'),
            inArray(surfaceInboundEvents.outcome, CLASSIFICATION_ENQUEUE_OUTCOMES),
            or(
              isNull(surfaceInboundEvents.classificationOutcome),
              eq(surfaceInboundEvents.classificationOutcome, 'retry'),
            ),
          ),
        ),
      ),
    );
  const [failed] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(surfaceInboundEvents)
    .leftJoin(jobs, eq(jobs.id, surfaceInboundEvents.jobId))
    .where(
      and(
        scope,
        gte(surfaceInboundEvents.acceptedAt, new Date(now.getTime() - 86_400_000)),
        sql`(${surfaceInboundEvents.state} = 'retrying' or ${jobs.status} = 'dead')`,
      ),
    );
  return {
    latest: latestRows[0] ?? null,
    pendingCount: pending?.count ?? 0,
    failedLast24Hours: failed?.count ?? 0,
  };
}
