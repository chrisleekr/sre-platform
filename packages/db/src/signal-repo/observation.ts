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

async function hydrateEntityProjection(
  tx: Tx,
  current: typeof incidentSignals.$inferSelect,
  input: SignalObservation,
): Promise<typeof incidentSignals.$inferSelect> {
  const currentSource = current.signalSource;
  const incomingSource = input.signalSource;
  const sameSource =
    currentSource &&
    incomingSource &&
    currentSource.kind === incomingSource.kind &&
    currentSource.provider === incomingSource.provider &&
    currentSource.dataSourceId === incomingSource.dataSourceId &&
    currentSource.externalId === incomingSource.externalId;
  const signalSource =
    !currentSource ||
    (sameSource && Date.parse(incomingSource.observedAt) > Date.parse(currentSource.observedAt))
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
    current.state === 'resolved'
      ? current
      : (
          await tx
            .update(incidentSignals)
            .set({
              state: 'resolved',
              lastEventType: 'resolved',
              resolvedAt: input.resolvedAt,
              version: sql`${incidentSignals.version} + 1`,
            })
            .where(eq(incidentSignals.id, current.id))
            .returning()
        )[0]!;
  const allResolved = await incidentAllSignalsResolved(tx, incidentId);
  return {
    outcome: current.state === 'resolved' ? 'noop' : 'applied',
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
  const { rootIncidentId } = await lockResponseGroupWorkTx(tx, tenantId, incidentId);
  const lockedIncident = await tx
    .select({ id: incidents.id })
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1)
    .for('update');
  if (!lockedIncident[0]) throw new Error('signal incident not found');

  let current: typeof incidentSignals.$inferSelect | undefined;

  // Sources without a native episode id can deliver one active provider notification under several
  // transport message ids. The monitor identifies the continuing episode; unchanged material only
  // advances last-seen, while changed material continues through the normal versioned update path.
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
      if (input.state !== 'resolved') await clearRecoveryTx(tx, tenantId, rootIncidentId);
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

  if (current.incidentId !== input.incidentId) {
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

  // A provider episode is immutable after it resolves. Alertmanager can replay an older firing
  // notification, but a genuine recurrence has a new startsAt and therefore a different signal row.
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

  // Alertmanager deliberately repeats an unchanged firing notification. Preserve its most recent
  // observation time for duration/freshness without advancing the version or buying another LLM turn.
  if (
    current.providerFingerprint &&
    current.state === input.state &&
    current.materialHash &&
    current.materialHash === input.materialHash &&
    incomingEventVersion > projectionEventFloor
  ) {
    let seen = await advanceObservationCursor(tx, current, input);
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

  // Slack can replay an event or deliver an older edit after a reconnect. Content-identical metadata edits
  // are also common. Neither may advance the durable signal nor trigger another investigation.
  if (current.lastEventKey === input.eventKey || incomingEventVersion <= projectionEventFloor) {
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

  if (current.state === input.state && current.contentHash === input.contentHash) {
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
  if (input.state !== 'resolved') await clearRecoveryTx(tx, tenantId, rootIncidentId);
  return {
    signal,
    applied: true,
    eventType,
    previousState: current.state as SignalState,
    allResolved: await incidentAllSignalsResolved(tx, input.incidentId),
    investigationTriggerReason: signalInvestigationTriggerReason(eventType, true),
  };
}

/**
 * Resolve one provider episode independently of its current incident assignment.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param dataSourceId - Data source targeted by the operation.
 * @param providerFingerprint - Provider-owned alert fingerprint.
 * @param startsAt - Provider episode start timestamp.
 */
