import type { InvestigationTriggerReason } from '@sre/contracts';
import type { SignalEventType, SignalState } from './schema';

/**
 * Produces stable, deduplicated budget scopes for an investigation.
 *
 * @param values - Optional monitor keys from the investigated signals.
 */
export function investigationMonitorKeys(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

/**
 * Derives the exact monitor scopes shared by budget admission and operator projections.
 * @param incident - Incident identity used for the fallback monitor scope.
 * @param signals - Current provider signals and optional stable monitor keys.
 */
export function incidentInvestigationMonitorKeys(
  incident: { alertSource: string; fingerprint: string },
  signals: Array<{ monitorKey: string | null }>,
): string[] {
  const fallback = `${incident.alertSource}:${incident.fingerprint}`.slice(0, 500);
  return investigationMonitorKeys(
    signals.length > 0 ? signals.map((signal) => signal.monitorKey ?? fallback) : [fallback],
  );
}

/**
 * Maps one persisted signal observation to the generic investigation trigger vocabulary.
 *
 * @param eventType - Durable event type produced by signal normalization.
 * @param applied - Whether the observation changed durable signal state.
 */
export function signalInvestigationTriggerReason(
  eventType: SignalEventType,
  applied: boolean,
): InvestigationTriggerReason {
  if (!applied) return 'unchanged_renotification';
  if (eventType === 'opened' || eventType === 'refired') return 'new_episode';
  return eventType === 'resolved' ? 'state_transition' : 'material_change';
}

/**
 * Derives reassessment provenance from the current incident signal set.
 *
 * @param signals - Persisted signals currently attached to the incident.
 * @param signal - Signal whose version triggered the reassessment.
 */
export function incidentSignalInvestigationTriggerReason(
  signals: Array<{
    id: string;
    monitorKey: string | null;
    lastEventType: SignalEventType;
    state: SignalState;
  }>,
  signal: {
    id: string;
    monitorKey: string | null;
    lastEventType: SignalEventType;
    state: SignalState;
  },
): InvestigationTriggerReason {
  if (
    signal.lastEventType === 'opened' &&
    signal.monitorKey &&
    signals.some(
      (current) =>
        current.id !== signal.id &&
        current.monitorKey === signal.monitorKey &&
        current.state === 'firing',
    )
  )
    return 'material_change';
  return signalInvestigationTriggerReason(signal.lastEventType, true);
}
