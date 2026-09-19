import type { CredentialGetter } from '../lib/request-credentials';
import { formatAbsoluteTime } from '../lib/time';
import type { IncidentWorkspaceData } from '../lib/types';
import type { InvestigationGap, InvestigationGapCategory } from '@sre/contracts';
import { FindingFeedback, latestFindingFeedback } from './FindingFeedback';
import { EvidenceCitation } from './IncidentEvidenceCitation';

const GAP_LABELS: Record<InvestigationGapCategory, string> = {
  observable: 'Automatic check incomplete',
  partial_evidence: 'Partial evidence',
  missing_capability: 'Connector or metadata needed',
  historical_gap: 'Historical evidence unavailable',
  contradictory_evidence: 'Evidence conflicts',
  operator_decision: 'Decision needed',
};

function boundedTakeaway(value: string, maxCharacters = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const characters = [...normalized];
  if (characters.length <= maxCharacters) return normalized;
  return `${characters
    .slice(0, maxCharacters - 1)
    .join('')
    .trimEnd()}…`;
}

export function IncidentDecisionBrief({
  workspace,
  onSelectEvidence,
  getCredentials,
  onChanged,
}: {
  workspace: IncidentWorkspaceData;
  onSelectEvidence: (id: string, context?: string) => void;
  getCredentials: CredentialGetter;
  onChanged: () => void;
}) {
  const { incident, progress } = workspace;
  const hypotheses = incident.rankedHypotheses ?? [];
  const leading = hypotheses.find((hypothesis) => hypothesis.state === 'leading') ?? hypotheses[0];
  const assessmentUpdatedAt = incident.assessmentUpdatedAt
    ? Date.parse(incident.assessmentUpdatedAt)
    : Number.NEGATIVE_INFINITY;
  const recoveryUpdatedAt = incident.recoveryUpdatedAt
    ? Date.parse(incident.recoveryUpdatedAt)
    : Number.NEGATIVE_INFINITY;
  const recoveryIsCurrent =
    incident.purpose !== 'health_check' &&
    incident.recoveryState != null &&
    (incident.recoveryUpdatedAt != null
      ? recoveryUpdatedAt >= assessmentUpdatedAt
      : incident.assessmentUpdatedAt == null);
  const cited = (
    recoveryIsCurrent
      ? (incident.recoveryEvidenceIds ?? [])
      : [
          ...(incident.assessmentEvidenceIds ?? []),
          ...(leading?.supportingEvidenceIds ?? []),
          ...(leading?.contradictingEvidenceIds ?? []),
        ]
  ).filter((id, index, all) => all.indexOf(id) === index);
  const currentStateFull =
    incident.purpose === 'health_check' && ['closed', 'resolved'].includes(incident.status)
      ? 'Health check completed'
      : ((recoveryIsCurrent
          ? incident.recoveryState === 'verified'
            ? 'Recovery verified'
            : incident.recoveryState === 'verifying'
              ? 'Recovery not verified'
              : incident.recoveryState === 'monitoring'
                ? 'Recovery not verified'
                : 'Recovery not verified'
          : incident.currentState) ?? 'Recovery not verified');
  const currentState = boundedTakeaway(currentStateFull, 120);
  const decisionUpdatedAt = recoveryIsCurrent
    ? incident.recoveryUpdatedAt
    : incident.assessmentUpdatedAt;
  const recoveryTakeaway =
    recoveryIsCurrent && incident.recoverySummary
      ? boundedTakeaway(incident.recoverySummary)
      : null;
  const impactFull =
    incident.impact ??
    (incident.purpose === 'health_check'
      ? 'This is a health check, not a reported outage.'
      : 'Impact not established in this assessment.');
  const impact = boundedTakeaway(impactFull);
  // The operator panel renders the required human decision; this box stays diagnostic.
  const nextStepFull = recoveryIsCurrent
    ? incident.recoveryNextStep
    : (incident.nextStep ?? incident.latestInvestigationRun?.nextStep);
  const nextStep = nextStepFull ? boundedTakeaway(nextStepFull) : null;
  const recoveryUnknowns = recoveryIsCurrent
    ? (incident.recoveryUnknowns ?? []).filter(Boolean)
    : [];
  const gaps: InvestigationGap[] = recoveryIsCurrent
    ? []
    : ((incident.unknowns ?? []) as unknown[]).flatMap((value) => {
        if (typeof value === 'string' && value.trim()) {
          return [
            {
              question: value,
              category: 'partial_evidence' as const,
              evidenceKind: null,
              attemptedEvidenceIds: [],
            },
          ];
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const gap = value as InvestigationGap;
        return typeof gap.question === 'string' && gap.question.trim() ? [gap] : [];
      });
  const findingFeedback = latestFindingFeedback(workspace);
  const responderCorrection =
    findingFeedback?.decision === 'correct' &&
    typeof findingFeedback.correction?.replacement === 'string'
      ? findingFeedback.correction.replacement
      : null;
  const leadingTakeaway = boundedTakeaway(
    responderCorrection ?? leading?.hypothesis ?? incident.rcaSummary ?? 'No diagnosis established',
  );
  const recoveryTone =
    incident.recoveryState === 'verified'
      ? 'border-success-line bg-success-soft text-success'
      : incident.recoveryState === 'not_verified'
        ? 'border-critical-line bg-critical-soft text-critical'
        : incident.recoveryState === 'verifying' || incident.recoveryState === 'monitoring'
          ? 'border-info-line bg-info-soft text-info'
          : 'border-warning-line bg-warning-soft text-warning';
  const briefContext = recoveryIsCurrent
    ? 'Recovery status'
    : incident.trustedAssessmentRunId || incident.rcaSummary
      ? 'Last trusted assessment'
      : 'No trusted assessment yet';

  return (
    <section
      className="rounded-lg border border-line-strong bg-surface p-4"
      aria-labelledby="decision-brief-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-assessment">
            Responder brief
          </p>
          <p className="mt-1 text-xs font-semibold text-ink-muted">{briefContext}</p>
          <h2 id="decision-brief-title" className="mt-1 break-words text-lg font-medium text-ink">
            {currentState}
          </h2>
          {decisionUpdatedAt && (
            <p className="mt-1 text-xs text-ink-muted">
              Updated {formatAbsoluteTime(decisionUpdatedAt)}
              {!recoveryIsCurrent && incident.engineModel ? ` · ${incident.engineModel}` : ''}
            </p>
          )}
        </div>
        {!recoveryIsCurrent && incident.confidence != null && (
          <span className="rounded-full bg-assessment-muted px-3 py-1 text-xs font-semibold text-assessment">
            Model confidence {incident.confidence}/100
          </span>
        )}
      </div>
      {currentState !== currentStateFull.replace(/\s+/g, ' ').trim() && (
        <details className="mt-2 text-xs text-ink-muted">
          <summary className="cursor-pointer font-semibold">Full operational state</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{currentStateFull}</p>
        </details>
      )}
      {recoveryTakeaway && (
        <div className={`mt-3 rounded-md border p-3 text-sm ${recoveryTone}`}>
          <p className="break-words">{recoveryTakeaway}</p>
          {incident.recoverySummary &&
            recoveryTakeaway !== incident.recoverySummary.replace(/\s+/g, ' ').trim() && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer font-semibold">Full recovery assessment</summary>
                <p className="mt-2 whitespace-pre-wrap break-words">{incident.recoverySummary}</p>
              </details>
            )}
        </div>
      )}
      <dl className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-md bg-surface-subtle p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Impact</dt>
          <dd className="mt-1 break-words text-sm font-medium text-ink">{impact}</dd>
          {impact !== impactFull.replace(/\s+/g, ' ').trim() && (
            <details className="mt-2 text-xs text-ink-muted">
              <summary className="cursor-pointer font-semibold">Full impact</summary>
              <p className="mt-2 whitespace-pre-wrap break-words">{impactFull}</p>
            </details>
          )}
        </div>
        <div className="rounded-md bg-assessment-soft p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-assessment">
            Leading hypothesis
          </dt>
          <dd className="mt-1 text-sm font-semibold text-ink">{leadingTakeaway}</dd>
        </div>
      </dl>
      {incident.rcaSummary &&
        incident.rcaSummary.replace(/\s+/g, ' ').trim() !== leadingTakeaway && (
          <details className="mt-3 rounded-md border border-line bg-surface-subtle p-3">
            <summary className="cursor-pointer text-sm font-semibold text-ink-secondary">
              Full assessment
            </summary>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-ink-secondary">
              {incident.rcaSummary}
            </p>
          </details>
        )}
      {nextStep && (
        <div className="mt-3 rounded-md border border-info-line bg-info-soft p-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-info">
            Next diagnostic step
          </h3>
          <p className="mt-1 break-words text-sm font-medium text-info">{nextStep}</p>
          {nextStepFull && nextStep !== nextStepFull.replace(/\s+/g, ' ').trim() && (
            <details className="mt-2 text-xs text-info">
              <summary className="cursor-pointer font-semibold">Full next step</summary>
              <p className="mt-2 whitespace-pre-wrap break-words">{nextStepFull}</p>
            </details>
          )}
        </div>
      )}
      {cited.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span className="font-semibold">Evidence</span>
          {cited.map((evidenceId) => (
            <EvidenceCitation
              key={evidenceId}
              evidenceId={evidenceId}
              onSelect={onSelectEvidence}
              context={
                recoveryIsCurrent
                  ? (incident.recoverySummary ?? 'Recovery assessment citation')
                  : (incident.rcaSummary ?? leading?.hypothesis ?? 'Recorded assessment citation')
              }
            />
          ))}
        </div>
      )}
      {(leading?.contradictingEvidenceIds ?? []).length > 0 && (
        <div className="mt-3 rounded-md border border-warning-line bg-warning-soft p-3 text-sm text-warning">
          <p className="font-semibold">Contradicting evidence</p>
          <p className="mt-1">
            These checks challenge the leading hypothesis. Review them before deciding.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {leading!.contradictingEvidenceIds!.map((id) => (
              <EvidenceCitation
                key={id}
                evidenceId={id}
                onSelect={onSelectEvidence}
                context={`Contradicts hypothesis: ${leading?.hypothesis ?? 'Not established'}`}
              />
            ))}
          </div>
        </div>
      )}
      {workspace.assessmentState === 'invalid' && (
        <p role="alert" className="mt-3 rounded-md bg-critical-soft p-3 text-sm text-critical">
          The stored structured assessment is invalid. The transcript and evidence remain available.
        </p>
      )}
      <FindingFeedback
        workspace={workspace}
        getCredentials={getCredentials}
        onChanged={onChanged}
      />
      {recoveryUnknowns.length > 0 && (
        <div className="mt-3 rounded-md bg-warning-soft p-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-warning">
            Recovery questions
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-warning">
            {recoveryUnknowns.map((unknown, index) => (
              <li key={`${index}:${unknown}`} className="break-words">
                {boundedTakeaway(unknown, 180)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {gaps.length > 0 && (
        <section className="mt-3 rounded-md border border-warning-line bg-warning-soft p-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-warning">
            Evidence gaps
          </h3>
          <p className="mt-1 text-xs text-warning">
            Missing information needed to confirm this assessment.
          </p>
          <ul className="mt-3 space-y-2">
            {gaps.map((gap, index) => (
              <li
                key={`${index}:${gap.category}:${gap.question}`}
                className="rounded border border-warning-line bg-surface p-2 text-sm text-ink"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-warning-muted px-2 py-0.5 text-xs font-semibold text-warning">
                    {GAP_LABELS[gap.category]}
                  </span>
                  {gap.evidenceKind && (
                    <span className="font-instrument text-xs text-ink-muted">
                      {gap.evidenceKind.replaceAll('_', ' ')}
                    </span>
                  )}
                </div>
                <p className="mt-1 break-words">{gap.question}</p>
                {gap.attemptedEvidenceIds.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-ink-muted">
                    <span>Checks</span>
                    {gap.attemptedEvidenceIds.map((evidenceId) => (
                      <EvidenceCitation
                        key={evidenceId}
                        evidenceId={evidenceId}
                        onSelect={onSelectEvidence}
                        context={`Evidence gap: ${gap.question}`}
                      />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-line pt-4 text-center sm:grid-cols-4">
        <div>
          <dt className="text-xs text-ink-muted">Cited</dt>
          <dd className="font-semibold text-assessment">{cited.length}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Checks</dt>
          <dd className="font-semibold">{progress.total}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">With data</dt>
          <dd className="font-semibold text-success">{progress.successful}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Other outcomes</dt>
          <dd className="font-semibold text-warning">{progress.failed}</dd>
        </div>
      </dl>
      {hypotheses.length > 0 && (
        <details className="mt-4 rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-3 text-sm font-semibold text-ink-secondary">
            Compare {hypotheses.length} {hypotheses.length === 1 ? 'hypothesis' : 'hypotheses'}
          </summary>
          <div className="border-t border-line p-3">
            <div className="space-y-3 lg:hidden" data-hypothesis-layout="cards">
              {hypotheses.map((hypothesis, index) => (
                <article
                  key={`card:${hypothesis.hypothesis}:${index}`}
                  aria-label={`Hypothesis ${index + 1}`}
                  className="rounded-md border border-line p-3"
                >
                  <h3 className="break-words text-sm font-medium text-ink">
                    {hypothesis.hypothesis}
                  </h3>
                  {hypothesis.evidence && (
                    <p className="mt-1 break-words text-xs text-ink-muted">{hypothesis.evidence}</p>
                  )}
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <dt className="font-semibold uppercase tracking-wide text-ink-muted">
                        State
                      </dt>
                      <dd className="mt-1 capitalize">
                        {hypothesis.state ?? (index === 0 ? 'leading' : 'plausible')}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold uppercase tracking-wide text-ink-muted">
                        Confidence
                      </dt>
                      <dd className="mt-1">{hypothesis.confidence}/100</dd>
                    </div>
                    <div>
                      <dt className="font-semibold uppercase tracking-wide text-ink-muted">
                        Supports
                      </dt>
                      <dd className="mt-1 flex flex-wrap gap-1">
                        {(hypothesis.supportingEvidenceIds ?? []).length > 0
                          ? (hypothesis.supportingEvidenceIds ?? []).map((evidenceId) => (
                              <EvidenceCitation
                                key={evidenceId}
                                evidenceId={evidenceId}
                                onSelect={onSelectEvidence}
                                context={`Supports hypothesis: ${hypothesis.hypothesis}`}
                              />
                            ))
                          : 'None cited'}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold uppercase tracking-wide text-ink-muted">
                        Contradicts
                      </dt>
                      <dd className="mt-1 flex flex-wrap gap-1">
                        {(hypothesis.contradictingEvidenceIds ?? []).length > 0
                          ? (hypothesis.contradictingEvidenceIds ?? []).map((evidenceId) => (
                              <EvidenceCitation
                                key={evidenceId}
                                evidenceId={evidenceId}
                                onSelect={onSelectEvidence}
                                context={`Contradicts hypothesis: ${hypothesis.hypothesis}`}
                              />
                            ))
                          : 'None cited'}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
            <table
              className="hidden w-full table-fixed text-left text-sm lg:table"
              data-hypothesis-layout="table"
            >
              <caption className="sr-only">Ranked incident hypotheses and cited evidence</caption>
              <colgroup>
                <col className="w-2/5" />
                <col />
                <col />
                <col />
                <col />
              </colgroup>
              <thead className="bg-surface-subtle text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2">Hypothesis</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Supports</th>
                  <th className="px-3 py-2">Contradicts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {hypotheses.map((hypothesis, index) => (
                  <tr key={`table:${hypothesis.hypothesis}:${index}`}>
                    <td className="break-words px-3 py-3 align-top">
                      <p className="font-medium text-ink">{hypothesis.hypothesis}</p>
                      {hypothesis.evidence && (
                        <p className="mt-1 break-words text-xs text-ink-muted">
                          {hypothesis.evidence}
                        </p>
                      )}
                    </td>
                    <td className="break-words px-3 py-3 align-top capitalize">
                      {hypothesis.state ?? (index === 0 ? 'leading' : 'plausible')}
                    </td>
                    <td className="break-words px-3 py-3 align-top">{hypothesis.confidence}/100</td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-wrap gap-1">
                        {(hypothesis.supportingEvidenceIds ?? []).map((evidenceId) => (
                          <EvidenceCitation
                            key={evidenceId}
                            evidenceId={evidenceId}
                            onSelect={onSelectEvidence}
                            context={`Supports hypothesis: ${hypothesis.hypothesis}`}
                          />
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-wrap gap-1">
                        {(hypothesis.contradictingEvidenceIds ?? []).map((evidenceId) => (
                          <EvidenceCitation
                            key={evidenceId}
                            evidenceId={evidenceId}
                            onSelect={onSelectEvidence}
                            context={`Contradicts hypothesis: ${hypothesis.hypothesis}`}
                          />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
