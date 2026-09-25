import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../rls';
import { incidentSignals } from '../schema';

type IncidentSignal = typeof incidentSignals.$inferSelect;

export type SignalEpisodeBinding =
  | { status: 'bound'; signal: IncidentSignal }
  /** Another signal already owns this provider episode; nothing was written. */
  | { status: 'conflict'; signalId: string; incidentId: string };

/**
 * Attaches one verified provider episode to an existing signal, leaving its history untouched.
 *
 * @remarks The caller holds the connector generation, response-group work, incident and signal
 * locks, and has checked the signal version, all in this transaction. The episode is checked
 * against `incident_signals_provider_episode_uq` first so a conflict is a result, not an aborted
 * transaction. A concurrent writer can still win between check and update; its unique violation
 * then aborts this transaction and the caller retries later.
 * @param tx - Tenant-scoped transaction holding the locks above.
 * @param input - Signal to bind, the owning connector, and the verified provider episode.
 */
export async function bindSignalToEpisodeTx(
  tx: Tx,
  input: {
    signalId: string;
    dataSourceId: string;
    episode: {
      provider: string;
      fingerprint: string;
      startsAt: Date;
      labels: Record<string, string>;
    };
  },
): Promise<SignalEpisodeBinding> {
  const { signalId, dataSourceId, episode } = input;
  const [owner] = await tx
    .select({ id: incidentSignals.id, incidentId: incidentSignals.incidentId })
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.dataSourceId, dataSourceId),
        eq(incidentSignals.providerFingerprint, episode.fingerprint),
        eq(incidentSignals.startsAt, episode.startsAt),
      ),
    );
  if (owner && owner.id !== signalId)
    return { status: 'conflict', signalId: owner.id, incidentId: owner.incidentId };
  const [signal] = await tx
    .update(incidentSignals)
    .set({
      dataSourceId,
      // Any earlier clear belonged to another generation or no episode at all.
      providerClearGeneration: null,
      provider: episode.provider,
      providerFingerprint: episode.fingerprint,
      startsAt: episode.startsAt,
      labels: episode.labels,
      version: sql`${incidentSignals.version} + 1`,
    })
    .where(eq(incidentSignals.id, signalId))
    .returning();
  if (!signal) throw new Error('bound signal disappeared under its row lock');
  return { status: 'bound', signal };
}
