import { InvestigationResult } from './InvestigationResult';
import { Link } from 'react-router-dom';
import type { Incident } from '../lib/types';
import { incidentDisplayTitle } from '../lib/incidentTitle';
import { incidentPath } from '../lib/routes';
import { formatAbsoluteTime, futureRelativeTime, relativeTime } from '../lib/time';
import {
  investigationRunOperationLabel,
  investigationRunOutcomeLabel,
  investigationRunTriggerLabel,
} from '../lib/investigationRuns';
import { StatePanel } from './PageState';
import { SignalSpine, type SignalFacet } from './SignalSpine';
import { incidentSignalFacet } from './incidentSignalFacet';

const severityClass: Record<string, string> = {
  sev1: 'border-critical-line bg-critical-soft text-critical',
  sev2: 'border-warning-line bg-warning-soft text-warning',
  sev3: 'border-info-line bg-info-soft text-info',
};

const investigationLabel = {
  queued: 'SRE queued',
  gathering: 'SRE investigating',
  assessed: 'Assessment ready',
  degraded: 'Needs human help',
} as const;

function lifecycleLabel(incident: Incident): string {
  if (incident.purpose === 'health_check')
    return incident.status === 'closed' ? 'Health check completed' : 'Health check';
  if (incident.status === 'open')
    return incident.requiresHumanAttention ? 'Needs human' : 'SRE Platform handling';
  if (incident.status === 'mitigated') return 'Mitigated';
  if (incident.status === 'resolved' && incident.resolutionBasis === 'provider_clear')
    return 'Resolved from provider signals';
  if (incident.status === 'resolved') return 'Resolved';
  if (incident.status === 'closed') return 'Closed';
  return incident.status;
}

const attentionReasonLabel: Record<NonNullable<Incident['attentionReason']>, string> = {
  operator_decision: 'Decision needed',
  automation_missing: 'No automation recorded',
  approval_pending: 'Approval requested',
  investigation_degraded: 'Investigation blocked',
  recovery_not_verified: 'Recovery uncertain',
  resolution_required: 'Complete resolution',
  manual_review: 'Review requested investigation',
  signal_tracking_unavailable: 'Signal tracking unavailable',
  mitigation_active: 'Mitigation active',
  investigation_inconclusive: 'Investigation inconclusive',
  investigation_blocked: 'Missing capability',
  budget_exhausted: 'Automatic budget exhausted',
  investigation_failed: 'Investigation failed',
  severity_requires_human: 'Severity requires human',
};

function signalLabel(incident: Incident): string | null {
  if (incident.resolutionBasis === 'provider_clear') return 'Health not independently verified';
  if (incident.signalCount === undefined) return null;
  if (incident.alertSource === 'manual' && incident.signalCount === 0) return null;
  if (incident.signalCount === 0) return 'Signal tracking unavailable';
  const active = incident.activeSignalCount ?? incident.signalCount;
  if (active === 0) {
    if (incident.recoveryState === 'verified') return 'Recovery verified';
    if (incident.recoveryState === 'verifying') return 'Verifying recovery';
    if (incident.recoveryState === 'monitoring')
      return `Monitoring recovery${incident.recoveryAttempt && incident.recoveryMaxChecks ? ` ${incident.recoveryAttempt}/${incident.recoveryMaxChecks}` : ''}`;
    if (incident.recoveryState === 'not_verified') return 'Recovery not verified';
    return 'All signals clear';
  }
  return `${active} unresolved notification${active === 1 ? '' : 's'}`;
}

function excerpt(value: string, length = 280): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

function responseOrderedIncidents(
  incidents: Incident[],
): Array<{ incident: Incident; depth: number }> {
  const byId = new Map(incidents.map((incident) => [incident.id, incident]));
  const children = new Map<string, Incident[]>();
  for (const incident of incidents) {
    if (!incident.causalParentId || !byId.has(incident.causalParentId)) continue;
    const rows = children.get(incident.causalParentId) ?? [];
    rows.push(incident);
    children.set(incident.causalParentId, rows);
  }
  const ordered: Array<{ incident: Incident; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (incident: Incident, depth: number): void => {
    if (visited.has(incident.id)) return;
    visited.add(incident.id);
    ordered.push({ incident, depth });
    for (const child of children.get(incident.id) ?? []) visit(child, depth + 1);
  };
  for (const incident of incidents)
    if (!incident.causalParentId || !byId.has(incident.causalParentId)) visit(incident, 0);
  for (const incident of incidents) visit(incident, 0);
  return ordered;
}

/**
 * Decision-focused incident queue. Rows arrive in the chosen sort order; a causal symptom is nested
 * under its direct cause whatever the sort, so the causal chain stays readable. Channel is provenance,
 * not grouping.
 */
export function IncidentsList({ incidents }: { incidents: Incident[] }) {
  const visibleIncidents = incidents.filter((incident) => !incident.archivedAt);
  const incidentById = new Map(visibleIncidents.map((incident) => [incident.id, incident]));
  const orderedIncidents = responseOrderedIncidents(visibleIncidents);
  if (visibleIncidents.length === 0) {
    return (
      <StatePanel
        state="empty"
        title="No incidents."
        description="Create an incident to investigate a concern, or connect an alert source for automatic detection."
      />
    );
  }

  return (
    <ul className="space-y-3" aria-label="Incident queue">
      {orderedIncidents.map(({ incident, depth }) => {
        const updatedAt = incident.updatedAt ?? incident.createdAt;
        const signal = signalLabel(incident);
        const signalTone =
          incident.signalCount === 0
            ? 'bg-surface-strong text-ink-secondary'
            : incident.recoveryState === 'monitoring' &&
                (incident.activeSignalCount ?? incident.signalCount ?? 0) === 0
              ? 'bg-info-muted text-info'
              : incident.recoveryState === 'not_verified' &&
                  (incident.activeSignalCount ?? incident.signalCount ?? 0) === 0
                ? 'bg-warning-muted text-warning'
                : (incident.activeSignalCount ?? incident.signalCount ?? 0) === 0
                  ? 'bg-success-muted text-success'
                  : 'bg-critical-muted text-critical';
        const signalTextTone = signalTone.split(' ').find((value) => value.startsWith('text-'));
        const severity =
          severityClass[incident.severity] ??
          'border-line-strong bg-surface-subtle text-ink-secondary';
        const facets: readonly SignalFacet[] = [
          incidentSignalFacet(incident),
          {
            label: investigationLabel[incident.investigationStatus],
            tone:
              incident.investigationStatus === 'assessed'
                ? 'assessment'
                : incident.investigationStatus === 'degraded'
                  ? 'critical'
                  : 'info',
          },
          {
            label: lifecycleLabel(incident),
            tone:
              incident.status === 'resolved' || incident.status === 'closed'
                ? 'success'
                : incident.requiresHumanAttention
                  ? 'warning'
                  : 'info',
          },
        ];
        return (
          <li
            key={incident.id}
            className="min-w-0"
            style={{ marginInlineStart: `${Math.min(depth, 3) * 1.5}rem` }}
          >
            <Link
              to={incidentPath(incident.id)}
              className="grid min-w-0 grid-cols-[0.375rem_minmax(0,1fr)] gap-3 rounded-lg border border-line bg-surface p-4 transition hover:border-line-strong"
            >
              <SignalSpine facets={facets} />
              <div className="min-w-0 space-y-3">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span
                    className={`rounded-full border px-2 py-0.5 font-bold uppercase ${severity}`}
                  >
                    {incident.severity}
                  </span>
                  <span
                    className={
                      incident.requiresHumanAttention ? 'font-semibold text-warning' : 'text-info'
                    }
                  >
                    {lifecycleLabel(incident)}
                  </span>
                  {incident.requiresHumanAttention && incident.attentionReason && (
                    <>
                      <span aria-hidden="true" className="text-line-strong">
                        /
                      </span>
                      <span className="text-warning">
                        {attentionReasonLabel[incident.attentionReason]}
                      </span>
                    </>
                  )}
                  <span aria-hidden="true" className="text-line-strong">
                    /
                  </span>
                  <span
                    className={
                      incident.investigationStatus === 'degraded'
                        ? 'text-critical'
                        : incident.investigationStatus === 'assessed'
                          ? 'text-assessment'
                          : 'text-info'
                    }
                  >
                    {investigationLabel[incident.investigationStatus]}
                  </span>
                  {signal && (
                    <>
                      <span aria-hidden="true" className="text-line-strong">
                        /
                      </span>
                      <span className={signalTextTone}>{signal}</span>
                    </>
                  )}
                  <time
                    dateTime={updatedAt}
                    title={formatAbsoluteTime(updatedAt)}
                    className="ml-auto font-instrument text-ink-muted"
                  >
                    {relativeTime(updatedAt, Date.now())}
                  </time>
                </div>
                <h2 className="break-words text-base font-medium text-ink">
                  {incidentDisplayTitle(incident)}
                </h2>
                {incident.causalParentId && (
                  <p className="text-xs font-semibold text-info">
                    Downstream symptom of{' '}
                    {incidentById.get(incident.causalParentId)?.title ??
                      incidentById.get(incident.causalParentId)?.service ??
                      incident.causalParentId.slice(0, 8)}
                  </p>
                )}
                <p className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted">
                  {!incident.service.startsWith('slack:') && (
                    <>
                      <span className="break-words font-medium text-ink-secondary">
                        {incident.service}
                      </span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span>
                    {incident.alertSource === 'manual' ? 'Human report' : incident.alertSource}
                  </span>
                  {(incident.originChannelName ?? incident.originChannel) && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="break-words">
                        {incident.originChannelName ?? incident.originChannel}
                      </span>
                    </>
                  )}
                </p>
                {incident.requiresHumanAttention && (
                  <dl className="grid gap-2 rounded-md border border-warning-line bg-warning-soft p-3 text-sm sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <dt className="text-[11px] font-semibold uppercase tracking-wide text-warning">
                        Decision required
                      </dt>
                      <dd className="mt-1 break-words text-ink">
                        {incident.attentionDecision ??
                          'Open the incident workspace for the required decision.'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] font-semibold uppercase tracking-wide text-warning">
                        Owner
                      </dt>
                      <dd className="mt-1 break-words text-ink">
                        {incident.responsibleOwner ?? 'Owner not resolved'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] font-semibold uppercase tracking-wide text-warning">
                        Next automation
                      </dt>
                      <dd className="mt-1 break-words text-ink">
                        {incident.nextAutomation ? (
                          <>
                            {incident.nextAutomation.description}
                            {incident.nextAutomation.scheduledAt && (
                              <>
                                {' · '}
                                <time
                                  dateTime={incident.nextAutomation.scheduledAt}
                                  title={formatAbsoluteTime(incident.nextAutomation.scheduledAt)}
                                >
                                  {futureRelativeTime(
                                    incident.nextAutomation.scheduledAt,
                                    Date.now(),
                                  )}
                                </time>
                              </>
                            )}
                          </>
                        ) : (
                          'No automation remains.'
                        )}
                      </dd>
                    </div>
                  </dl>
                )}
                {incident.rcaSummary ? (
                  <div className="rounded-md bg-surface-subtle p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                      Last trusted assessment
                    </p>
                    <p className="mt-1 break-words text-sm leading-5 text-ink-secondary">
                      {excerpt(incident.rcaSummary)}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-ink-muted">No trusted assessment yet.</p>
                )}

                <InvestigationResult run={incident.latestInvestigationRun} compact />
                {incident.latestInvestigationRun && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    <span className="font-semibold">Latest investigation run</span>
                    <span>
                      {investigationRunOperationLabel(incident.latestInvestigationRun.operation)} ·{' '}
                      {investigationRunOutcomeLabel(incident.latestInvestigationRun.outcome)} ·{' '}
                      {investigationRunTriggerLabel(incident.latestInvestigationRun.triggerReason)}{' '}
                      · {formatAbsoluteTime(incident.latestInvestigationRun.completedAt)}
                    </span>
                  </div>
                )}

                {incident.nextStep && (
                  <p className="break-words text-sm text-info">
                    <span className="font-semibold">
                      {incident.latestInvestigationRun?.outcome &&
                      incident.latestInvestigationRun.outcome !== 'conclusive'
                        ? 'Trusted assessment next step:'
                        : 'Next check:'}
                    </span>{' '}
                    {excerpt(incident.nextStep, 220)}
                  </p>
                )}

                {incident.recoveryState === 'monitoring' && incident.recoveryNextCheckAt && (
                  <p className="break-words text-sm text-info">
                    <span className="font-semibold">Recovery check:</span>{' '}
                    <time
                      dateTime={incident.recoveryNextCheckAt}
                      title={formatAbsoluteTime(incident.recoveryNextCheckAt)}
                    >
                      {futureRelativeTime(incident.recoveryNextCheckAt, Date.now())}
                    </time>
                    {incident.recoveryScheduleReason
                      ? ` · ${excerpt(incident.recoveryScheduleReason, 160)}`
                      : ''}
                  </p>
                )}

                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-xs text-ink-muted">
                  <span>
                    {incident.occurrenceCount && incident.occurrenceCount > 1
                      ? `${incident.occurrenceCount} correlated occurrences`
                      : `Opened ${relativeTime(incident.createdAt, Date.now())}`}
                  </span>
                  <span className="font-semibold text-ink-secondary">Open workspace →</span>
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
