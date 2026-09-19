import type { Deployment, DeployStatus } from '../lib/types';
import { budgetLabel } from '../lib/budget-format';
import { formatAbsoluteTime, relativeTime } from '../lib/time';
import { deploymentKey } from './DeploymentEvidenceTimeline';
import { StatePanel } from './PageState';
import {
  investigationSubjectKey,
  type InvestigationDeclaration,
  type InvestigationSubject,
} from '../lib/investigations';
import { InvestigationAction } from './InvestigationAction';

const STATUS_BADGE: Record<DeployStatus, string> = {
  success: 'bg-success-muted text-success',
  failed: 'bg-critical-muted text-critical',
  failure: 'bg-critical-muted text-critical',
  error: 'bg-critical-muted text-critical',
  running: 'bg-info-muted text-info',
  pending: 'bg-surface-strong text-ink-muted',
  blocked: 'bg-warning-muted text-warning',
  canceled: 'bg-surface-strong text-ink-muted',
  inactive: 'bg-surface-strong text-ink-muted',
};

/** Most-recent-first by deploy time. */
function byNewest(a: Deployment, b: Deployment): number {
  return Date.parse(b.deployedAt) - Date.parse(a.deployedAt);
}

// Only link http(s) deploy URLs. A `javascript:`/`data:` URL (the connector data is external) would
// execute on click — React does not sanitize href — so anything else renders as plain text (XSS guard).
function isHttpUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Presentational view of recent deployments, each with a pipeline status badge. */
export function DeploymentsList({
  deployments,
  selectedKey,
  onSelect,
  activeInvestigations,
  declareInvestigation,
}: {
  deployments: Deployment[];
  selectedKey?: string;
  onSelect?: (deployment: Deployment) => void;
  activeInvestigations?: Map<string, string>;
  declareInvestigation?: (subject: InvestigationSubject) => Promise<InvestigationDeclaration>;
}) {
  if (deployments.length === 0) {
    return (
      <StatePanel
        state="empty"
        title="No deployments yet."
        description="Deployment activity from connected repositories will appear here."
      />
    );
  }
  const now = Date.now();
  const hasEnvironment = deployments.some((deployment) => Boolean(deployment.environment));
  // Advisory only: the column appears when at least one row was stamped, so a tenant with no
  // objectives sees the table unchanged. The platform reports budget risk; it never gates a deploy.
  const hasBudget = deployments.some(
    (deployment) => typeof deployment.budgetRemaining === 'number',
  );
  const cellClass =
    'grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-2 break-words py-1 before:text-xs before:font-medium before:text-ink-muted before:content-[attr(data-label)] sm:table-cell sm:px-2 sm:py-2 sm:align-top sm:before:hidden';

  return (
    <ul className="list-none">
      <li>
        <table className="block w-full table-fixed border-separate border-spacing-0 sm:table">
          <thead className="hidden sm:table-header-group">
            <tr className="text-left text-xs text-ink-muted">
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Service</th>
              <th className="px-2 py-2 font-medium">Provider target</th>
              {hasEnvironment && <th className="px-2 py-2 font-medium">Environment</th>}
              {hasBudget && <th className="px-2 py-2 font-medium">Budget</th>}
              <th className="px-2 py-2 font-medium">Revision</th>
              <th className="px-2 py-2 font-medium">Source</th>
              <th className="px-2 py-2 font-medium">Deployed</th>
              {onSelect && <th className="px-2 py-2 font-medium">Evidence</th>}
              {declareInvestigation && <th className="px-2 py-2 font-medium">Investigation</th>}
            </tr>
          </thead>
          <tbody className="block sm:table-row-group">
            {[...deployments].sort(byNewest).map((deployment) => {
              const subject: InvestigationSubject | null = deployment.id
                ? { kind: 'deployment', deploymentId: deployment.id }
                : null;
              const actionable = ['failed', 'failure', 'error', 'canceled'].includes(
                deployment.status,
              );
              return (
                <tr
                  key={deploymentKey(deployment)}
                  className={`mb-3 grid min-w-0 gap-1 rounded-md border p-3 text-sm last:mb-0 sm:mb-0 sm:table-row sm:border-0 sm:p-0 ${
                    selectedKey === deploymentKey(deployment)
                      ? 'border-info-line bg-info-soft sm:bg-info-soft'
                      : 'border-line'
                  }`}
                >
                  <td data-label="Status" className={cellClass}>
                    {/* Unreachable under the type system (status is DeployStatus, STATUS_BADGE is total).
                      Keep the neutral fallback for an un-coerced connector token crossing the wire. */}
                    <span
                      className={`w-fit rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[deployment.status] ?? STATUS_BADGE.pending}`}
                    >
                      {deployment.status}
                    </span>
                    {deployment.operationPhase && (
                      <span className="mt-1 block text-xs text-ink-muted">
                        {deployment.operationPhase}
                      </span>
                    )}
                  </td>
                  <td data-label="Service" className={`${cellClass} font-medium`}>
                    {deployment.service ?? 'Unmapped'}
                  </td>
                  <td data-label="Provider target" className={`${cellClass} text-ink-secondary`}>
                    <span>
                      <span className="block break-words font-medium">{deployment.repo}</span>
                      <span className="mt-0.5 block break-words font-instrument text-xs text-ink-muted">
                        {deployment.ref || 'No ref reported'}
                      </span>
                    </span>
                  </td>
                  {hasEnvironment && (
                    <td data-label="Environment" className={`${cellClass} text-ink-muted`}>
                      {deployment.environment || 'Unavailable'}
                      {deployment.transientEnvironment && (
                        <span className="ml-1 rounded bg-assessment-muted px-1.5 py-0.5 text-xs font-medium text-assessment">
                          transient
                        </span>
                      )}
                    </td>
                  )}
                  {hasBudget && (
                    <td data-label="Budget" className={`${cellClass} text-ink-muted`}>
                      {typeof deployment.budgetRemaining === 'number' && (
                        <span>
                          <span className="block">{budgetLabel(deployment.budgetRemaining)}</span>
                          {deployment.highRisk && (
                            <span className="mt-1 block w-fit rounded bg-warning-muted px-1.5 py-0.5 text-xs font-medium text-warning">
                              High risk (advisory)
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  )}
                  <td data-label="Revision" className={`${cellClass} font-instrument text-xs`}>
                    {isHttpUrl(deployment.url) ? (
                      <a
                        href={deployment.url}
                        title={deployment.revisions?.join(', ') || deployment.sha}
                        className="break-words text-accent hover:underline"
                      >
                        {(deployment.revisions?.[0] ?? deployment.sha).slice(0, 12)}
                        {(deployment.revisions?.length ?? 0) > 1
                          ? ` +${deployment.revisions!.length - 1}`
                          : ''}
                      </a>
                    ) : (
                      <span
                        title={deployment.revisions?.join(', ') || deployment.sha}
                        className="break-words text-ink-muted"
                      >
                        {(deployment.revisions?.[0] ?? deployment.sha).slice(0, 12)}
                        {(deployment.revisions?.length ?? 0) > 1
                          ? ` +${deployment.revisions!.length - 1}`
                          : ''}
                      </span>
                    )}
                  </td>
                  <td data-label="Source" className={`${cellClass} text-ink-muted`}>
                    <span>
                      <span className="block">{deployment.dataSourceName}</span>
                      <span className="mt-0.5 block break-words text-xs text-ink-muted">
                        {deployment.source} · {deployment.actor || 'Actor not reported'}
                      </span>
                    </span>
                  </td>
                  <td data-label="Deployed" className={`${cellClass} text-ink-muted`}>
                    <span className="min-w-0">
                      <time
                        dateTime={deployment.deployedAt}
                        title={formatAbsoluteTime(deployment.deployedAt)}
                      >
                        {relativeTime(deployment.deployedAt, now)}
                      </time>
                      <span className="mt-0.5 block break-words text-xs text-ink-muted">
                        {formatAbsoluteTime(deployment.deployedAt)}
                      </span>
                    </span>
                  </td>
                  {onSelect && (
                    <td data-label="Evidence" className={cellClass}>
                      <button
                        type="button"
                        onClick={() => onSelect(deployment)}
                        className="sre-action w-fit text-xs text-accent"
                      >
                        Inspect
                      </button>
                    </td>
                  )}
                  {declareInvestigation && (
                    <td data-label="Investigation" className={cellClass}>
                      {subject && actionable ? (
                        <InvestigationAction
                          subject={subject}
                          activeIncidentId={activeInvestigations?.get(
                            investigationSubjectKey(subject),
                          )}
                          preview={{
                            title: `Deployment failed: ${deployment.service ?? deployment.repo}`,
                            source: `${deployment.dataSourceName} · ${deployment.repo}`,
                            condition: `${deployment.status} · ${(deployment.revisions?.[0] ?? deployment.sha).slice(0, 12)}`,
                            severity: 'SEV3',
                          }}
                          declareInvestigation={declareInvestigation}
                        />
                      ) : null}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </li>
    </ul>
  );
}
