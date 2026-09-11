import { checkResponse, requestErrorMessage } from '../lib/request-error';
import { credentialHeaders } from '../lib/request-credentials';
import type { CredentialGetter } from '../lib/request-credentials';
import { sessionFetch } from '../lib/session-fetch';
import { useState } from 'react';
import { config } from '../config';
import type { IncidentWorkspaceData } from '../lib/types';

export function latestFindingFeedback(workspace: IncidentWorkspaceData, targetId?: string | null) {
  const runId = targetId ?? workspace.incident.trustedAssessmentRunId;
  if (!runId) return null;
  return (workspace.feedback ?? []).find(
    (feedback) => feedback.targetType === 'finding' && feedback.targetId === runId,
  );
}

export function FindingFeedback({
  workspace,
  getCredentials,
  onChanged,
  targetId: targetIdOverride,
  compact = false,
}: {
  workspace: IncidentWorkspaceData;
  getCredentials: CredentialGetter;
  onChanged: () => void;
  targetId?: string | null;
  compact?: boolean;
}) {
  const targetId = targetIdOverride ?? workspace.incident.trustedAssessmentRunId;
  const current = latestFindingFeedback(workspace, targetId);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [mode, setMode] = useState<'confirm' | 'correct' | null>(null);
  const [rationale, setRationale] = useState('');
  const [replacement, setReplacement] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (
    !targetId ||
    !workspace.viewerUserId ||
    !workspace.feedbackEligibleFindingRunIds?.includes(targetId)
  )
    return null;
  const corrected =
    current?.decision === 'correct' && typeof current.correction?.replacement === 'string'
      ? current.correction.replacement
      : null;

  const submit = async () => {
    if (!mode || !rationale.trim() || (mode === 'correct' && !replacement.trim())) return;
    setPending(true);
    setError(null);
    try {
      const response = await sessionFetch(
        `${config.apiBaseUrl}/incidents/${workspace.incident.id}/feedback`,
        {
          method: 'POST',
          headers: {
            ...credentialHeaders(await getCredentials()),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            targetType: 'finding',
            targetId,
            decision: mode,
            rationale: rationale.trim(),
            replacement: mode === 'correct' ? replacement.trim() : null,
          }),
        },
      );
      await checkResponse(response, 'Feedback could not be saved.');
      setMode(null);
      setRationale('');
      setReplacement('');
      onChanged();
    } catch (caught) {
      setError(requestErrorMessage(caught, 'Feedback could not be saved.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="mt-3">
      <button
        type="button"
        aria-expanded={reviewOpen}
        onClick={() => setReviewOpen(!reviewOpen)}
        className={`min-h-9 rounded px-1 text-xs font-medium underline underline-offset-4 ${compact ? 'text-on-strong-muted' : 'text-ink-secondary'}`}
      >
        {reviewOpen
          ? 'Hide conclusion review'
          : current
            ? 'View conclusion review'
            : 'Review conclusion'}
      </button>
      {reviewOpen && (
        <div className="mt-2 rounded-lg border border-line bg-surface p-3 text-ink">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink">
                Is this conclusion supported by the evidence?
              </h3>
              <p className="mt-1 text-sm text-ink-secondary">
                Record your review. This does not resolve the incident or approve a change.
              </p>
              {current && (
                <p className="mt-2 text-sm text-ink-secondary">
                  {current.decision === 'confirm'
                    ? `Confirmed: ${current.rationale}`
                    : `Corrected: ${current.rationale}`}
                </p>
              )}
              {corrected && (
                <p className="mt-2 rounded border border-info-line bg-info-soft p-2 text-sm font-medium text-info">
                  {corrected}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setMode('confirm')}
                className="min-h-10 rounded border border-success-line bg-surface px-3 py-2 text-xs font-semibold text-success"
              >
                Confirm conclusion
              </button>
              <button
                type="button"
                onClick={() => setMode('correct')}
                className="min-h-10 rounded border border-warning-line bg-surface px-3 py-2 text-xs font-semibold text-warning"
              >
                Correct conclusion
              </button>
            </div>
          </div>
          {mode && (
            <div className="mt-3 border-t border-line pt-3">
              <label className="block text-xs font-semibold text-ink-secondary">
                Supporting evidence
                <textarea
                  rows={2}
                  maxLength={1_000}
                  value={rationale}
                  onChange={(event) => setRationale(event.target.value)}
                  className="mt-1 min-h-20 w-full rounded border border-line-strong bg-surface px-3 py-2 text-sm"
                  placeholder="What evidence confirms or contradicts this finding?"
                />
              </label>
              {mode === 'correct' && (
                <label className="mt-3 block text-xs font-semibold text-ink-secondary">
                  Corrected conclusion
                  <textarea
                    rows={3}
                    maxLength={4_000}
                    value={replacement}
                    onChange={(event) => setReplacement(event.target.value)}
                    className="mt-1 min-h-24 w-full rounded border border-line-strong bg-surface px-3 py-2 text-sm"
                    placeholder="State the corrected conclusion."
                  />
                </label>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setMode(null)}
                  disabled={pending}
                  className="min-h-10 rounded border border-line-strong bg-surface px-3 py-2 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={
                    pending || !rationale.trim() || (mode === 'correct' && !replacement.trim())
                  }
                  className="min-h-10 rounded bg-strong px-3 py-2 text-sm font-semibold text-on-strong disabled:opacity-50"
                >
                  {pending ? 'Saving…' : 'Save review'}
                </button>
              </div>
              {error && (
                <p role="alert" className="mt-2 text-sm text-critical">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
