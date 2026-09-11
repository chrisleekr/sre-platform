import { checkResponse, requestErrorMessage } from '../lib/request-error';
import { ASSESSMENT_VERDICTS, type AssessmentGrade, type AssessmentVerdict } from '@sre/contracts';
import { useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { authenticatedFetch } from '../lib/authenticatedFetch';

const VERDICT_LABELS: Record<AssessmentVerdict, string> = {
  correct: 'Correct',
  partial: 'Partially right',
  incorrect: 'Incorrect',
};

/**
 * The responder's three-way verdict on the root-cause assessment this postmortem pinned. A
 * human verdict overrides the model judge's for calibration; both stay visible so agreement is
 * measurable.
 */
export function PostmortemGrade({
  incidentId,
  grade,
  onGraded,
}: {
  incidentId: string;
  grade: AssessmentGrade | null;
  onGraded: (grade: AssessmentGrade) => void;
}) {
  const { getCredentials } = useSession();
  const [rationale, setRationale] = useState('');
  const [pending, setPending] = useState<AssessmentVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(verdict: AssessmentVerdict) {
    if (pending || !rationale.trim()) return;
    setPending(verdict);
    setError(null);
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/incidents/${encodeURIComponent(incidentId)}/postmortem/grade`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ verdict, rationale: rationale.trim() }),
        },
      );
      await checkResponse(
        response,
        response.status === 409
          ? 'No assessment with a claimed confidence is pinned to this postmortem.'
          : 'Verdict could not be recorded.',
      );
      onGraded(((await response.json()) as { grade: AssessmentGrade }).grade);
      setRationale('');
    } catch (err) {
      setError(requestErrorMessage(err, 'Verdict could not be recorded.'));
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      aria-label="Assessment grade"
      className="space-y-3 rounded-lg border border-line bg-surface p-4"
    >
      <h2 className="text-lg font-semibold tracking-tight">Was the root-cause assessment right?</h2>
      {grade?.modelVerdict && (
        <p className="text-sm text-ink-muted">
          Model judge:{' '}
          <span className="font-semibold text-ink">{VERDICT_LABELS[grade.modelVerdict]}</span>
          {grade.modelRationale && <> · {grade.modelRationale}</>}
        </p>
      )}
      {grade?.humanVerdict && (
        <p className="text-sm text-ink-muted">
          Responder verdict:{' '}
          <span className="font-semibold text-ink">{VERDICT_LABELS[grade.humanVerdict]}</span>
          {grade.humanRationale && <> · {grade.humanRationale}</>}
        </p>
      )}
      <label className="block text-sm">
        <span className="font-semibold">Rationale</span>
        <textarea
          rows={2}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          className="mt-1 w-full resize-y rounded border border-line-strong bg-surface px-3 py-2 text-sm"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {ASSESSMENT_VERDICTS.map((verdict) => (
          <button
            key={verdict}
            type="button"
            disabled={pending !== null || !rationale.trim()}
            onClick={() => void submit(verdict)}
            className="sre-hit-target rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink-secondary hover:bg-surface-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending === verdict ? 'Recording…' : VERDICT_LABELS[verdict]}
          </button>
        ))}
      </div>
    </section>
  );
}
