import type { CredentialGetter } from '../lib/request-credentials';
import { useFetchResource } from '../lib/useFetchResource';
import { budgetLabel } from '../lib/budget-format';
import { formatAbsoluteTime } from '../lib/time';
import type { SloRow } from '../lib/slo-types';

type Objective = Pick<
  SloRow,
  'name' | 'target' | 'windowDays' | 'lastEvaluationError' | 'evaluation'
> & { metricQuery: string | null; connectorType: string | null };
const empty: Objective[] = [];
const select = (body: unknown) => (body as { objectives: Objective[] }).objectives;

/** Show measured reliability separately from runtime readiness and possible dependency exposure. */
export function TopologyReliability({
  service,
  apiBaseUrl,
  getCredentials,
}: {
  service: string;
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
}) {
  const { data, loading, error, backgroundError } = useFetchResource({
    apiBaseUrl,
    getCredentials,
    path: `/topology/services/${encodeURIComponent(service)}/reliability`,
    initial: empty,
    select,
    pollMs: 60_000,
  });
  return (
    <section className="mb-4" aria-label="Measured service reliability">
      <h3 className="text-xs font-semibold uppercase text-ink-faint">Service reliability</h3>
      <p className="mt-1 text-xs text-ink-muted">
        Each objective's query defines its environment scope. The topology filter does not change
        that query.
      </p>
      {loading && <p className="mt-2 text-xs">Loading objective evidence…</p>}
      {(error || backgroundError) && (
        <p role="alert" className="mt-2 text-xs text-warning">
          Objective evidence could not be refreshed. Any figures below are from the last successful
          read.
        </p>
      )}
      {!loading && !error && data.length === 0 && (
        <p className="mt-2 text-xs">
          No enabled objectives are configured for this service. Availability and latency are not
          established by pod health.
        </p>
      )}
      {data.map((objective) => (
        <details key={objective.name} className="mt-2 rounded border border-line p-2 text-xs">
          <summary className="cursor-pointer font-medium">{objective.name}</summary>
          <p className="mt-1">
            Target{' '}
            {(objective.target * 100).toLocaleString(undefined, { maximumFractionDigits: 5 })}% over{' '}
            {objective.windowDays} days
          </p>
          {objective.evaluation ? (
            <>
              <p>
                {budgetLabel(objective.evaluation.budgetRemaining)} · burn{' '}
                {objective.evaluation.burnRate.toFixed(2)}×
              </p>
              <p>Measured {formatAbsoluteTime(objective.evaluation.computedAt)}</p>
              {Date.now() - Date.parse(objective.evaluation.computedAt) > 15 * 60_000 && (
                <p className="text-warning">
                  Evaluation is stale. Do not treat this as current reliability.
                </p>
              )}
            </>
          ) : (
            <p>Not evaluated yet.</p>
          )}
          {objective.lastEvaluationError && (
            <p className="text-warning">Evaluation failed: {objective.lastEvaluationError}</p>
          )}
          <p className="mt-2">SLI query · {objective.connectorType ?? 'backend unavailable'}</p>
          <pre className="mt-1 whitespace-pre-wrap break-all">
            {objective.metricQuery ?? 'Query unavailable'}
          </pre>
        </details>
      ))}
      <a href="/w/error-budgets" className="mt-2 inline-block text-xs text-info underline">
        Open error budgets
      </a>
    </section>
  );
}
