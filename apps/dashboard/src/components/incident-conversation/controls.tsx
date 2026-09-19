import { POSTMORTEM_TRIGGERS, type PostmortemTrigger } from '@sre/contracts';
import { Link } from 'react-router-dom';
import { incidentPath, postmortemPath } from '../../lib/routes';
import { lifecycleActions, signalHeadline } from './signals';
import type { IncidentLiveViewModel } from './view-model';

/** Google SRE Ch 15 postmortem triggers, in the order the contract declares them. */
export const POSTMORTEM_TRIGGER_LABELS: Record<PostmortemTrigger, string> = {
  user_visible_impact: 'User-visible impact',
  data_loss: 'Data loss',
  oncall_intervention: 'On-call intervention',
  slow_resolution: 'Slow resolution',
  monitoring_failure: 'Monitoring failure',
};

export function IncidentControls({ view }: { view: IncidentLiveViewModel }) {
  const {
    incident,
    lifecycleReason,
    setLifecycleReason,
    lifecyclePending,
    lifecycleError,
    postmortemTrigger,
    setPostmortemTrigger,
    postmortemPending,
    postmortemError,
    generatePostmortem,
    signalCorrectionOpen,
    setSignalCorrectionOpen,
    signalCorrectionTarget,
    setSignalCorrectionTarget,
    signalCorrectionReason,
    setSignalCorrectionReason,
    signalCorrectionPending,
    signalCorrectionError,
    setSignalCorrectionError,
    signalCorrectionStale,
    archiveConfirmation,
    setArchiveConfirmation,
    archiveReason,
    setArchiveReason,
    archivePending,
    archiveError,
    setArchiveError,
    transitionLifecycle,
    correctSignal,
    deleteIncident,
    activeSignalCount,
    activeSignals,
    allSignalsCleared,
    mergedTargetId,
  } = view;
  return (
    <>
      {allSignalsCleared && ['open', 'mitigated'].includes(incident.status) && (
        <div
          role="status"
          className={`mt-4 rounded-lg border p-3 text-sm ${
            incident.recoveryState === 'verified'
              ? 'border-success-line bg-success-soft text-success'
              : incident.recoveryState === 'verifying' || incident.recoveryState === 'monitoring'
                ? 'border-info-line bg-info-soft text-info'
                : 'border-warning-line bg-warning-soft text-warning'
          }`}
        >
          <p className="font-semibold">
            {incident.recoveryState === 'verified'
              ? (incident.pendingApprovalCount ?? 0) > 0
                ? 'Recovery verified; an approval is still pending.'
                : 'Recovery verified; lifecycle transition is pending.'
              : 'Provider notifications cleared.'}
          </p>
          <p className="mt-1">
            {incident.recoveryState === 'verified'
              ? (incident.pendingApprovalCount ?? 0) > 0
                ? 'Decide the pending change before SRE Platform completes the automatic resolution.'
                : 'SRE Platform should resolve this recovered occurrence automatically. Preventative follow-up remains in the brief but does not keep the incident active.'
              : 'Cleared provider notifications do not establish user recovery. Review current evidence before resolving.'}
          </p>
        </div>
      )}

      {activeSignalCount > 0 && ['resolved', 'closed'].includes(incident.status) && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-critical-line bg-critical-soft p-3 text-sm text-critical"
        >
          <p className="font-semibold">
            Lifecycle is {incident.status}, but {activeSignalCount} provider signal
            {activeSignalCount === 1 ? ' is' : 's are'} still active.
          </p>
          <p className="mt-1">
            Verify whether the alert refired or the incident was resolved too early before treating
            this as recovered.
          </p>
          <button
            type="button"
            onClick={() => {
              setSignalCorrectionOpen((open) => {
                const next = !open;
                setSignalCorrectionTarget(
                  next && activeSignals[0]
                    ? { id: activeSignals[0].id, expectedVersion: activeSignals[0].version }
                    : null,
                );
                return next;
              });
              setSignalCorrectionError(null);
            }}
            className="mt-3 min-h-10 rounded border border-critical-line bg-surface px-3 py-2 font-semibold text-critical"
          >
            {signalCorrectionOpen ? 'Cancel signal correction' : 'Review signal state'}
          </button>
          {signalCorrectionOpen && signalCorrectionTarget && (
            <div className="mt-3 rounded-md border border-critical-line bg-surface p-3 text-ink">
              <p className="font-semibold">Correct a mistaken provider projection</p>
              <p className="mt-1 text-xs text-ink-muted">
                This changes SRE Platform's recorded state. It does not silence or modify the
                upstream alert.
              </p>
              <label className="mt-3 block text-xs font-semibold text-ink-secondary">
                Provider record
                <select
                  value={signalCorrectionStale ? '' : signalCorrectionTarget.id}
                  onChange={(event) => {
                    const signal = activeSignals.find((item) => item.id === event.target.value);
                    setSignalCorrectionTarget(
                      signal ? { id: signal.id, expectedVersion: signal.version } : null,
                    );
                    setSignalCorrectionError(null);
                  }}
                  className="sre-field mt-1 min-h-11 w-full"
                >
                  {signalCorrectionStale && <option value="">State changed, reselect</option>}
                  {activeSignals.map((signal) => (
                    <option key={signal.id} value={signal.id}>
                      {signalHeadline(signal.summary)} · version {signal.version}
                    </option>
                  ))}
                </select>
              </label>
              {signalCorrectionStale && (
                <p className="mt-2 text-sm text-critical">
                  This provider record changed. Select the current record before correcting it.
                </p>
              )}
              <label className="mt-3 block text-xs font-semibold text-ink-secondary">
                Correction reason
                <input
                  value={signalCorrectionReason}
                  onChange={(event) => setSignalCorrectionReason(event.target.value)}
                  maxLength={2_000}
                  placeholder="What evidence shows this provider record is cleared?"
                  className="sre-field mt-1 min-h-11 w-full"
                />
              </label>
              <button
                type="button"
                onClick={() => void correctSignal()}
                disabled={
                  signalCorrectionPending || signalCorrectionStale || !signalCorrectionReason.trim()
                }
                className="sre-action sre-action-primary mt-3 min-h-11"
              >
                {signalCorrectionPending ? 'Correcting…' : 'Mark selected signal cleared'}
              </button>
              {signalCorrectionError && (
                <p className="mt-2 text-sm text-critical">{signalCorrectionError}</p>
              )}
            </div>
          )}
        </div>
      )}

      {mergedTargetId && (
        <div
          role="status"
          className="mt-4 rounded-lg border border-info-line bg-info-soft p-3 text-sm"
        >
          <p className="font-semibold text-info">
            This alert was joined into another investigation.
          </p>
          <p className="mt-1 text-info">
            This record remains auditable, but lifecycle changes and new questions belong in{' '}
            <Link className="font-semibold underline" to={incidentPath(mergedTargetId)}>
              the active incident
            </Link>
            .
          </p>
        </div>
      )}

      <details
        id="incident-lifecycle-controls"
        open={incident.purpose === 'health_check'}
        className="mt-4 rounded-lg border border-line bg-surface"
      >
        <summary className="sre-hit-target cursor-pointer px-4 py-3 text-sm font-semibold text-ink-secondary">
          {incident.purpose === 'health_check'
            ? 'Complete or reopen health check'
            : 'Manage incident lifecycle'}
        </summary>
        <div className="border-t border-line p-3">
          <label htmlFor="lifecycle-reason" className="text-xs font-semibold text-ink-secondary">
            Lifecycle change reason
          </label>
          <div className="mt-2 flex min-w-0 flex-wrap items-end gap-2">
            <input
              id="lifecycle-reason"
              value={lifecycleReason}
              onChange={(event) => setLifecycleReason(event.target.value)}
              disabled={Boolean(mergedTargetId)}
              maxLength={2_000}
              placeholder="What changed, and what evidence supports it?"
              className="sre-field min-h-11 min-w-60 flex-1"
            />
            {lifecycleActions(incident.status)
              .filter(
                (action) =>
                  incident.purpose !== 'health_check' ||
                  action.to === 'closed' ||
                  action.to === 'open',
              )
              .map((action) => (
                <button
                  key={action.to}
                  type="button"
                  disabled={
                    lifecyclePending !== null || Boolean(mergedTargetId) || !lifecycleReason.trim()
                  }
                  onClick={() => void transitionLifecycle(action.to)}
                  className="sre-action min-h-11"
                >
                  {lifecyclePending === action.to
                    ? 'Saving…'
                    : incident.purpose === 'health_check'
                      ? action.to === 'closed'
                        ? 'Complete health check'
                        : 'Reopen health check'
                      : action.label}
                </button>
              ))}
          </div>
          {lifecycleError && (
            <p role="alert" className="mt-2 text-xs text-critical">
              {lifecycleError}
            </p>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface p-3">
          <div>
            <p className="text-sm font-semibold text-ink">
              Delete {incident.purpose === 'health_check' ? 'health check' : 'incident'}
            </p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {['resolved', 'closed'].includes(incident.status)
                ? 'Remove this completed case from all lists and make its direct link unavailable.'
                : incident.purpose === 'health_check'
                  ? 'Complete the health check before deleting it.'
                  : 'Resolve or close the incident before deleting it.'}
            </p>
          </div>
          <button
            type="button"
            disabled={!['resolved', 'closed'].includes(incident.status)}
            onClick={() => {
              setArchiveConfirmation(true);
              setArchiveReason('');
              setArchiveError(null);
            }}
            className="sre-action min-h-11"
          >
            Delete
          </button>
        </div>
        {archiveConfirmation && (
          <div
            role="alertdialog"
            aria-label={
              incident.purpose === 'health_check' ? 'Delete health check' : 'Delete incident'
            }
            className="mt-2 rounded-lg border border-warning-line bg-warning-soft p-3 text-sm"
          >
            <p className="font-semibold text-warning">
              Delete this {incident.purpose === 'health_check' ? 'health check' : 'incident'}?
            </p>
            <p className="mt-1 text-warning">
              The case will disappear from every list and its direct link will stop working. This
              cannot be undone from the dashboard.
            </p>
            <label className="mt-3 block font-medium text-warning">
              Reason
              <input
                value={archiveReason}
                onChange={(event) => setArchiveReason(event.target.value)}
                maxLength={2_000}
                className="mt-1 min-h-11 w-full rounded border border-warning-line bg-surface px-3 py-2"
                placeholder="Why is this incident being deleted?"
              />
            </label>
            {archiveError && (
              <p role="alert" className="mt-2 text-critical">
                {archiveError}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={archivePending}
                onClick={() => {
                  setArchiveConfirmation(false);
                  setArchiveError(null);
                }}
                className="sre-action min-h-11"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={archivePending || !archiveReason.trim()}
                onClick={() => void deleteIncident()}
                className="sre-action sre-action-primary min-h-11"
              >
                {archivePending ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          </div>
        )}
      </details>
      <details className="mt-4 rounded-lg border border-line bg-surface">
        <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold">
          Generate postmortem
        </summary>
        <div className="space-y-3 border-t border-line px-4 py-3 text-sm">
          <p className="text-ink-muted">
            Declare why this incident earns a postmortem. Generation runs in the background; the
            draft opens for review when it is ready.
          </p>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Postmortem trigger
            </span>
            <select
              value={postmortemTrigger}
              onChange={(event) =>
                setPostmortemTrigger(event.target.value as PostmortemTrigger | '')
              }
              className="sre-field mt-1 min-h-11 w-full"
            >
              <option value="">Choose a trigger</option>
              {POSTMORTEM_TRIGGERS.map((trigger) => (
                <option key={trigger} value={trigger}>
                  {POSTMORTEM_TRIGGER_LABELS[trigger]}
                </option>
              ))}
            </select>
          </label>
          {postmortemError && (
            <p role="alert" className="text-critical">
              {postmortemError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={postmortemPending || !postmortemTrigger}
              onClick={() => void generatePostmortem()}
              className="sre-action min-h-11"
            >
              {postmortemPending ? 'Starting…' : 'Confirm postmortem generation'}
            </button>
            <Link to={postmortemPath(incident.id)} className="sre-action min-h-11 items-center">
              Open postmortem
            </Link>
          </div>
        </div>
      </details>
    </>
  );
}
