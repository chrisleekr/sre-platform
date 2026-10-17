import { EvidenceCitation } from './IncidentEvidenceCitation';
import type { Incident } from '../lib/types';

type Hypothesis = NonNullable<Incident['rankedHypotheses']>[number];

/** Collapsible comparison of every ranked hypothesis with its cited evidence. */
export function HypothesisComparison({
  hypotheses,
  onSelectEvidence,
}: {
  hypotheses: Hypothesis[];
  onSelectEvidence: (id: string, context?: string) => void;
}) {
  if (hypotheses.length === 0) return null;
  return (
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
              <h3 className="break-words text-sm font-medium text-ink">{hypothesis.hypothesis}</h3>
              {hypothesis.evidence && (
                <p className="mt-1 break-words text-xs text-ink-muted">{hypothesis.evidence}</p>
              )}
              <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <dt className="font-semibold uppercase tracking-wide text-ink-muted">State</dt>
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
                  <dt className="font-semibold uppercase tracking-wide text-ink-muted">Supports</dt>
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
                    <p className="mt-1 break-words text-xs text-ink-muted">{hypothesis.evidence}</p>
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
  );
}
