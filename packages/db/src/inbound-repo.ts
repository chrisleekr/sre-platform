import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { inboundChannels } from './schema';
import type { Surface } from './surface-repo';

// Per-channel inbound subscription allowlist. A surface ingests a message only from a channel
// that is subscribed AND enabled. All reads/writes go through withTenant (RLS).

export interface SubscribeChannel {
  tenantId: string;
  surface: Surface;
  /** The channel ID (a Slack C07…). What inbound events carry, so what we must match on. */
  channel: string;
  /** The display name for the dashboard, e.g. "#homelab-notification". Omitted → the stored name is kept. */
  channelName?: string | null;
  enabled?: boolean;
}

/**
 * Provides subscribe channel.
 *
 * @param db - Database connection used for the operation.
 * @param input - Validated input for the operation.
 */
export async function subscribeChannel(db: Db, input: SubscribeChannel) {
  const { tenantId, surface, channel, channelName, enabled = true } = input;
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(inboundChannels)
      .values({ tenantId, surface, channel, channelName: channelName ?? null, enabled })
      .onConflictDoUpdate({
        target: [inboundChannels.tenantId, inboundChannels.surface, inboundChannels.channel],
        // Spread the name only when supplied, so an omitted name never wipes one we already have.
        set: {
          enabled,
          ...(channelName == null ? {} : { channelName }),
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return rows[0]!;
  });
}

/**
 * True only if a row exists for (tenant, surface, channel) AND it is enabled.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param channel - Surface channel targeted by the operation.
 */
export async function isChannelSubscribed(
  db: Db,
  tenantId: string,
  surface: Surface,
  channel: string,
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ enabled: inboundChannels.enabled })
      .from(inboundChannels)
      .where(and(eq(inboundChannels.surface, surface), eq(inboundChannels.channel, channel)))
      .limit(1);
    return rows[0]?.enabled === true;
  });
}

/**
 * Disables inbound channels.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 */
export async function disableInboundChannels(
  db: Db,
  tenantId: string,
  surface: Surface,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx
      .update(inboundChannels)
      .set({ enabled: false, updatedAt: sql`now()` })
      .where(eq(inboundChannels.surface, surface)),
  );
}

/**
 * All subscription rows for a tenant+surface (enabled and disabled).
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 */
export async function listSubscribedChannels(db: Db, tenantId: string, surface: Surface) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(inboundChannels)
      .where(eq(inboundChannels.surface, surface))
      .orderBy(inboundChannels.channel),
  );
}
