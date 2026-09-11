import { HIGH_RISK_BUDGET_THRESHOLD } from '@sre/contracts';
import { useSession } from '../auth';
import { config } from '../config';
import { budgetLabel, formatPercent } from '../lib/budget-format';
import { formatAbsoluteTime, relativeTime } from '../lib/time';
import type { SloEvaluation, SloRow } from '../lib/types';
import { useSloStatus } from '../lib/useSloStatus';
import { PageHeader } from './PageHeader';
import { InlineAlert, StatePanel } from './PageState';

// The Error budgets panel reports. Every figure resolves to a stored burn event computed from an SLI
// query the operator wrote, and nothing here acts on a burning budget: there is deliberately no
// control that opens an incident, pages a responder or blocks a deploy.

// The evaluator recomputes every five minutes and writes no burn event when a run fails, so a broken
// objective keeps serving its last result forever. Three cadences is past any single late or missed
// run, which makes it the point where "arriving late" stops being the likely explanation.
const EVALUATION_CADENCE_MS = 5 * 60_000;
const STALE_EVALUATION_MS = 3 * EVALUATION_CADENCE_MS;

// Three states, each carried by its own word. Colour is the secondary cue, never the only one, so the
// difference between a nearly spent budget and a healthy one survives a monochrome or colour-blind read.
const BUDGET_STATES = {
  healthy: { label: 'Healthy', className: 'bg-success-muted text-success' },
  atRisk: { label: 'At risk', className: 'bg-warning-muted text-warning' },
  over: { label: 'Over budget', className: 'bg-critical-muted text-critical' },
} as const;

function budgetState(remaining: number): (typeof BUDGET_STATES)[keyof typeof BUDGET_STATES] {
  if (remaining < 0) return BUDGET_STATES.over;
  return remaining < HIGH_RISK_BUDGET_THRESHOLD ? BUDGET_STATES.atRisk : BUDGET_STATES.healthy;
}

/** The figures of one evaluated objective. Rendered only once an evaluation exists. */
function BudgetFigures({ evaluation, now }: { evaluation: SloEvaluation; now: number }) {
  const state = budgetState(evaluation.budgetRemaining);
  const stale = now - Date.parse(evaluation.computedAt) > STALE_EVALUATION_MS;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1">
      <span className={`w-fit rounded-full px-2 py-0.5 text-xs font-semibold ${state.className}`}>
        {state.label}
      </span>
      <p className="text-sm font-semibold text-ink">{budgetLabel(evaluation.budgetRemaining)}</p>
      <p className="text-sm text-ink-secondary">
        {evaluation.burnRate.toFixed(1)}x burn over {evaluation.burnWindow}
      </p>
      <p className="text-sm text-ink-muted">
        {evaluation.exhaustionDays === null
          ? 'No projected exhaustion'
          : `${evaluation.exhaustionDays.toFixed(1)} days to exhaustion`}
      </p>
      <p className="text-sm text-ink-muted">
        Evaluated{' '}
        <time dateTime={evaluation.computedAt} title={formatAbsoluteTime(evaluation.computedAt)}>
          {relativeTime(evaluation.computedAt, now)}
        </time>
      </p>
      {stale && (
        // The word is the state, so a responder reading in monochrome still sees that the figures
        // beside it stopped moving.
        <span className="w-fit rounded-full bg-warning-muted px-2 py-0.5 text-xs font-semibold text-warning">
          Stale
        </span>
      )}
    </div>
  );
}

/**
 * The reason the last evaluation attempt failed. Shown verbatim because the operator wrote the query
 * and owns the backend that rejected it: the message is the actionable half, and paraphrasing it would
 * leave them with the same silence this replaces.
 *
 * @remarks Warning tones, not critical: on this panel critical already means over budget, and a
 * failure to measure must not read as a spent budget. The wording carries the state either way.
 */
function EvaluationFailure({
  message,
  since,
  now,
}: {
  message: string;
  since: string | null;
  now: number;
}) {
  return (
    <p className="mt-3 rounded-md border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning">
      <span className="font-semibold">Evaluation failing</span>
      {since !== null && (
        <>
          {' '}
          since{' '}
          <time dateTime={since} title={formatAbsoluteTime(since)}>
            {relativeTime(since, now)}
          </time>
        </>
      )}
      : {message}
    </p>
  );
}

function BudgetRow({ slo, now }: { slo: SloRow; now: number }) {
  const evaluation = slo.evaluation;
  return (
    <li className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-ink">{slo.name}</p>
        <p className="text-sm text-ink-secondary">{slo.service}</p>
        <p className="text-xs text-ink-muted">
          {slo.sliType} target {formatPercent(slo.target)} over {slo.windowDays}d
        </p>
        {!slo.enabled && (
          <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-xs font-semibold text-ink-muted">
            Disabled
          </span>
        )}
      </div>
      {evaluation === null ? (
        <p className="mt-3 text-sm text-ink-muted">Awaiting first evaluation</p>
      ) : (
        <BudgetFigures evaluation={evaluation} now={now} />
      )}
      {/* Rendered alongside the figures, not instead of them: a failing objective keeps serving its
          last good result, and the responder needs to see both the number and that it stopped moving. */}
      {slo.lastEvaluationError !== null && (
        <EvaluationFailure
          message={slo.lastEvaluationError}
          since={slo.evaluationFailingSince}
          now={now}
        />
      )}
    </li>
  );
}

/** The Error budgets panel: every objective the tenant owns with its latest evaluation. */
export function ErrorBudgetsPanel() {
  const { getCredentials } = useSession();
  const { slos, loading, error, errorStatus, backgroundError } = useSloStatus({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  });
  const blockingError = error && !backgroundError;
  const accessDenied = blockingError && errorStatus === 403;
  const now = Date.now();

  return (
    <section>
      <PageHeader
        title="Error budgets"
        description="Each objective is measured by a query you wrote against your own metrics backend. The platform reports what it measures and acts on none of it."
      />
      {loading && !blockingError && (
        <StatePanel state="loading" title="Loading error budgets…" skeleton="list" />
      )}
      {blockingError && (
        <StatePanel
          state={accessDenied ? 'access' : 'error'}
          title={accessDenied ? 'No tenant access.' : 'Failed to load error budgets.'}
          description={
            accessDenied
              ? 'This signed-in account must be assigned to exactly one tenant. Use an account with tenant access or ask an administrator to assign it.'
              : 'Objective status could not be retrieved. The page will retry automatically.'
          }
        />
      )}
      {!loading && backgroundError && (
        <InlineAlert message="Live refresh failed. Showing the last successful evaluation." />
      )}
      {!loading && !blockingError && slos.length === 0 && (
        <StatePanel
          state="empty"
          title="No error budgets yet."
          description="An objective names a service, a target and a window, and the query that measures it. This tenant has none defined yet, so there is nothing to measure."
        />
      )}
      {!loading && !blockingError && slos.length > 0 && (
        <ul className="space-y-3">
          {slos.map((slo) => (
            <BudgetRow key={slo.id} slo={slo} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}
