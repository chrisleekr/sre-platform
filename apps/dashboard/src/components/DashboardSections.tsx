import { Link } from 'react-router-dom';
import type { ConnectorSummary } from '../lib/connectors';
import type { InfraHealth } from '../lib/infrastructure';
import { incidentPath } from '../lib/routes';
import { incidentDisplayTitle } from '../lib/incidentTitle';
import { formatAbsoluteTime, relativeTime } from '../lib/time';
import type { Deployment, Incident, InfraSnapshot } from '../lib/types';
import { SignalSpine, type SignalFacet } from './SignalSpine';
import { incidentSignalFacet } from './incidentSignalFacet';

export const OPEN_QUEUE_LIMIT = 100;
export const DASHBOARD_ROW_LIMIT = 5;
export const CHANGE_WINDOW_MS = 24 * 60 * 60 * 1_000;

const SEVERITY_TONE: Record<string, string> = {
  sev1: 'bg-critical-muted text-critical',
  sev2: 'bg-warning-muted text-warning',
  sev3: 'bg-info-muted text-info',
};

const HEALTH_TONE: Record<InfraHealth, string> = {
  error: 'bg-critical-muted text-critical',
  attention: 'bg-warning-muted text-warning',
  stale: 'bg-warning-muted text-warning',
  healthy: 'bg-success-muted text-success',
};

export const HEALTH_ORDER: Record<InfraHealth, number> = {
  error: 0,
  attention: 1,
  stale: 2,
  healthy: 3,
};

function compact(value: string, length = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > length ? `${normalized.slice(0, length - 1)}…` : normalized;
}

function incidentAction(incident: Incident): string {
  if (incident.requiresHumanAttention) {
    if (incident.attentionReason === 'approval_pending') return 'Approval requested';
    if (incident.attentionReason === 'recovery_not_verified') return 'Verify recovery';
    if (incident.attentionReason === 'resolution_required') return 'Complete resolution';
    if (incident.attentionReason === 'manual_review') return 'Review investigation';
    if (incident.attentionReason === 'investigation_degraded')
      return 'Investigation needs human help';
    if (incident.attentionReason === 'investigation_inconclusive') return 'Choose next check';
    if (incident.attentionReason === 'investigation_blocked') return 'Provide missing capability';
    if (incident.attentionReason === 'budget_exhausted') return 'Continue manually';
    if (incident.attentionReason === 'investigation_failed') return 'Retry or investigate manually';
    return 'Human attention required';
  }
  if (incident.status === 'open') return 'SRE Platform handling';
  if (incident.investigationStatus === 'degraded') return 'Investigation needs human help';
  if (
    (incident.activeSignalCount ?? incident.signalCount ?? 0) === 0 &&
    incident.recoveryState === 'not_verified'
  )
    return 'Verify recovery';
  if (incident.recoveryState === 'verifying') return 'Recovery verification running';
  if (incident.recoveryState === 'monitoring') return 'Recovery monitoring scheduled';
  if (incident.status === 'mitigated') return 'Confirm resolution';
  if (incident.investigationStatus === 'assessed') return 'Review assessment';
  return 'Investigation in progress';
}

export function connectorIssue(connector: ConnectorSummary): string | null {
  if (!connector.enabled) return 'Disabled';
  if (connector.capabilities?.availability === 'incomplete') return 'Setup incomplete';
  const failure =
    connector.verification?.failureCategory ??
    connector.polling?.failureCategory ??
    connector.events?.failureCategory;
  if (failure) return failure.replaceAll('_', ' ');
  if (connector.verification && !connector.verification.lastSuccessAt) return 'Not verified';
  if (
    connector.capabilities?.events === 'authenticated' &&
    (!connector.events || !connector.events.lastSuccessAt)
  )
    return 'Event delivery not verified';
  return null;
}

export function SectionHeader({
  id,
  title,
  description,
  href,
  linkLabel,
}: {
  id: string;
  title: string;
  description: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 id={id} className="text-base font-semibold text-ink">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
      </div>
      <Link to={href} className="text-sm font-semibold text-info hover:text-info">
        {linkLabel} →
      </Link>
    </div>
  );
}

export function IncidentQueue({ incidents }: { incidents: Incident[] }) {
  if (incidents.length === 0) {
    return (
      <p className="rounded-md bg-success-soft p-4 text-sm text-success">No active incidents.</p>
    );
  }
  return (
    <ol className="space-y-2" aria-label="Highest-priority active incidents">
      {incidents.slice(0, DASHBOARD_ROW_LIMIT).map((incident, index) => {
        const updatedAt = incident.updatedAt ?? incident.createdAt;
        const facets: readonly SignalFacet[] = [
          incidentSignalFacet(incident),
          {
            label:
              incident.investigationStatus === 'assessed'
                ? 'Assessment ready'
                : incident.investigationStatus === 'degraded'
                  ? 'Investigation needs human help'
                  : 'Investigation in progress',
            tone:
              incident.investigationStatus === 'assessed'
                ? 'assessment'
                : incident.investigationStatus === 'degraded'
                  ? 'critical'
                  : 'info',
          },
          {
            label: incident.requiresHumanAttention
              ? 'Human attention required'
              : 'SRE Platform handling',
            tone: incident.requiresHumanAttention ? 'warning' : 'info',
          },
        ];
        return (
          <li key={incident.id}>
            <Link
              to={incidentPath(incident.id)}
              className="grid min-w-0 grid-cols-[2.25rem_0.375rem_minmax(0,1fr)] gap-3 rounded-lg border border-line bg-surface p-3 shadow-sm transition hover:-translate-y-px hover:border-line-strong hover:shadow"
            >
              <span className="font-instrument text-sm font-semibold tabular-nums text-ink-faint">
                {String(index + 1).padStart(2, '0')}
              </span>
              <SignalSpine facets={facets} />
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${SEVERITY_TONE[incident.severity] ?? 'bg-surface-strong text-ink-secondary'}`}
                  >
                    {incident.severity}
                  </span>
                  <span className="text-xs font-semibold text-ink-secondary">
                    {incidentAction(incident)}
                  </span>
                  <time
                    dateTime={updatedAt}
                    title={formatAbsoluteTime(updatedAt)}
                    className="ml-auto font-instrument text-xs text-ink-muted"
                  >
                    {relativeTime(updatedAt, Date.now())}
                  </time>
                </div>
                <h3 className="mt-2 break-words text-sm font-semibold text-ink">
                  {incidentDisplayTitle(incident)}
                </h3>
                <p className="mt-1 font-instrument text-xs text-ink-muted">
                  {incident.service} · {incident.alertSource}
                </p>
                <p className="mt-2 break-words text-sm text-ink-secondary">
                  {incident.rcaSummary
                    ? compact(incident.rcaSummary)
                    : incident.nextStep
                      ? `Next check: ${compact(incident.nextStep)}`
                      : 'Assessment pending.'}
                </p>
              </div>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

export function InfrastructureExceptions({
  rows,
}: {
  rows: Array<{ snapshot: InfraSnapshot; health: InfraHealth }>;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md bg-success-soft p-4 text-sm text-success">
        No current infrastructure exceptions.
      </p>
    );
  }
  return (
    <ul className="space-y-2" aria-label="Infrastructure exceptions">
      {rows.slice(0, DASHBOARD_ROW_LIMIT).map(({ snapshot, health }) => (
        <li
          key={`${snapshot.dataSourceId}:${snapshot.entityId}`}
          className="rounded-lg border border-line bg-surface p-3 text-sm"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${HEALTH_TONE[health]}`}
            >
              {health === 'attention' ? 'Needs attention' : health}
            </span>
            <strong className="min-w-0 break-words text-ink">{snapshot.entityId}</strong>
            <time
              dateTime={snapshot.observedAt}
              title={formatAbsoluteTime(snapshot.observedAt)}
              className="ml-auto text-xs text-ink-muted"
            >
              {relativeTime(snapshot.observedAt, Date.now())}
            </time>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {snapshot.dataSourceName} · {snapshot.namespace ?? snapshot.source}
          </p>
          {snapshot.error && (
            <p className="mt-2 break-words text-xs text-critical">{snapshot.error}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function CorrelatedChanges({
  rows,
}: {
  rows: Array<{ deployment: Deployment; incidents: Incident[] }>;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md bg-surface-subtle p-4 text-sm text-ink-muted">
        No same-service deployment falls within 24 hours of an active incident.
      </p>
    );
  }
  return (
    <ul className="space-y-2" aria-label="Changes near active incidents">
      {rows.slice(0, DASHBOARD_ROW_LIMIT).map(({ deployment, incidents }) => (
        <li
          key={`${deployment.source}:${deployment.repo}:${deployment.providerId ?? deployment.sha}:${deployment.deployedAt}`}
          className="rounded-lg border border-line bg-surface p-3 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${['failed', 'failure', 'error'].includes(deployment.status) ? 'bg-critical-muted text-critical' : 'bg-surface-strong text-ink-secondary'}`}
            >
              {deployment.status}
            </span>
            <strong className="break-words text-ink">
              {deployment.service ?? deployment.repo}
            </strong>
          </div>
          <p className="mt-1 break-words text-xs text-ink-muted">
            {deployment.dataSourceName} · {deployment.ref} ·{' '}
            {relativeTime(deployment.deployedAt, Date.now())}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {incidents.map((incident) => (
              <Link
                key={incident.id}
                to={incidentPath(incident.id)}
                className="text-xs font-semibold text-info hover:text-info"
              >
                {incidentDisplayTitle(incident)} →
              </Link>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}
