import type { IncidentTopologyContext } from '@sre/contracts';
import { Link } from 'react-router-dom';

/** Keep automatic service evidence and unresolved scope visible beside the original incident signal. */
export function IncidentTopologyMatches({ context }: { context?: IncidentTopologyContext }) {
  if (!context?.resolutions.length) return null;
  const subjects = new Map(context.subjects.map((subject) => [subject.key, subject]));
  return (
    <section
      className="mt-3 rounded-md border border-line p-3"
      aria-label="Automatic topology matches"
    >
      <h3 className="text-sm font-medium">Topology evidence</h3>
      <p className="mt-1 text-xs text-ink-muted">
        Scoped matches from connected systems. A match does not establish health, ownership or
        recovery.
      </p>
      <ul className="mt-3 space-y-3 text-sm">
        {context.resolutions.map((resolution) => {
          const subject = resolution.subjectKey ? subjects.get(resolution.subjectKey) : null;
          return (
            <li key={resolution.candidateKey}>
              {subject ? (
                <>
                  <Link
                    to={`/w/topology?subject=${encodeURIComponent(subject.key)}`}
                    className="font-medium text-accent underline"
                  >
                    {subject.name}
                  </Link>
                  <span className="break-words text-xs text-ink-muted">
                    {Object.entries(subject.scope)
                      .map(([key, value]) => ` · ${key}: ${value}`)
                      .join('')}
                  </span>
                  <p className="mt-1 text-xs text-ink-muted">
                    {subject.stale
                      ? 'Stale evidence. Verify current state before acting.'
                      : 'Matched to a discovered service. Open topology to inspect its relationships and evidence.'}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs text-warning">
                    {resolution.status === 'ambiguous'
                      ? resolution.candidateSubjectKeys.length > 1
                        ? 'Several service identities match. Their scopes remain separate; impact cannot be calculated from the name alone.'
                        : 'Sources disagree about this identity. Inspect the conflicting evidence before calculating impact.'
                      : resolution.status === 'needs_evidence'
                        ? 'The suggested service needs corroborating evidence before it can be used as a topology identity.'
                        : 'No unambiguous discovered service matches this candidate yet.'}
                  </p>
                  {resolution.candidateSubjectKeys.map((key) => {
                    const candidate = subjects.get(key);
                    return (
                      candidate && (
                        <Link
                          key={key}
                          to={`/w/topology?subject=${encodeURIComponent(key)}`}
                          className="mt-1 block break-words text-xs text-accent underline"
                        >
                          Inspect {candidate.name} ·{' '}
                          {Object.entries(candidate.scope)
                            .map(([name, value]) => `${name}: ${value}`)
                            .join(' · ') || 'Scope not reported'}
                        </Link>
                      )
                    );
                  })}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
