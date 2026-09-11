import { eq } from 'drizzle-orm';
import type { Tx } from '../rls';
import { incidentSignals } from '../schema';
import type { SignalObservation } from './recovery';

/** Returns a provider's exact order value, with a microsecond timestamp fallback. */
export function observationEventVersion(input: { eventAt: Date; eventVersion?: string }): number {
  let version: bigint;
  if (input.eventVersion) {
    try {
      version = BigInt(input.eventVersion);
    } catch {
      throw new Error('signal observation event version is invalid');
    }
  } else {
    version = BigInt(input.eventAt.getTime()) * 1000n + 999n;
  }
  if (version < 0n || version > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('signal observation event version is outside the supported range');
  return Number(version);
}

/** Returns the latest ordered provider or manual-resolution projection on a signal. */
export function storedObservationVersion(signal: typeof incidentSignals.$inferSelect): bigint {
  const timestampVersion = BigInt(signal.lastEventAt.getTime()) * 1000n;
  const exactVersion =
    signal.lastEventVersion === null ? timestampVersion + 999n : BigInt(signal.lastEventVersion);
  const eventVersion = exactVersion > timestampVersion ? exactVersion : timestampVersion;
  const resolvedVersion = signal.resolvedAt
    ? BigInt(signal.resolvedAt.getTime()) * 1000n
    : eventVersion;
  return resolvedVersion > eventVersion ? resolvedVersion : eventVersion;
}

/** Advances freshness and exact ordering without creating investigation material. */
export async function advanceObservationCursor(
  tx: Tx,
  signal: typeof incidentSignals.$inferSelect,
  input: SignalObservation,
): Promise<typeof incidentSignals.$inferSelect> {
  const nextVersion = observationEventVersion(input);
  if (BigInt(nextVersion) <= storedObservationVersion(signal)) return signal;
  const rows = await tx
    .update(incidentSignals)
    .set({
      lastSeenAt:
        input.eventAt.getTime() > signal.lastSeenAt.getTime() ? input.eventAt : signal.lastSeenAt,
      lastEventVersion: nextVersion,
    })
    .where(eq(incidentSignals.id, signal.id))
    .returning();
  return rows[0]!;
}
