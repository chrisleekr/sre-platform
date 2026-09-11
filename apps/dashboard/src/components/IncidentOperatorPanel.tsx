import { formatAbsoluteTime } from '../lib/time';
import type { IncidentWorkspaceData } from '../lib/types';

type Budget = NonNullable<NonNullable<IncidentWorkspaceData['automation']>['currentBudget']>;

function budgetScopeLabel(scope: Budget['tenant']): string {
  const runs =
    scope.runLimit === 0 ? `${scope.runs} runs` : `${scope.runs} / ${scope.runLimit} runs`;
  const cost =
    scope.configuredCostLimitUsd === 0
      ? `$${scope.configuredCostUsd.toFixed(2)}`
      : `$${scope.configuredCostUsd.toFixed(2)} / $${scope.configuredCostLimitUsd.toFixed(2)}`;
  return `${runs} · ${cost}`;
}

function accountingWarning(scope: Budget['tenant']): string | null {
  const warnings = [
    scope.pendingCostRuns > 0 ? `${scope.pendingCostRuns} pending cost` : null,
    scope.missingUsageRuns > 0 ? `${scope.missingUsageRuns} missing usage` : null,
    scope.unpricedRuns > 0 ? `${scope.unpricedRuns} unpriced` : null,
  ].filter(Boolean);
  return warnings.length > 0 ? warnings.join(' · ') : null;
}

const EXHAUSTION_LABELS: Record<string, string> = {
  incident_run_pending: 'An investigation run is already active',
  configured_cost_unavailable: 'Model pricing is unavailable',
  tenant_run_limit: 'Tenant run limit reached',
  monitor_run_limit: 'Monitor run limit reached',
  tenant_configured_cost_limit: 'Tenant cost limit reached',
  monitor_configured_cost_limit: 'Monitor cost limit reached',
  tenant_configured_cost_pending: 'Tenant cost is still pending',
  monitor_configured_cost_pending: 'Monitor cost is still pending',
  tenant_missing_usage: 'Tenant usage is incomplete',
  monitor_missing_usage: 'Monitor usage is incomplete',
  tenant_unpriced_usage: 'Tenant usage is unpriced',
  monitor_unpriced_usage: 'Monitor usage is unpriced',
};

function AutomationValue({
  action,
}: {
  action: { description: string; scheduledAt: string | null } | null;
}) {
  if (!action) return <span>No automation remains.</span>;
  return (
    <span>
      {action.description}
      {action.scheduledAt ? ` at ${formatAbsoluteTime(action.scheduledAt)}` : ''}
    </span>
  );
}

/** Explicit responder handoff and the policy that governs the platform's next action. */
export function IncidentOperatorPanel({ workspace }: { workspace: IncidentWorkspaceData }) {
  const { attention, automation } = workspace;
  const budget = automation?.currentBudget;
  if (!attention && !automation) return null;
  return (
    <section className="grid min-w-0 gap-3 lg:grid-cols-2" aria-label="Response handoff and policy">
      <div
        className={`rounded-lg border p-4 ${
          attention ? 'border-warning-line bg-warning-soft' : 'border-success-line bg-success-soft'
        }`}
      >
        <p
          className={`text-xs font-semibold uppercase tracking-wide ${attention ? 'text-warning' : 'text-success'}`}
        >
          {attention ? 'Human decision required' : 'SRE Platform handling'}
        </p>
        {attention ? (
          <dl className="mt-3 space-y-3 text-sm">
            <div>
              <dt className="font-semibold text-warning">Decision</dt>
              <dd className="mt-0.5 text-ink">{attention.decision}</dd>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-warning">Responsible owner</dt>
                <dd className="mt-0.5 text-ink">{attention.owner ?? 'Owner not resolved'}</dd>
              </div>
              <div>
                <dt className="font-semibold text-warning">Next automation</dt>
                <dd className="mt-0.5 text-ink">
                  <AutomationValue action={attention.nextAutomation} />
                </dd>
              </div>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-success">
            <AutomationValue action={automation?.nextAction ?? null} />
          </p>
        )}
      </div>

      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Automation policy
        </p>
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-ink-secondary">Episode boundary</dt>
            <dd className="mt-0.5 text-ink">
              {automation?.episodeExpiresAt
                ? `New matching alerts stop joining this episode after ${formatAbsoluteTime(automation.episodeExpiresAt)}.`
                : 'No provider episode boundary is recorded.'}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-ink-secondary">Automatic investigation budget</dt>
            <dd className="mt-0.5 break-words text-ink">
              {budget
                ? `Tenant · ${budgetScopeLabel(budget.tenant)}`
                : 'Unavailable in this runtime.'}
            </dd>
            {budget && accountingWarning(budget.tenant) && (
              <p className="mt-1 text-xs font-semibold text-warning">
                Accounting: {accountingWarning(budget.tenant)}
              </p>
            )}
            {budget && budget.monitors.length > 0 && (
              <details className="mt-2 text-xs text-ink-secondary">
                <summary className="cursor-pointer font-semibold">
                  {budget.monitors.length} monitor{' '}
                  {budget.monitors.length === 1 ? 'scope' : 'scopes'}
                </summary>
                <ul className="mt-2 space-y-1">
                  {budget.monitors.map((monitor) => (
                    <li key={monitor.monitorKey} className="break-all">
                      <span className="font-medium text-ink">{monitor.monitorKey}</span>
                      {` · ${budgetScopeLabel(monitor)}`}
                      {accountingWarning(monitor) ? ` · ${accountingWarning(monitor)}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {budget && budget.exhaustedBy.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1">
                {budget.exhaustedBy.map((reason) => (
                  <li
                    key={reason}
                    className="rounded-full bg-warning-muted px-2 py-0.5 text-xs font-semibold text-warning"
                  >
                    {EXHAUSTION_LABELS[reason] ?? reason.replaceAll('_', ' ')}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </dl>
      </div>
    </section>
  );
}
