import { eq } from 'drizzle-orm';
import type { Tx } from '../rls';
import { incidentSignals } from '../schema';
import type { SignalObservation } from './recovery';

/**
 * Moves a still-firing monitor source to the newer connector generation that observed it. Only the
 * fresh in-order freshness branch calls this, so stale or rejected observations never certify a source.
 */
export async function recertifyFiringSource(
  tx: Tx,
  signal: typeof incidentSignals.$inferSelect,
  input: SignalObservation,
): Promise<typeof incidentSignals.$inferSelect> {
  const source = input.signalSource;
  if (
    input.state !== 'firing' ||
    source?.kind !== 'monitor' ||
    !input.dataSourceId ||
    source.dataSourceId !== input.dataSourceId ||
    signal.dataSourceId !== input.dataSourceId ||
    !Number.isInteger(source.lifecycleVersion) ||
    (signal.signalSource?.lifecycleVersion ?? -1) >= source.lifecycleVersion!
  )
    return signal;
  const rows = await tx
    .update(incidentSignals)
    .set({ signalSource: source })
    .where(eq(incidentSignals.id, signal.id))
    .returning();
  return rows[0]!;
}
