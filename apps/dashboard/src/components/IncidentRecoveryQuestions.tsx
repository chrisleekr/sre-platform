import type { RecoveryQuestion, InvestigationGapCategory } from '@sre/contracts';
import { EvidenceCitation } from './IncidentEvidenceCitation';
export const GAP_LABELS: Record<InvestigationGapCategory, string> = {
  observable: 'Automatic check incomplete',
  partial_evidence: 'Partial evidence',
  missing_capability: 'Connector or metadata needed',
  historical_gap: 'Historical evidence unavailable',
  contradictory_evidence: 'Evidence conflicts',
  operator_decision: 'Decision needed',
};

export function IncidentRecoveryQuestions({
  questions,
  onSelectEvidence,
}: {
  questions?: RecoveryQuestion[] | null;
  onSelectEvidence: (id: string, context?: string) => void;
}) {
  return (
    <>
      {(['blocking', 'follow_up'] as const).map((relevance) => {
        const group =
          questions?.filter((question) => question.resolutionRelevance === relevance) ?? [];
        if (group.length === 0) return null;
        return (
          <section key={relevance} className="mt-3 rounded-md border border-line bg-surface p-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-ink">
              {relevance === 'blocking' ? 'Blocks resolution' : 'Follow-up work'}
            </h3>
            <ul className="mt-2 space-y-3 text-sm text-ink">
              {group.map((question, index) => (
                <li key={index} className="break-words">
                  <p className="text-xs text-ink-muted">{GAP_LABELS[question.category]}</p>
                  <p>{question.question}</p>
                  <p className="mt-1">
                    <span className="font-semibold">Next action: </span>
                    {question.nextAction}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {question.attemptedEvidenceIds.map((id) => (
                      <EvidenceCitation
                        key={id}
                        evidenceId={id}
                        onSelect={onSelectEvidence}
                        context={`Attempted check: ${question.question}`}
                      />
                    ))}
                    {question.attemptedEvidenceIds.length === 0 && (
                      <span className="text-xs text-ink-muted">No recorded check attempts</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
