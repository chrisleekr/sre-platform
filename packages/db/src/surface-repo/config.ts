import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant } from '../rls';
import { surfaceConfigs, surfaceDeliveries } from '../schema';

// Surface config / binding / approval repo. All reads/writes go through withTenant (RLS).
// Bot tokens are NOT here — they live in tenant_secrets via the SecretStore.

export type Surface = 'slack';

export const OUTBOUND_SURFACES = ['slack'] as const;
// every outbound Surface must be listed here. A new literal absent from the
// tuple breaks this typecheck AND the length test below, forcing review of the durable delivery state
// machine before a second outbound surface ships.
type _MissingOutbound = [Exclude<Surface, (typeof OUTBOUND_SURFACES)[number]>] extends [never]
  ? true
  : never;
const _assertOutboundExhaustive: _MissingOutbound = true;
void _assertOutboundExhaustive;

export interface NewSurfaceConfig {
  surface: Surface;
  /** The surface's own bot user id; null until a successful auth.test resolves it. */
  botUserId?: string | null;
  /** Slack bot id verified alongside the bot user and app identities. */
  botId?: string | null;
  /** Verified Slack workspace id used for global Socket Mode callback routing. */
  teamId?: string | null;
  /** Verified Slack app id shared by the bot token, app token, and Socket envelope. */
  appId?: string | null;
}

/**
 * Creates or updates surface config.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function upsertSurfaceConfig(db: Db, tenantId: string, input: NewSurfaceConfig) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(surfaceConfigs)
      .values({
        tenantId,
        surface: input.surface,
        botUserId: input.botUserId ?? null,
        botId: input.botId ?? null,
        teamId: input.teamId ?? null,
        appId: input.appId ?? null,
      })
      .onConflictDoUpdate({
        target: [surfaceConfigs.tenantId, surfaceConfigs.surface],
        set: {
          botUserId: input.botUserId ?? null,
          ...(input.botId !== undefined ? { botId: input.botId } : {}),
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          ...(input.appId !== undefined ? { appId: input.appId } : {}),
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return rows[0]!;
  });
}

/**
 * System-scoped Socket Mode routing lookup. Call only with the admin connection.
 *
 * @param db - Database connection used for the operation.
 * @param teamId - team id targeted by the operation.
 * @param appId - app id targeted by the operation.
 */
export async function getSurfaceConfigByTeamAndAppId(db: Db, teamId: string, appId: string) {
  const rows = await db
    .select()
    .from(surfaceConfigs)
    .where(and(eq(surfaceConfigs.teamId, teamId), eq(surfaceConfigs.appId, appId)))
    .limit(1);
  return rows[0];
}

export interface VerifiedSlackSurfaceIdentity {
  botUserId: string;
  botId: string;
  teamId: string;
  appId: string;
}

/**
 * Atomically complete a legacy Slack identity only while at least one identity field remains null.
 *
 * @param db - Database connection used for the operation.
 * @param configId - config id targeted by the operation.
 * @param identity - Validated identity used by the operation.
 */
export async function backfillSlackSurfaceIdentitySystem(
  db: Db,
  configId: string,
  identity: VerifiedSlackSurfaceIdentity,
): Promise<boolean> {
  const rows = await db
    .update(surfaceConfigs)
    .set({ ...identity, updatedAt: sql`now()` })
    .where(
      and(
        eq(surfaceConfigs.id, configId),
        or(
          isNull(surfaceConfigs.botUserId),
          isNull(surfaceConfigs.botId),
          isNull(surfaceConfigs.teamId),
          isNull(surfaceConfigs.appId),
        ),
      ),
    )
    .returning({ id: surfaceConfigs.id });
  return rows.length === 1;
}

/**
 * System-scoped startup inventory. Call only with the admin connection.
 *
 * @param db - Database connection used for the operation.
 */
export async function listSlackSurfaceConfigsSystem(db: Db) {
  return db.select().from(surfaceConfigs).where(eq(surfaceConfigs.surface, 'slack'));
}

/**
 * The tenant's connected surfaces, also the fan-out set for the outbound poster (a row = connected).
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 */
export async function listSurfaceConfigs(db: Db, tenantId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx.select().from(surfaceConfigs).orderBy(surfaceConfigs.surface),
  );
}

/**
 * Returns surface config.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 */
export async function getSurfaceConfig(db: Db, tenantId: string, surface: Surface) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(surfaceConfigs)
      .where(eq(surfaceConfigs.surface, surface))
      .limit(1);
    return rows[0];
  });
}

/**
 * Deletes surface config.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 */
export async function deleteSurfaceConfig(
  db: Db,
  tenantId: string,
  surface: Surface,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx.delete(surfaceConfigs).where(eq(surfaceConfigs.surface, surface)),
  );
}

/**
 * Disconnect a surface and terminalize its queued outbox rows in the same tenant transaction.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 */
export async function disconnectSurfaceConfig(
  db: Db,
  tenantId: string,
  surface: Surface,
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .update(surfaceDeliveries)
      .set({
        state: 'blocked',
        operation: 'composite',
        reasonCode: 'not_connected',
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(surfaceDeliveries.surface, surface), eq(surfaceDeliveries.state, 'queued')));
    await tx
      .update(surfaceDeliveries)
      .set({
        state: 'uncertain',
        operation: 'composite',
        reasonCode: 'disconnected_in_flight',
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(surfaceDeliveries.surface, surface), eq(surfaceDeliveries.state, 'sending')));
    await tx.delete(surfaceConfigs).where(eq(surfaceConfigs.surface, surface));
  });
}
