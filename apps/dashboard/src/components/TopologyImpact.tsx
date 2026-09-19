import type { BlastRadius } from '../lib/topology';

/** Describe modeled impact without claiming observed outages or proven protection. */
export function TopologyImpact({
  service,
  result,
  loading,
  error,
  onRetry,
  onSelect,
}: {
  service: string;
  result: BlastRadius | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelect: (name: string, subjectKey?: string) => void;
}) {
  return (
    <section
      aria-label="Dependency impact"
      className="rounded-lg border border-line bg-surface p-4 text-sm"
    >
      <h2 className="font-medium break-words">Dependency impact: {service}</h2>
      <p className="mt-1 text-xs text-ink-muted">
        If this service fails, these callers may be affected. Known calls and declarations model
        possible exposure, not observed outages or proven protection.
      </p>
      {loading && (
        <p role="status" className="mt-3">
          Calculating dependency impact…
        </p>
      )}
      {error && (
        <div role="alert" className="mt-3 text-warning">
          <p>{error}</p>
          <button type="button" onClick={onRetry} className="sre-hit-target underline">
            Retry impact analysis
          </button>
        </div>
      )}
      {!loading &&
        !error &&
        result &&
        (result.mapped ? (
          <>
            {result.note && <p className="mt-3 text-xs text-ink-muted">{result.note}</p>}
            {result.truncated && (
              <p role="alert" className="mt-3 text-warning">
                The traversal depth limit was reached. Additional callers or stronger exposure paths
                may be missing.
              </p>
            )}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {(
                [
                  [
                    'direct',
                    'Synchronous exposure',
                    'Callers reachable through synchronous calls.',
                  ],
                  [
                    'unclassified',
                    'Dependency behavior unknown',
                    'Call evidence or a dependency declaration exists, but sync/async behaviour has not been established.',
                  ],
                  [
                    'indirect',
                    'Async exposure',
                    'Impact may be delayed. Includes callers beyond the async boundary.',
                  ],
                  [
                    'insulated',
                    'Breaker on path',
                    'Protection is unverified. Includes callers beyond the breaker; check fallback behaviour.',
                  ],
                ] as const
              )
                .filter(([tier]) => (result.dependents[tier]?.length ?? 0) > 0)
                .map(([tier, title, description]) => (
                  <div key={tier}>
                    <h3 className="font-medium">
                      {title} ({result.dependents[tier]!.length})
                    </h3>
                    <p className="text-xs text-ink-muted">{description}</p>
                    <ul className="mt-1 space-y-1">
                      {result.dependents[tier]!.map((node) => (
                        <li key={node.subjectKey ?? node.name}>
                          <button
                            type="button"
                            onClick={() => onSelect(node.name, node.subjectKey)}
                            className="break-all text-accent underline"
                          >
                            {node.name}
                          </button>
                          <span className="text-xs text-ink-muted">
                            {' '}
                            · {node.hops} {node.hops === 1 ? 'hop' : 'hops'}
                            {node.team ? ` · ${node.team}` : ''}
                            {node.scope &&
                              Object.entries(node.scope)
                                .map(([key, value]) => ` · ${key}: ${value}`)
                                .join('')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
            {Object.values(result.dependents).every((nodes) => nodes.length === 0) && (
              <p className="mt-3 text-ink-muted">
                No callers are known from this evidence. This does not prove that no other service
                depends on it.
              </p>
            )}
            {result.suspects.length > 0 && (
              <div className="mt-3">
                <h3 className="font-medium">Dependencies to investigate</h3>
                <p className="text-xs text-ink-muted">Possible causes, not confirmed findings.</p>
                <ul>
                  {result.suspects.map((node) => (
                    <li key={node.subjectKey ?? node.name}>
                      <button
                        type="button"
                        className="sre-hit-target break-all text-accent underline"
                        onClick={() => onSelect(node.name, node.subjectKey)}
                      >
                        {node.name}
                      </button>
                      <span className="text-xs text-ink-muted">
                        {node.scope &&
                          Object.entries(node.scope)
                            .map(([key, value]) => ` · ${key}: ${value}`)
                            .join('')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="mt-3 text-info">
            {result.note ??
              'No unambiguous service identity is available for impact analysis. Check its scope and discovery evidence.'}
          </p>
        ))}
    </section>
  );
}
