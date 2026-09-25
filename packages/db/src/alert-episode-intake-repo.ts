import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Executor, type Tx } from './rls';
import {
  alertEpisodeIntakes,
  type AlertIntakeState,
  type StoredAlertmanagerObservation,
} from './schema';

export interface AlertEpisodeIntakeInput {
  dataSourceId: string;
  providerFingerprint: string;
  startsAt: Date | null;
  opaqueEpisodeKey?: string;
  materialHash: string;
  observation: StoredAlertmanagerObservation;
  channel: string;
  observedAt: Date;
}

/**
 * Persist the latest provider observation without changing the root-delivery state.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function upsertAlertEpisodeIntake(
  exec: Executor,
  tenantId: string,
  input: AlertEpisodeIntakeInput,
) {
  return withTenant(exec, tenantId, async (tx) => {
    const rows = await tx
      .insert(alertEpisodeIntakes)
      .values({
        tenantId,
        ...input,
        firstSeenAt: input.observedAt,
        lastSeenAt: input.observedAt,
      })
      .onConflictDoUpdate({
        target: input.opaqueEpisodeKey
          ? [
              alertEpisodeIntakes.tenantId,
              alertEpisodeIntakes.dataSourceId,
              alertEpisodeIntakes.opaqueEpisodeKey,
            ]
          : [
              alertEpisodeIntakes.tenantId,
              alertEpisodeIntakes.dataSourceId,
              alertEpisodeIntakes.providerFingerprint,
              alertEpisodeIntakes.startsAt,
            ],
        set: {
          startsAt: sql`coalesce(${alertEpisodeIntakes.startsAt}, excluded.starts_at)`,
          channel: sql`case
            when ${alertEpisodeIntakes.state} in ('pending', 'rejected')
            then excluded.channel
            else ${alertEpisodeIntakes.channel}
          end`,
          materialHash: sql`case
            when ${alertEpisodeIntakes.observation}->>'status' = 'resolved'
             and excluded.observation->>'status' = 'firing'
            then ${alertEpisodeIntakes.materialHash}
            else excluded.material_hash
          end`,
          observation: sql`case
            when ${alertEpisodeIntakes.observation}->>'status' = 'resolved'
             and excluded.observation->>'status' = 'firing'
            then ${alertEpisodeIntakes.observation}
            else excluded.observation
          end`,
          lastSeenAt: input.observedAt,
        },
      })
      .returning();
    const retained = rows[0]!;
    const conflict = Boolean(
      retained.startsAt &&
      retained.observation.status === 'resolved' &&
      retained.observation.endsAt &&
      new Date(retained.observation.endsAt) < retained.startsAt,
    );
    if (conflict || retained.failureCategory === 'conflicting_episode_times') {
      const [updated] = await tx
        .update(alertEpisodeIntakes)
        .set({ failureCategory: conflict ? 'conflicting_episode_times' : null })
        .where(eq(alertEpisodeIntakes.id, retained.id))
        .returning();
      return updated!;
    }
    return retained;
  });
}

/**
 * A process disappeared while owning the Slack create fence. The remote outcome is unknowable.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param intakeId - intake id targeted by the operation.
 * @param staleBefore - Timestamp before which an intake is considered stale.
 */
export async function markStaleAlertEpisodeRootUncertain(
  exec: Executor,
  tenantId: string,
  intakeId: string,
  staleBefore: Date,
): Promise<boolean> {
  return withTenant(exec, tenantId, async (tx) => {
    const rows = await tx
      .update(alertEpisodeIntakes)
      .set({
        state: 'uncertain',
        failureCategory: 'process_interrupted',
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(alertEpisodeIntakes.id, intakeId),
          eq(alertEpisodeIntakes.state, 'posting'),
          lte(alertEpisodeIntakes.updatedAt, staleBefore),
        ),
      )
      .returning({ id: alertEpisodeIntakes.id });
    return rows.length === 1;
  });
}

/**
 * Claim a root post only when no prior external attempt can have succeeded.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param intakeId - intake id targeted by the operation.
 */
export async function claimAlertEpisodeRootPost(
  exec: Executor,
  tenantId: string,
  intakeId: string,
): Promise<boolean> {
  return withTenant(exec, tenantId, async (tx) => {
    const rows = await tx
      .update(alertEpisodeIntakes)
      .set({
        state: 'posting',
        attemptCount: sql`${alertEpisodeIntakes.attemptCount} + 1`,
        failureCategory: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(alertEpisodeIntakes.id, intakeId),
          inArray(alertEpisodeIntakes.state, ['pending', 'rejected']),
        ),
      )
      .returning({ id: alertEpisodeIntakes.id });
    return rows.length === 1;
  });
}

/**
 * Records alert episode root post.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param intakeId - intake id targeted by the operation.
 * @param rootMessageId - root message id targeted by the operation.
 */
export async function recordAlertEpisodeRootPost(
  exec: Executor,
  tenantId: string,
  intakeId: string,
  rootMessageId: string,
): Promise<boolean> {
  return withTenant(exec, tenantId, async (tx) => {
    const rows = await tx
      .update(alertEpisodeIntakes)
      .set({ state: 'posted', rootMessageId, failureCategory: null, updatedAt: sql`now()` })
      .where(and(eq(alertEpisodeIntakes.id, intakeId), eq(alertEpisodeIntakes.state, 'posting')))
      .returning({ id: alertEpisodeIntakes.id });
    return rows.length === 1;
  });
}

/**
 * Records alert episode root failure.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param intakeId - intake id targeted by the operation.
 * @param state - Value supplied for state.
 * @param failureCategory - Value supplied for failure category.
 */
export async function recordAlertEpisodeRootFailure(
  exec: Executor,
  tenantId: string,
  intakeId: string,
  state: Extract<AlertIntakeState, 'rejected' | 'uncertain'>,
  failureCategory: string,
): Promise<void> {
  await withTenant(exec, tenantId, (tx) =>
    tx
      .update(alertEpisodeIntakes)
      .set({ state, failureCategory, updatedAt: sql`now()` })
      .where(and(eq(alertEpisodeIntakes.id, intakeId), eq(alertEpisodeIntakes.state, 'posting'))),
  );
}

/**
 * Provides accept alert episode intake.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param intakeId - intake id targeted by the operation.
 * @param incidentId - Incident targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 */
export async function acceptAlertEpisodeIntake(
  exec: Executor,
  tenantId: string,
  intakeId: string,
  incidentId: string,
  bindingId: string,
): Promise<boolean> {
  return withTenant(exec, tenantId, (tx) =>
    acceptAlertEpisodeIntakeTx(tx, intakeId, incidentId, bindingId),
  );
}

/**
 * Provides accept alert episode intake tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param intakeId - intake id targeted by the operation.
 * @param incidentId - Incident targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 */
export async function acceptAlertEpisodeIntakeTx(
  tx: Tx,
  intakeId: string,
  incidentId: string,
  bindingId: string,
): Promise<boolean> {
  const rows = await tx
    .update(alertEpisodeIntakes)
    .set({
      state: 'accepted',
      incidentId,
      bindingId,
      failureCategory: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(alertEpisodeIntakes.id, intakeId),
        or(
          eq(alertEpisodeIntakes.state, 'posted'),
          and(
            eq(alertEpisodeIntakes.state, 'accepted'),
            eq(alertEpisodeIntakes.incidentId, incidentId),
            eq(alertEpisodeIntakes.bindingId, bindingId),
          ),
        ),
      ),
    )
    .returning({ id: alertEpisodeIntakes.id });
  return rows.length === 1;
}

/**
 * Returns alert episode intake.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param intakeId - intake id targeted by the operation.
 */
export async function getAlertEpisodeIntake(db: Db, tenantId: string, intakeId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(alertEpisodeIntakes)
      .where(eq(alertEpisodeIntakes.id, intakeId))
      .limit(1);
    return rows[0];
  });
}
