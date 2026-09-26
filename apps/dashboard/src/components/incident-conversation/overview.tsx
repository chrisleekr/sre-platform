import { Link } from 'react-router-dom';
import { incidentDisplayTitle } from '../../lib/incidentTitle';
import { evidenceOutcomeLabel, toolDisplayLabel } from '../../lib/toolPresentation';
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
import { IncidentEvidencePreview } from '../IncidentEvidencePreview';
import { IncidentAutomationStatus } from '../IncidentAutomationStatus';
import { incidentEvidencePreview } from '../../lib/incidentState';
import { Money } from '../Money';
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
  const serviceTeam = workspace.serviceTeams?.join(', ') ?? workspace.attention?.owner;
  const preview = incidentEvidencePreview(
    incident,
    view.recoveryIsCurrent,
    view.evidenceState.evidence.map((item) => item.id),
  );
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
        <h1 tabIndex={-1} className="mr-2 min-w-0 break-words text-2xl font-medium tracking-tight">
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
        {assessment === 'assessment available' && (
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
        <span>
          <span>Service team</span>{' '}
          <strong className="text-ink-secondary">{serviceTeam || 'Not established'}</strong>
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
          className="font-semibold text-accent underline decoration-info-line underline-offset-2 hover:text-info"
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
      {stream.status !== 'open' && (
        <div
          role="status"
          className="mt-3 rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning"
        >
          <p className="font-semibold">
            {stream.status === 'closed' || stream.connectionError
              ? 'Live updates interrupted. Showing the last loaded information.'
              : 'Connecting to live updates. Showing the loaded incident.'}
          </p>
          <button type="button" onClick={stream.retry} className="min-h-11 underline">
            Retry live updates
          </button>
        </div>
      )}
      {(view.newMessageCount > 0 || view.conversationReviewNeeded) && (
        <div role="status">
          <button
            type="button"
            onClick={view.showNewMessages}
            className="mt-2 min-h-11 text-accent underline"
          >
            {view.newMessageCount > 0 &&
              `${view.newMessageCount} new conversation update${view.newMessageCount === 1 ? '' : 's'} · `}
            {view.conversationReviewNeeded
              ? 'Connection restored · Review conversation'
              : 'View updates'}
          </button>
        </div>
      )}

      <nav
        aria-label="Incident workspace sections"
        className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 text-xs"
      >
        <span className="text-xs text-ink-muted">Jump to</span>
        <button
          type="button"
          className="min-h-11 text-accent underline"
          onClick={() => {
            const controls = document.getElementById(
              'incident-lifecycle-controls',
            ) as HTMLDetailsElement | null;
            if (controls) {
              controls.open = true;
              controls.scrollIntoView({ block: 'start' });
              controls.querySelector('summary')?.focus();
            }
          }}
        >
          Manage incident
        </button>
        {[
          ['#decision-brief-title', 'Brief'],
          ['#timeline-title', 'Conversation'],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="sre-hit-target flex shrink-0 items-center py-2 text-sm font-medium text-accent underline decoration-info-line underline-offset-4 hover:text-ink"
          >
            {label}
          </a>
        ))}
      </nav>

      <div className="mt-3 grid min-w-0 gap-4 @4xl:grid-cols-[minmax(0,1fr)_18rem] @4xl:items-start">
        <div className="min-w-0 space-y-4">
          <IncidentDecisionBrief
            workspace={workspace}
            onSelectEvidence={openEvidence}
            getCredentials={getCredentials}
            onChanged={refreshWorkspace}
          />
          <IncidentOperatorPanel
            workspace={workspace}
            showTeam={false}
            getCredentials={getCredentials}
            onChanged={refreshWorkspace}
          />

          {workspace.investigationSubject ? (
            <section className="rounded-lg border border-info-line bg-info-soft p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-medium text-info">Investigation source</h2>
                  <p className="mt-1 break-words text-sm text-info">
                    {workspace.investigationSubject.subjectId}
                  </p>
                </div>
                <a
                  href={workspace.investigationSubject.sourcePath}
                  className="text-sm font-semibold text-accent underline underline-offset-2"
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
                  className="mt-3 text-sm font-semibold text-accent underline underline-offset-2"
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

        <aside className="min-w-0 space-y-3" aria-label="Supporting evidence">
          <IncidentAutomationStatus incident={incident} />
          <section className="rounded-lg border border-line bg-surface p-4" id="incident-evidence">
            <h2 className="font-medium">Supporting evidence</h2>
            <p className="mt-1 text-xs text-ink-muted">
              {preview.cited
                ? 'Recorded citations for the current assessment'
                : 'Recent checks, not cited proof of a finding'}
            </p>
            <ul className="mt-3 space-y-2">
              {preview.ids.map((id) => {
                const item = view.evidenceState.evidence.find((record) => record.id === id);
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className="min-h-11 w-full rounded border border-line p-3 text-left"
                      onClick={() =>
                        openEvidence(
                          id,
                          (view.recoveryIsCurrent
                            ? incident.recoveryEvidenceIds
                            : incident.assessmentEvidenceIds
                          )?.includes(id)
                            ? view.recoveryIsCurrent
                              ? (incident.recoverySummary ?? 'Recovery assessment citation')
                              : (incident.rcaSummary ?? 'Recorded assessment citation')
                            : undefined,
                        )
                      }
                    >
                      <span className="block break-words text-sm font-semibold">
                        {item ? toolDisplayLabel(item.tool) : `Cited check ${id.slice(0, 8)}`}
                      </span>
                      <span className="mt-1 block break-all text-xs">
                        {item?.summary ?? 'Inspect recorded evidence'}
                      </span>
                      <IncidentEvidencePreview
                        detail={view.evidenceState.details?.[id]}
                        failed={view.evidenceState.detailErrors?.[id]}
                      />
                      {item && (
                        <span className="mt-1 block text-xs text-ink-muted">
                          {evidenceOutcomeLabel(item.outcome)} ·{' '}
                          {formatAbsoluteTime(item.recordedAt)}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              onClick={view.showAllEvidence}
              className="mt-3 min-h-11 text-accent underline"
            >
              All evidence · {view.evidenceState.evidence.length} loaded
            </button>
          </section>
          <details className="rounded-xl border border-line bg-surface-subtle p-3">
            <summary className="min-h-11 cursor-pointer font-semibold">
              Response history and usage
            </summary>
            <div className="mb-3 px-1">
              <h2 className="text-sm font-medium text-ink">Current response state</h2>
            </div>
            <dl className="grid min-w-0 gap-2 @4xl:grid-cols-2">
              <div className="relative overflow-hidden rounded-lg border border-line bg-surface p-3 pl-4">
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-3 left-0 w-1 rounded-r-full ${ownershipMarker}`}
                />
                <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  Response status
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
                  {incident.latestInvestigationRun
                    ? investigationRunOperationLabel(incident.latestInvestigationRun.operation)
                    : 'No completed run recorded'}
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
          </details>
        </aside>
      </div>
    </>
  );
}
