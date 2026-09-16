import type { Incident } from '../lib/types';
import { investigationWorkLabel } from '../lib/incidentState';
import { investigationRunOutcomeLabel } from '../lib/investigationRuns';
import { formatAbsoluteTime } from '../lib/time';

/** Recorded activity and historical outcome answer different response questions. */
export function IncidentAutomationStatus({ incident }: { incident: Incident }) {
  // Same rule as the API's next automation: a processing job's time is when it became runnable, and a
  // recovery check time is a schedule only while recovery is monitored.
  const pending = incident.pendingAutomation;
  const at = pending
    ? pending.status === 'queued'
      ? pending.scheduledAt
      : null
    : incident.recoveryState === 'monitoring'
      ? incident.recoveryNextCheckAt
      : null;
  const run = incident.latestInvestigationRun;
  return (
    <section
      className="rounded border border-line bg-surface p-3 text-sm"
      aria-label="Recorded automation"
    >
      <p className="font-semibold">{investigationWorkLabel(incident)}</p>
      {at && (
        <p className="mt-1 text-xs text-ink-muted">Scheduled time: {formatAbsoluteTime(at)}</p>
      )}
      {incident.pendingAutomation?.status === 'processing' && (
        <p className="mt-1 text-xs text-ink-muted">
          Recorded processing status does not confirm live worker progress.
        </p>
      )}
      {run && (
        <div className="mt-2 border-t border-line pt-2">
          <p className="font-semibold">
            {run.outcome === 'failed'
              ? 'Latest follow-up failed'
              : `Latest follow-up: ${investigationRunOutcomeLabel(run.outcome)}`}
          </p>
          <p className="mt-1 text-xs text-ink-muted">{formatAbsoluteTime(run.completedAt)}</p>
        </div>
      )}
    </section>
  );
}
