import type { IncidentWorkspaceData } from '../../lib/types';

export function deriveIncidentState(workspace: IncidentWorkspaceData) {
  const incident = workspace.incident;
  const mergedInto = (workspace.relations ?? []).find(
    (relation) => relation.type === 'merged_into' && relation.sourceIncidentId === incident.id,
  );
  const signals = workspace.signals ?? [];
  const activeSignals = signals.filter((signal) => signal.state !== 'resolved');
  const activeSignalCount = activeSignals.length;
  const allSignalsCleared = signals.length > 0 && activeSignalCount === 0;
  const activeLifecycle = incident.status === 'open' || incident.status === 'mitigated';
  const needsHuman = activeLifecycle && Boolean(incident.requiresHumanAttention);
  const ownershipMarker = needsHuman
    ? 'bg-critical-solid'
    : activeLifecycle
      ? 'bg-info-solid'
      : 'bg-success-solid';
  const ownershipLabel =
    incident.purpose === 'health_check' && !activeLifecycle
      ? 'Health check completed'
      : needsHuman
        ? incident.status === 'mitigated'
          ? 'Needs human attention; mitigation in place'
          : 'Needs human attention'
        : incident.status === 'open'
          ? 'Incident open'
          : incident.status === 'mitigated'
            ? 'Mitigation in place'
            : incident.status === 'resolved'
              ? 'Incident resolved'
              : 'Incident record closed';
  const providerState =
    signals.length === 0
      ? incident.alertSource === 'manual' || incident.purpose === 'health_check'
        ? {
            marker: 'bg-line-strong',
            text: 'text-ink-muted',
            label: 'Not applicable for human report',
          }
        : {
            marker: 'bg-critical-solid',
            text: 'text-critical',
            label: 'Signal tracking unavailable',
          }
      : allSignalsCleared
        ? {
            marker: 'bg-success-solid',
            text: 'text-success',
            label: 'All signals clear',
          }
        : {
            marker: 'bg-critical-solid',
            text: 'text-critical',
            label: `${activeSignalCount} unresolved record${activeSignalCount === 1 ? '' : 's'}`,
          };
  const recoveryIsCurrent =
    incident.purpose !== 'health_check' &&
    incident.recoveryState != null &&
    (incident.recoveryUpdatedAt != null
      ? Date.parse(incident.recoveryUpdatedAt) >=
        (incident.assessmentUpdatedAt ? Date.parse(incident.assessmentUpdatedAt) : 0)
      : incident.assessmentUpdatedAt == null);

  return {
    activeLifecycle,
    activeSignalCount,
    activeSignals,
    allSignalsCleared,
    mergedTargetId: mergedInto?.targetIncidentId,
    needsHuman,
    ownershipLabel,
    ownershipMarker,
    providerState,
    recoveryIsCurrent,
    signals,
  };
}
