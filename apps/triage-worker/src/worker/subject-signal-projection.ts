import { platformSubjectSignalExternalId } from '@sre/alerts';
import type { InvestigationTriggerReason } from '@sre/contracts';
import {
  incidentSignalFenceTx,
  incidentSignals,
  type InvestigationSubjectState,
  type Tx,
} from '@sre/db';
import type { ConversationHub, HubMessage } from '@sre/hub';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SubjectSyncObservation } from '../subject-sync';

export const SUBJECT_SYNC_INTERVAL_MS = 5 * 60_000;

interface SubjectProjectionInput {
  subjectRowId: string;
  fingerprint: string;
  sourcePath: string;
  previousState: InvestigationSubjectState;
  previousHash: string;
  lastSyncedAt: Date;
  current: SubjectSyncObservation;
}

export interface SubjectProjectionResult {
  message: HubMessage | null;
  canonicalSignalId: string;
  canonicalSignalVersion: number;
  canonicalObservationApplied: boolean;
  allResolved: boolean;
  signalFence: string;
  repairedSignals: Array<{ id: string; version: number }>;
  repairedSignalCount: number;
  staleBeyondInterval: boolean;
  divergenceAgeMs: number;
  investigationTriggerReason: InvestigationTriggerReason;
}

/**
 * Reconciles the canonical subject signal and retires active legacy projections atomically.
 *
 * @param tx - Tenant-scoped transaction holding the incident and subject locks.
 * @param hub - Conversation hub used to apply the canonical observation.
 * @param tenantId - Tenant that owns the incident.
 * @param incidentId - Incident whose subject projection is reconciled.
 * @param input - Previous subject state and the latest normalized observation.
 */
export async function reconcileSubjectSignalProjectionTx(
  tx: Tx,
  hub: ConversationHub,
  tenantId: string,
  incidentId: string,
  input: SubjectProjectionInput,
): Promise<SubjectProjectionResult> {
  const canonicalExternalId = platformSubjectSignalExternalId(input.fingerprint, incidentId);
  const legacyExternalId = `${input.fingerprint}:${incidentId}`;
  const before = await tx
    .select()
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.incidentId, incidentId),
        eq(incidentSignals.provider, 'platform'),
        inArray(incidentSignals.externalMessageId, [canonicalExternalId, legacyExternalId]),
      ),
    )
    .for('update');
  const canonicalBefore = before.find((signal) => signal.externalMessageId === canonicalExternalId);
  const activeLegacy = before.filter(
    (signal) => signal.externalMessageId === legacyExternalId && signal.state !== 'resolved',
  );
  const projectionWasStale =
    !canonicalBefore ||
    canonicalBefore.state !== input.previousState ||
    canonicalBefore.contentHash !== input.previousHash ||
    activeLegacy.length > 0;
  const divergenceAgeMs = Math.max(
    0,
    input.current.observedAt.getTime() - input.lastSyncedAt.getTime(),
  );

  let message: HubMessage | null = null;
  let canonicalSignal = canonicalBefore;
  let canonicalObservationApplied = false;
  let investigationTriggerReason: InvestigationTriggerReason = 'unchanged_renotification';
  const canonicalIsCurrent =
    canonicalSignal?.state === input.current.state &&
    canonicalSignal.contentHash === input.current.contentHash;
  if (!canonicalIsCurrent) {
    const observed = await hub.observeSignalTx(
      tx,
      tenantId,
      {
        incidentId,
        provider: 'platform',
        materialHash: input.current.contentHash,
        surface: 'dashboard',
        channel: input.sourcePath,
        externalMessageId: canonicalExternalId,
        state: input.current.state,
        summary: input.current.summary,
        contentHash: input.current.contentHash,
        eventKey: `subject-sync:v2:${input.subjectRowId}:${input.current.contentHash}`,
        eventAt: input.current.observedAt,
      },
      `${input.current.state === 'resolved' ? 'Recovered' : 'Updated'}: ${input.current.summary}`,
    );
    message = observed.message;
    canonicalSignal = observed.observation.signal;
    canonicalObservationApplied = observed.observation.applied;
    investigationTriggerReason = observed.observation.investigationTriggerReason;
  }
  if (!canonicalSignal)
    throw new Error('subject signal projection is missing its canonical signal');

  const repairedSignals: Array<{ id: string; version: number }> = [];
  for (const signal of activeLegacy) {
    const eventAt =
      input.current.observedAt.getTime() > signal.lastEventAt.getTime()
        ? input.current.observedAt
        : signal.lastEventAt;
    const repaired = await tx
      .update(incidentSignals)
      .set({
        state: 'resolved',
        lastEventType: 'resolved',
        lastEventKey: `subject-projection-repair:${input.subjectRowId}:${signal.id}:${signal.version + 1}`,
        lastEventAt: eventAt,
        lastSeenAt: eventAt,
        resolvedAt: eventAt,
        version: sql`${incidentSignals.version} + 1`,
      })
      .where(eq(incidentSignals.id, signal.id))
      .returning({ id: incidentSignals.id, version: incidentSignals.version });
    if (repaired[0]) repairedSignals.push(repaired[0]);
  }

  const states = await tx
    .select({ state: incidentSignals.state })
    .from(incidentSignals)
    .where(eq(incidentSignals.incidentId, incidentId));
  return {
    message,
    canonicalSignalId: canonicalSignal.id,
    canonicalSignalVersion: canonicalSignal.version,
    canonicalObservationApplied,
    allResolved: states.length > 0 && states.every((signal) => signal.state === 'resolved'),
    signalFence: await incidentSignalFenceTx(tx, incidentId),
    repairedSignals,
    repairedSignalCount: repairedSignals.length,
    staleBeyondInterval: projectionWasStale && divergenceAgeMs >= SUBJECT_SYNC_INTERVAL_MS,
    divergenceAgeMs,
    investigationTriggerReason,
  };
}
