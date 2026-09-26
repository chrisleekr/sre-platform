import { useState } from 'react';
import { config } from '../config';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import type { CredentialGetter } from '../lib/request-credentials';
import { checkResponse, RequestError, requestErrorMessage } from '../lib/request-error';
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
  if (!action) return <span>No active automation recorded</span>;
  return (
    <span>
      {action.description}
      {action.scheduledAt ? ` at ${formatAbsoluteTime(action.scheduledAt)}` : ''}
    </span>
  );
}

const RETRYABLE_ATTENTION = new Set(['investigation_degraded', 'investigation_failed']);
const ACTIVE_STATUSES = new Set(['open', 'mitigated']);

// 409 outcome codes from the retry and lifecycle routes. The server re-checks every gate, so these
// explain a refusal that raced a state change the workspace had not shown yet.
const CONFLICT_MESSAGES: Record<string, string> = {
  stale: 'Incident state changed. Review it and try again.',
  not_retryable:
    'This investigation can no longer be retried. The incident is closed or its investigation is no longer failed or degraded.',
  automation_pending:
    'Investigation work is already queued. Wait for it to finish before retrying.',
  invalid: 'The incident cannot be resolved from its current state.',
};
const DEFAULT_CONFLICT = CONFLICT_MESSAGES.stale!;

type OperatorAction = 'confirm' | 'retry';

/** The two one-click responder actions: confirm a Slack-reported recovery, or retry the run. */
function OperatorActions({
  workspace,
  getCredentials,
  onChanged,
}: {
  workspace: IncidentWorkspaceData;
  getCredentials: CredentialGetter;
  onChanged: () => void;
}) {
  const { incident } = workspace;
  const [pending, setPending] = useState<OperatorAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reports = workspace.providerRecoveryReports ?? [];
  const latestReport = reports.at(-1);
  const active = ACTIVE_STATUSES.has(incident.status);
  // The server lists a grouped report once per signal it covers, so coverage is a set check.
  const reported = new Set(reports.map((report) => report.signalId));
  const activeSignals = workspace.signals.filter((signal) => signal.state !== 'resolved');
  const canConfirm =
    Boolean(latestReport) &&
    active &&
    activeSignals.length > 0 &&
    activeSignals.every((signal) => reported.has(signal.id));
  const canRetry =
    active &&
    RETRYABLE_ATTENTION.has(incident.attentionReason ?? '') &&
    !incident.pendingAutomation;
  if (!canConfirm && !canRetry) return null;

  async function submit(action: OperatorAction) {
    if (pending) return;
    const request =
      action === 'confirm'
        ? {
            path: 'lifecycle',
            fallback: 'Resolution could not be confirmed.',
            // Slack text is advisory, so the audit reason names the operator as the resolution basis.
            fields: {
              to: 'resolved',
              reason: `Provider reported recovery in Slack at ${latestReport?.reportedAt}; confirmed by an operator.`,
            },
          }
        : { path: 'investigation/retry', fallback: 'Retry could not be started.', fields: {} };
    const { fallback } = request;
    setPending(action);
    setError(null);
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/incidents/${incident.id}/${request.path}`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...request.fields,
            requestId: crypto.randomUUID(),
            expectedVersion: incident.lifecycleVersion,
          }),
        },
      );
      if (response.status === 409) {
        onChanged();
        const body: unknown = await response.json().catch(() => null);
        const code =
          body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
        throw new RequestError(
          typeof code === 'string' && Object.hasOwn(CONFLICT_MESSAGES, code)
            ? CONFLICT_MESSAGES[code]!
            : DEFAULT_CONFLICT,
          409,
        );
      }
      await checkResponse(response, fallback);
      onChanged();
    } catch (caught) {
      setError(requestErrorMessage(caught, fallback));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        {canConfirm && (
          <button
            type="button"
            className="sre-action sre-action-primary"
            disabled={pending !== null}
            onClick={() => void submit('confirm')}
          >
            {pending === 'confirm' ? 'Confirming…' : 'Confirm resolved'}
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            className="sre-action"
            disabled={pending !== null}
            onClick={() => void submit('retry')}
          >
            {pending === 'retry' ? 'Retrying…' : 'Retry investigation'}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

/** Explicit responder handoff and the policy that governs the platform's next action. */
export function IncidentOperatorPanel({
  workspace,
  showTeam = true,
  getCredentials,
  onChanged,
}: {
  workspace: IncidentWorkspaceData;
  showTeam?: boolean;
  /** Enables the responder actions; omitted where the panel is read-only. */
  getCredentials?: CredentialGetter;
  onChanged?: () => void;
}) {
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
          {/* The body is the one statement of automation; a work label here could contradict it. */}
          {attention ? 'Human decision required' : 'No human decision required'}
        </p>
        {attention ? (
          <dl className="mt-3 space-y-3 text-sm">
            <div>
              <dt className="font-semibold text-warning">Decision</dt>
              <dd className="mt-0.5 text-ink">{attention.decision}</dd>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {showTeam && (
                <div>
                  <dt className="font-semibold text-warning">Service team</dt>
                  <dd>{attention.owner ?? 'Team not established'}</dd>
                </div>
              )}
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
        {getCredentials && onChanged && (
          <OperatorActions
            workspace={workspace}
            getCredentials={getCredentials}
            onChanged={onChanged}
          />
        )}
      </div>

      <details className="rounded-lg border border-line bg-surface p-4">
        <summary className="min-h-11 cursor-pointer text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Automation policy
        </summary>
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
      </details>
    </section>
  );
}
