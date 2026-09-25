import { hydrateEntityProjection } from './entity-projection';
import { and, eq, sql } from 'drizzle-orm';
import { lockResponseGroupWorkTx } from '../incident-relation-repo/causal';
import { signalInvestigationTriggerReason } from '../investigation-trigger';
import { type Tx } from '../rls';
import { incidentSignals, incidents, type SignalEventType, type SignalState } from '../schema';
import {
  advanceObservationCursor,
  observationEventVersion,
  storedObservationVersion,
} from './event-order';
import {
  incidentSignalFenceTx,
  type SignalApplyResult,
  type SignalCorrectionResult,
  type SignalObservation,
} from './recovery';
import { clearRecoveryTx } from './recovery-state';
import { recertifyFiringSource } from './firing-source';
function clearGeneration(input: SignalObservation): number | null {
  return input.state === 'resolved' &&
    input.clearProvenance === 'provider' &&
    input.dataSourceId &&
    input.providerFingerprint &&
    input.startsAt &&
    input.signalSource?.kind === 'monitor' &&
    input.signalSource.dataSourceId === input.dataSourceId &&
    Number.isInteger(input.signalSource.lifecycleVersion)
    ? input.signalSource.lifecycleVersion!
    : null;
}
async function incidentAllSignalsResolved(tx: Tx, incidentId: string): Promise<boolean> {
  const rows = await tx
    .select({
      total: sql<number>`count(*)::int`,
      unresolved: sql<number>`count(*) filter (where ${incidentSignals.state} <> 'resolved')::int`,
    })
    .from(incidentSignals)
    .where(eq(incidentSignals.incidentId, incidentId));
  return (rows[0]?.total ?? 0) > 0 && (rows[0]?.unresolved ?? 0) === 0;
}
/** Correct a mistaken current-state projection without rewriting the provider observation itself. */
async function lockSignalCorrectionTarget(
  tx: Tx,
  incidentId: string,
  signalId: string,
): Promise<
  | {
      incident: Pick<typeof incidents.$inferSelect, 'status' | 'lifecycleVersion'>;
      signal: typeof incidentSignals.$inferSelect;
    }
  | { outcome: 'not_found' | 'archived' }
> {
  // Keep the same incident -> signal lock order used by provider observations and lifecycle work.
  const incidentRows = await tx
    .select({
      status: incidents.status,
      lifecycleVersion: incidents.lifecycleVersion,
      archivedAt: incidents.archivedAt,
    })
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1)
    .for('update');
  const incident = incidentRows[0];
  if (!incident) return { outcome: 'not_found' };
  if (incident.archivedAt) return { outcome: 'archived' };

  const signalRows = await tx
    .select()
    .from(incidentSignals)
    .where(and(eq(incidentSignals.id, signalId), eq(incidentSignals.incidentId, incidentId)))
    .limit(1)
    .for('update');
  const current = signalRows[0];
  if (!current) return { outcome: 'not_found' };
  return { incident, signal: current };
}

/**
 * Correct a mistaken current-state projection without rewriting the provider observation itself.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param incidentId - Incident targeted by the operation.
 * @param signalId - Incident signal targeted by the operation.
 * @param input - Validated input for the operation.
 */
export async function correctIncidentSignalTx(
  tx: Tx,
  incidentId: string,
  signalId: string,
  input: { expectedVersion: number; resolvedAt: Date },
): Promise<SignalCorrectionResult> {
  const target = await lockSignalCorrectionTarget(tx, incidentId, signalId);
  if ('outcome' in target) return target;
  const { incident, signal: current } = target;
  if (current.version !== input.expectedVersion) return { outcome: 'stale' };
  if (input.resolvedAt.getTime() < current.lastSeenAt.getTime()) return { outcome: 'invalid' };

  const signal =
    current.state === 'resolved' && current.clearProvenance === 'operator'
      ? current
      : (
          await tx
            .update(incidentSignals)
            .set({
              state: 'resolved',
              clearProvenance: 'operator',
              providerClearGeneration: null,
              lastEventType: 'resolved',
              resolvedAt: input.resolvedAt,
              version: sql`${incidentSignals.version} + 1`,
            })
            .where(eq(incidentSignals.id, current.id))
            .returning()
        )[0]!;
  const allResolved = await incidentAllSignalsResolved(tx, incidentId);
  return {
    outcome:
      current.state === 'resolved' && current.clearProvenance === 'operator' ? 'noop' : 'applied',
    signal,
    incidentStatus: incident.status,
    lifecycleVersion: incident.lifecycleVersion,
    allResolved,
    signalFence: await incidentSignalFenceTx(tx, incidentId),
  };
}

/**
 * Replay an existing correction without granting the old request authority over newer signal state.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param incidentId - Incident targeted by the operation.
 * @param signalId - Incident signal targeted by the operation.
 */
export async function replayIncidentSignalCorrectionTx(
  tx: Tx,
  incidentId: string,
  signalId: string,
): Promise<SignalCorrectionResult> {
  const target = await lockSignalCorrectionTarget(tx, incidentId, signalId);
  if ('outcome' in target) return target;
  const { incident, signal } = target;
  if (signal.state !== 'resolved') return { outcome: 'stale' };
  return {
    outcome: 'noop',
    signal,
    incidentStatus: incident.status,
    lifecycleVersion: incident.lifecycleVersion,
    allResolved: await incidentAllSignalsResolved(tx, incidentId),
    signalFence: await incidentSignalFenceTx(tx, incidentId),
  };
}

/**
 * Apply one monotonic alert observation inside an existing tenant transaction.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function applySignalObservationTx(
  tx: Tx,
  tenantId: string,
  input: SignalObservation,
): Promise<SignalApplyResult> {
  const identity = await tx
    .select()
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.surface, input.surface),
        eq(incidentSignals.channel, input.channel),
        eq(incidentSignals.externalMessageId, input.externalMessageId),
      ),
    )
    .limit(1);

  // Lifecycle transitions lock the incident first and then inspect its signals. Signal writers take the
  // same lock order so a recovery decision and a refire have one factual commit order, never a deadlock.
  const incidentId = identity[0]?.incidentId ?? input.incidentId;
  const { rootIncidentId: rootId, incidentIds } = await lockResponseGroupWorkTx(
    tx,
    tenantId,
    incidentId,
  );
  const lockedIncident = await tx
    .select({ id: incidents.id })
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1)
    .for('update');
  if (!lockedIncident[0]) throw new Error('signal incident not found');

  let current: typeof incidentSignals.$inferSelect | undefined;

  // Stable monitor identity deduplicates transport messages within a continuing episode.
  if (
    !input.providerFingerprint &&
    input.state === 'firing' &&
    input.monitorKey &&
    input.materialHash
  ) {
    const semanticMatches = await tx
      .select()
      .from(incidentSignals)
      .where(
        and(
          eq(incidentSignals.incidentId, input.incidentId),
          eq(incidentSignals.state, 'firing'),
          eq(incidentSignals.monitorKey, input.monitorKey),
        ),
      )
      .limit(2)
      .for('update');
    if (semanticMatches.length === 1) {
      current = semanticMatches[0]!;
      if (current.materialHash === input.materialHash) {
        let signal = await advanceObservationCursor(tx, current, input);
        signal = await hydrateEntityProjection(tx, signal, input);
        return {
          signal,
          applied: false,
          eventType: 'updated',
          previousState: 'firing',
          allResolved: false,
          investigationTriggerReason: 'unchanged_renotification',
        };
      }
    }
  }

  if (!current) {
    const existing = await tx
      .select()
      .from(incidentSignals)
      .where(
        and(
          eq(incidentSignals.surface, input.surface),
          eq(incidentSignals.channel, input.channel),
          eq(incidentSignals.externalMessageId, input.externalMessageId),
        ),
      )
      .limit(1)
      .for('update');
    current = existing[0];
  }
  if (!current && input.dataSourceId && input.providerFingerprint && input.startsAt) {
    const [bound] = await tx
      .select()
      .from(incidentSignals)
      .where(
        and(
          eq(incidentSignals.dataSourceId, input.dataSourceId),
          eq(incidentSignals.providerFingerprint, input.providerFingerprint),
          eq(incidentSignals.startsAt, input.startsAt),
        ),
      )
      .limit(1)
      .for('update');
    current = bound;
  }

  if (!current) {
    const eventType: SignalEventType = input.state === 'resolved' ? 'resolved' : 'opened';
    const inserted = await tx
      .insert(incidentSignals)
      .values({
        tenantId,
        incidentId: input.incidentId,
        dataSourceId: input.dataSourceId,
        provider: input.provider,
        providerFingerprint: input.providerFingerprint,
        providerGroupKey: input.providerGroupKey,
        monitorKey: input.monitorKey,
        alertName: input.alertName,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        labels: input.labels,
        annotations: input.annotations,
        generatorUrl: input.generatorUrl,
        signalSource: input.signalSource,
        affectedEntities: input.affectedEntities,
        materialHash: input.materialHash,
        surface: input.surface,
        channel: input.channel,
        externalMessageId: input.externalMessageId,
        providerClearGeneration: clearGeneration(input),
        clearProvenance: input.state === 'resolved' ? (input.clearProvenance ?? 'unknown') : null,
        state: input.state,
        lastEventType: eventType,
        summary: input.summary,
        contentHash: input.contentHash,
        lastEventKey: input.eventKey,
        lastEventAt: input.eventAt,
        lastEventVersion: observationEventVersion(input),
        firstSeenAt: input.eventAt,
        lastSeenAt: input.eventAt,
        resolvedAt: input.state === 'resolved' ? input.eventAt : null,
      })
      // Provider episodes also have a native partial unique. Targetless conflict handling covers both
      // identities; the deterministic external id below lets the raced re-read resolve either winner.
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) {
      if (input.state !== 'resolved') await clearRecoveryTx(tx, tenantId, rootId, incidentIds);
      return {
        signal: inserted[0],
        applied: true,
        eventType,
        previousState: null,
        allResolved: await incidentAllSignalsResolved(tx, input.incidentId),
        investigationTriggerReason: signalInvestigationTriggerReason(eventType, true),
      };
    }

    // Another transaction created this identity after our first read. Lock its committed row and
    // continue through the normal stale/idempotency rules instead of leaking a unique violation.
    const raced = await tx
      .select()
      .from(incidentSignals)
      .where(
        and(
          eq(incidentSignals.surface, input.surface),
          eq(incidentSignals.channel, input.channel),
          eq(incidentSignals.externalMessageId, input.externalMessageId),
        ),
      )
      .limit(1)
      .for('update');
    current = raced[0];
    if (!current) throw new Error('signal identity conflict without a committed row');
  }

  if (input.advisory || current.incidentId !== input.incidentId) {
    return {
      signal: current,
      applied: false,
      eventType: current.lastEventType as SignalEventType,
      previousState: current.state as SignalState,
      allResolved: await incidentAllSignalsResolved(tx, current.incidentId),
      investigationTriggerReason: signalInvestigationTriggerReason(
        current.lastEventType as SignalEventType,
        false,
      ),
    };
  }

  // Native recurrences have a new startsAt; late firing replays cannot reopen this episode.
  if (current.providerFingerprint && current.state === 'resolved' && input.state === 'firing') {
    const signal = await hydrateEntityProjection(tx, current, input);
    return {
      signal,
      applied: false,
      eventType: current.lastEventType as SignalEventType,
      previousState: current.state as SignalState,
      allResolved: await incidentAllSignalsResolved(tx, input.incidentId),
      investigationTriggerReason: signalInvestigationTriggerReason(
        current.lastEventType as SignalEventType,
        false,
      ),
    };
  }

  const eventType: SignalEventType =
    current.state === 'resolved' && input.state === 'firing'
      ? 'refired'
      : input.state === 'resolved'
        ? 'resolved'
        : 'updated';

  const incomingEventVersion = observationEventVersion(input);
  const projectionEventFloor = storedObservationVersion(current);

  // Repeated unchanged material advances freshness without buying another investigation. A new connector
  // generation is not new material while firing; a clear under one must re-certify through the update.
  if (
    current.providerFingerprint &&
    current.state === input.state &&
    current.providerClearGeneration === clearGeneration(input) &&
    current.materialHash &&
    current.materialHash === input.materialHash &&
    (input.state !== 'resolved' ||
      current.signalSource?.lifecycleVersion === input.signalSource?.lifecycleVersion) &&
    current.clearProvenance ===
      (input.state === 'resolved' ? (input.clearProvenance ?? 'unknown') : null) &&
    incomingEventVersion > projectionEventFloor
  ) {
    let seen = await advanceObservationCursor(tx, current, input);
    seen = await recertifyFiringSource(tx, seen, input);
    seen = await hydrateEntityProjection(tx, seen, input);
    return {
      signal: seen,
      applied: false,
      eventType,
      previousState: current.state as SignalState,
      allResolved: await incidentAllSignalsResolved(tx, input.incidentId),
      investigationTriggerReason: signalInvestigationTriggerReason(eventType, false),
    };
  }

  // Replays and stale edits cannot advance the projection.
  if (
    (current.lastEventKey === input.eventKey &&
      current.providerClearGeneration === clearGeneration(input)) ||
    incomingEventVersion <= projectionEventFloor
  ) {
    const signal = await hydrateEntityProjection(tx, current, input);
    return {
      signal,
      applied: false,
      eventType,
      previousState: current.state as SignalState,
      allResolved: await incidentAllSignalsResolved(tx, input.incidentId),
      investigationTriggerReason: signalInvestigationTriggerReason(eventType, false),
    };
  }

  if (
    current.state === input.state &&
    current.providerClearGeneration === clearGeneration(input) &&
    current.contentHash === input.contentHash &&
    current.clearProvenance ===
      (input.state === 'resolved' ? (input.clearProvenance ?? 'unknown') : null)
  ) {
    let signal = await advanceObservationCursor(tx, current, input);
    signal = await hydrateEntityProjection(tx, signal, input);
    return {
      signal,
      applied: false,
      eventType,
      previousState: current.state as SignalState,
      allResolved: await incidentAllSignalsResolved(tx, input.incidentId),
      investigationTriggerReason: signalInvestigationTriggerReason(eventType, false),
    };
  }

  const updated = await tx
    .update(incidentSignals)
    .set({
      providerClearGeneration: clearGeneration(input),
      clearProvenance: input.state === 'resolved' ? (input.clearProvenance ?? 'unknown') : null,
      state: input.state,
      dataSourceId: input.dataSourceId ?? current.dataSourceId,
      provider: input.provider ?? current.provider,
      providerFingerprint: input.providerFingerprint ?? current.providerFingerprint,
      providerGroupKey: input.providerGroupKey ?? current.providerGroupKey,
      monitorKey: input.monitorKey ?? current.monitorKey,
      alertName: input.alertName ?? current.alertName,
      startsAt: input.startsAt ?? current.startsAt,
      endsAt: input.endsAt === undefined ? current.endsAt : input.endsAt,
      labels: input.labels ?? current.labels,
      annotations: input.annotations ?? current.annotations,
      generatorUrl: input.generatorUrl ?? current.generatorUrl,
      signalSource: input.signalSource ?? current.signalSource,
      affectedEntities: input.affectedEntities ?? current.affectedEntities,
      materialHash: input.materialHash ?? current.materialHash,
      lastEventType: eventType,
      summary: input.summary,
      contentHash: input.contentHash,
      lastEventKey: input.eventKey,
      lastEventAt: input.eventAt,
      lastEventVersion: incomingEventVersion,
      lastSeenAt: input.eventAt,
      resolvedAt:
        input.state === 'resolved'
          ? input.eventAt
          : current.state === 'resolved'
            ? null
            : current.resolvedAt,
      version: sql`${incidentSignals.version} + 1`,
    })
    .where(eq(incidentSignals.id, current.id))
    .returning();
  const signal = updated[0]!;
  if (input.state !== 'resolved') await clearRecoveryTx(tx, tenantId, rootId, incidentIds);
  return {
    signal,
    applied: true,
    eventType,
    previousState: current.state as SignalState,
    allResolved: await incidentAllSignalsResolved(tx, input.incidentId),
    investigationTriggerReason: signalInvestigationTriggerReason(eventType, true),
  };
}
