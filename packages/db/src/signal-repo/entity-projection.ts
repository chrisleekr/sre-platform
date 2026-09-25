import { eq } from 'drizzle-orm';
import type { Tx } from '../rls';
import { incidentSignals } from '../schema';
import type { SignalObservation } from './recovery';
export async function hydrateEntityProjection(
  tx: Tx,
  current: typeof incidentSignals.$inferSelect,
  input: SignalObservation,
): Promise<typeof incidentSignals.$inferSelect> {
  const currentSource = current.signalSource;
  // Rejected or duplicate observations can enrich entities, never certify lifecycle evidence.
  const incomingSource = input.signalSource
    ? {
        ...input.signalSource,
        lifecycleVersion: currentSource?.lifecycleVersion,
        lifecycleState: currentSource?.lifecycleState,
        observedAt:
          input.signalSource.lifecycleVersion === undefined
            ? input.signalSource.observedAt
            : (currentSource?.observedAt ?? input.signalSource.observedAt),
      }
    : undefined;
  const sameSource =
    currentSource &&
    incomingSource &&
    currentSource.kind === incomingSource.kind &&
    currentSource.provider === incomingSource.provider &&
    currentSource.dataSourceId === incomingSource.dataSourceId &&
    currentSource.externalId === incomingSource.externalId;
  const signalSource =
    currentSource?.lifecycleVersion !== undefined
      ? currentSource
      : !currentSource ||
          (incomingSource?.kind === 'monitor' &&
            incomingSource.dataSourceId === input.dataSourceId &&
            Boolean(input.providerFingerprint && input.startsAt)) ||
          (sameSource &&
            Date.parse(incomingSource.observedAt) > Date.parse(currentSource.observedAt))
        ? (incomingSource ?? null)
        : currentSource;

  const affectedEntities = current.affectedEntities
    ? [...current.affectedEntities]
    : input.affectedEntities
      ? []
      : null;
  if (affectedEntities && input.affectedEntities) {
    const indexByKey = new Map(affectedEntities.map((candidate, index) => [candidate.key, index]));
    for (const incoming of input.affectedEntities) {
      const index = indexByKey.get(incoming.key);
      if (index === undefined) {
        indexByKey.set(incoming.key, affectedEntities.length);
        affectedEntities.push(incoming);
        continue;
      }
      if (Date.parse(incoming.observedAt) > Date.parse(affectedEntities[index]!.observedAt))
        affectedEntities[index] = incoming;
    }
  }
  if (
    JSON.stringify(signalSource) === JSON.stringify(current.signalSource) &&
    JSON.stringify(affectedEntities) === JSON.stringify(current.affectedEntities)
  )
    return current;
  const rows = await tx
    .update(incidentSignals)
    .set({ signalSource, affectedEntities })
    .where(eq(incidentSignals.id, current.id))
    .returning();
  return rows[0]!;
}
