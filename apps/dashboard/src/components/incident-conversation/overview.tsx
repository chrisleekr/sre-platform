import { Link } from 'react-router-dom';
import { incidentDisplayTitle } from '../../lib/incidentTitle';
import { investigationWorkLabel } from '../../lib/incidentState';
import { incidentPath, productPath } from '../../lib/routes';
import { formatAbsoluteTime } from '../../lib/time';
import {
  investigationRunBudgetLabel,
  investigationRunOperationLabel,
  investigationRunOutcomeLabel,
  investigationRunTriggerLabel,
} from '../../lib/investigationRuns';
import { IncidentDecisionBrief } from '../IncidentDecisionBrief';
import { IncidentOperatorPanel } from '../IncidentOperatorPanel';
import { Money } from '../Money';
import { IncidentTags } from '../IncidentTags';
import { SlackThreadLink } from './signals';
import type { IncidentLiveViewModel } from './view-model';

const tokenFormatter = new Intl.NumberFormat('en-US', { notation: 'compact' });

export function IncidentOverview({ view }: { view: IncidentLiveViewModel }) {
  const {
    workspace,
    navigate,
    incident,
    assessment,
    stream,
    copyLinkState,
    createdAt,
    openEvidence,
    copyIncidentLink,
    ownershipLabel,
    ownershipMarker,
    providerState,
    signals,
    getCredentials,
    refreshWorkspace,
  } = view;
  const displayTitle = incidentDisplayTitle(incident, signals);
  const resolvedServices = (workspace.codeContext?.resolvedServices ?? []).filter(
    (service) => !service.startsWith('slack:'),
  );
  const affected =
    resolvedServices.length === 1
      ? resolvedServices[0]
      : !incident.service.startsWith('slack:')
        ? incident.service
        : [
            ...new Set(
              workspace.entityContext?.observations
                .flatMap((item) => item.candidates)
                .map((item) => item.displayName)
                .filter(Boolean),
            ),
          ].join(', ');
  const affectedLabel =
    resolvedServices.length === 1
      ? 'Service'
      : incident.service.startsWith('slack:') && affected
        ? 'Possible affected resources'
        : 'Affected resource';
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h1 className="mr-2 min-w-0 break-words text-2xl font-semibold tracking-tight">
          {displayTitle}
        </h1>
        {incident.purpose === 'health_check' ? (
          <span className="rounded-full bg-info-soft px-2.5 py-1 text-xs text-info">
            Health check
          </span>
        ) : (
          <span
            className={`rounded-full px-2.5 py-1 font-instrument text-xs font-bold uppercase ${
              incident.severity === 'sev1'
                ? 'bg-critical-muted text-critical'
                : incident.severity === 'sev2'
                  ? 'bg-warning-muted text-warning'
                  : 'bg-info-muted text-info'
            }`}
          >
            {incident.severity}
          </span>
        )}
        <span className="rounded-full bg-strong px-2.5 py-1 text-xs font-semibold capitalize text-on-strong">
          {incident.purpose === 'health_check' && ['closed', 'resolved'].includes(incident.status)
            ? 'Completed'
            : incident.status}
        </span>
        {assessment && (
          <span className="rounded-full bg-assessment-muted px-2.5 py-1 text-xs font-medium text-assessment">
            {assessment}
          </span>
        )}
      </div>

      <div className="mt-3 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span>
          {affectedLabel}{' '}
          <strong className="font-semibold text-ink-secondary">
            {affected || 'Not established'}
          </strong>
        </span>
        {incident.originSurface !== 'slack' && (
          <span>{incident.alertSource === 'manual' ? 'Human report' : incident.alertSource}</span>
        )}
        {incident.originSurface === 'slack' &&
          incident.originChannel &&
          incident.originThreadId && (
            <SlackThreadLink
              incidentId={incident.id}
              channel={incident.originChannelName ?? incident.originChannel}
            />
          )}
        <button
          type="button"
          onClick={() => void copyIncidentLink()}
          className="font-semibold text-info underline decoration-info-line underline-offset-2 hover:text-info"
        >
          {copyLinkState === 'copied'
            ? 'Incident link copied'
            : copyLinkState === 'failed'
              ? 'Copy link failed'
              : 'Copy incident link'}
        </button>
        <time dateTime={incident.createdAt} title={createdAt}>
          Created {createdAt}
        </time>
        <span>Live updates: {stream.status}</span>
      </div>

      <IncidentTags
        incidentId={incident.id}
        getCredentials={getCredentials}
        data={{
          tags: workspace.tags ?? [],
          suggestions: workspace.tagSuggestions ?? [],
          linkRules: workspace.tagLinkRules ?? [],
          historySuggestions: workspace.tagHistorySuggestions ?? [],
        }}
        refresh={refreshWorkspace}
      />

      <nav
        aria-label="Incident workspace sections"
        className="mt-4 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-y border-line py-2"
      >
        <span className="text-xs text-ink-muted">Jump to</span>
        {[
          ['#decision-brief-title', 'Brief'],
          ['#timeline-title', 'Conversation'],
          ['#incident-evidence', 'Evidence'],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="sre-hit-target flex shrink-0 items-center py-2 text-sm font-medium text-info underline decoration-info-line underline-offset-4 hover:text-ink"
          >
            {label}
          </a>
        ))}
      </nav>

      <div className="mt-5 grid min-w-0 gap-4 @4xl:grid-cols-[minmax(0,1fr)_23rem] @4xl:items-start">
        <div className="min-w-0 space-y-4">
          <IncidentOperatorPanel workspace={workspace} />
          <IncidentDecisionBrief
            workspace={workspace}
            onSelectEvidence={openEvidence}
            getCredentials={getCredentials}
            onChanged={refreshWorkspace}
          />

          {workspace.investigationSubject ? (
            <section className="rounded-lg border border-info-line bg-info-soft p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-info">Investigation source</h2>
                  <p className="mt-1 break-words text-sm text-info">
                    {workspace.investigationSubject.subjectId}
                  </p>
                </div>
                <a
                  href={workspace.investigationSubject.sourcePath}
                  className="text-sm font-semibold text-info underline underline-offset-2"
                >
                  Open source page
                </a>
              </div>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="font-medium text-info">Captured</dt>
                  <dd className="mt-0.5 text-info">
                    {workspace.investigationSubject.capturedSummary}
                  </dd>
                  <dd className="mt-1 text-xs text-info">
                    {workspace.investigationSubject.capturedState} ·{' '}
                    <time dateTime={workspace.investigationSubject.observedAt}>
                      {formatAbsoluteTime(workspace.investigationSubject.observedAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-info">Current</dt>
                  <dd className="mt-0.5 text-info">
                    {workspace.investigationSubject.currentSummary}
                  </dd>
                  <dd className="mt-1 text-xs text-info">
                    {workspace.investigationSubject.currentState} · synced{' '}
                    <time dateTime={workspace.investigationSubject.lastSyncedAt}>
                      {formatAbsoluteTime(workspace.investigationSubject.lastSyncedAt)}
                    </time>
                  </dd>
                </div>
              </dl>
              {(workspace.relations ?? []).find(
                (relation) =>
                  relation.type === 'recurrence_of' && relation.sourceIncidentId === incident.id,
              ) ? (
                <button
                  type="button"
                  className="mt-3 text-sm font-semibold text-info underline underline-offset-2"
                  onClick={() => {
                    const relation = (workspace.relations ?? []).find(
                      (item) =>
                        item.type === 'recurrence_of' && item.sourceIncidentId === incident.id,
                    );
                    if (relation) navigate(incidentPath(relation.targetIncidentId));
                  }}
                >
                  Open previous episode
                </button>
              ) : null}
            </section>
          ) : null}
        </div>

        <aside className="min-w-0 rounded-xl border border-line bg-surface-subtle p-3 @4xl:sticky @4xl:top-4">
          <div className="mb-3 px-1">
            <h2 className="text-sm font-bold text-ink">Current response state</h2>
            <p className="mt-0.5 text-xs leading-5 text-ink-muted">
              Live signals, automation, and required human action.
            </p>
          </div>
          <dl className="grid min-w-0 gap-2 @4xl:grid-cols-2">
            <div className="relative overflow-hidden rounded-lg border border-line bg-surface p-3 pl-4">
              <span
                aria-hidden="true"
                className={`absolute inset-y-3 left-0 w-1 rounded-r-full ${ownershipMarker}`}
              />
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Ownership
              </dt>
              <dd className="mt-1 text-sm font-semibold text-ink">{ownershipLabel}</dd>
              <dd className="mt-1 text-xs text-ink-muted">
                Lifecycle v{incident.lifecycleVersion}
              </dd>
            </div>
            <div className="relative overflow-hidden rounded-lg border border-line bg-surface p-3 pl-4">
              <span
                aria-hidden="true"
                className={`absolute inset-y-3 left-0 w-1 rounded-r-full ${providerState.marker}`}
              />
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Provider notifications
              </dt>
              <dd className={`mt-1 text-sm font-semibold ${providerState.text}`}>
                {providerState.label}
              </dd>
              <dd className="mt-1 text-xs text-ink-muted">
                {signals.length} correlated notification{signals.length === 1 ? '' : 's'}
              </dd>
            </div>
            <div className="relative overflow-hidden rounded-lg border border-line bg-surface p-3 pl-4">
              <span
                aria-hidden="true"
                className={`absolute inset-y-3 left-0 w-1 rounded-r-full ${
                  incident.investigationStatus === 'degraded'
                    ? 'bg-critical-solid'
                    : incident.investigationStatus === 'assessed'
                      ? 'bg-assessment-solid'
                      : 'bg-info-solid'
                }`}
              />
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                SRE investigation
              </dt>
              <dd
                className={`mt-1 text-sm font-semibold ${
                  incident.investigationStatus === 'degraded' ? 'text-critical' : 'text-ink'
                }`}
              >
                {investigationWorkLabel(incident)}
              </dd>
              {incident.queuedResponderWork && (
                <dd className="mt-1 text-xs text-ink-muted">
                  Responder follow-up queued. New input has not yet been incorporated.
                </dd>
              )}
              <dd className="mt-1 text-xs text-ink-muted">
                {workspace.progress.total} diagnostic check
                {workspace.progress.total === 1 ? '' : 's'} recorded
              </dd>
              {incident.latestInvestigationRun && (
                <dd className="mt-2 border-t border-line pt-2 text-xs text-ink-muted">
                  <span className="block font-semibold">Latest investigation run</span>
                  <span>
                    {investigationRunOperationLabel(incident.latestInvestigationRun.operation)} ·{' '}
                    {investigationRunOutcomeLabel(incident.latestInvestigationRun.outcome)} ·{' '}
                    {formatAbsoluteTime(incident.latestInvestigationRun.completedAt)}
                  </span>
                  <span className="block">
                    Trigger:{' '}
                    {investigationRunTriggerLabel(incident.latestInvestigationRun.triggerReason)}
                    {incident.latestInvestigationRun.triggerReason
                      ? incident.latestInvestigationRun.triggerAutomatic
                        ? ' · automatic'
                        : ' · manual'
                      : ''}
                  </span>
                  {investigationRunBudgetLabel(incident.latestInvestigationRun) && (
                    <span className="block">
                      {investigationRunBudgetLabel(incident.latestInvestigationRun)}
                    </span>
                  )}
                </dd>
              )}
            </div>
            <div className="relative overflow-hidden rounded-lg border border-line bg-surface p-3 pl-4">
              <span
                aria-hidden="true"
                className={`absolute inset-y-3 left-0 w-1 rounded-r-full ${
                  (workspace.llmUsage?.unpriced ?? 0) > 0 ||
                  (workspace.llmUsage?.missingUsage ?? 0) > 0
                    ? 'bg-warning-solid'
                    : 'bg-assessment-solid'
                }`}
              />
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                LLM usage
              </dt>
              <dd className="mt-1 text-sm font-semibold text-ink">
                {!workspace.llmUsage || workspace.llmUsage.invocations === 0 ? (
                  'No model spend recorded'
                ) : workspace.llmUsage.unpriced === workspace.llmUsage.invocations ? (
                  'Pricing required'
                ) : (
                  <>
                    <Money amount={workspace.llmUsage.configuredCostUsd} /> configured cost
                  </>
                )}
              </dd>
              <dd className="mt-1 text-xs text-ink-muted">
                {workspace.llmUsage?.invocations ?? 0} invocation
                {(workspace.llmUsage?.invocations ?? 0) === 1 ? '' : 's'} ·{' '}
                {tokenFormatter.format(
                  (workspace.llmUsage?.tokens.input ?? 0) +
                    (workspace.llmUsage?.tokens.output ?? 0) +
                    (workspace.llmUsage?.tokens.cacheRead ?? 0) +
                    (workspace.llmUsage?.tokens.cacheWrite ?? 0),
                )}{' '}
                tokens
              </dd>
              {(workspace.llmUsage?.unpriced ?? 0) > 0 && (
                <dd className="mt-1 text-xs font-medium text-warning">
                  {workspace.llmUsage!.unpriced} unpriced ·{' '}
                  <Link className="underline underline-offset-2" to={productPath('settings')}>
                    Set model pricing
                  </Link>
                </dd>
              )}
              {(workspace.llmUsage?.missingUsage ?? 0) > 0 && (
                <dd className="mt-1 text-xs font-medium text-critical">
                  {workspace.llmUsage!.missingUsage} invocation
                  {workspace.llmUsage!.missingUsage === 1 ? '' : 's'} missing provider usage
                </dd>
              )}
            </div>
          </dl>
        </aside>
      </div>
    </>
  );
}
