import { Link } from 'react-router-dom';
import { formatAbsoluteTime } from '../../lib/time';
import { productPath } from '../../lib/routes';
import type { IncidentWorkspaceData } from '../../lib/types';

function safeCodeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function codeEventDetail(
  event: NonNullable<IncidentWorkspaceData['codeContext']>['events'][number],
) {
  const text = (key: string): string | null => {
    const value = event.summary[key];
    return typeof value === 'string' && value ? value : null;
  };
  if (event.eventType === 'workflow_run')
    return [text('name'), text('conclusion') ?? text('status')].filter(Boolean).join(' · ');
  if (event.eventType === 'pull_request')
    return [text('title'), text('state')].filter(Boolean).join(' · ');
  if (event.eventType === 'deployment' || event.eventType === 'deployment_status')
    return [text('environment'), text('state')].filter(Boolean).join(' · ');
  if (event.eventType === 'push' && typeof event.summary.commitCount === 'number')
    return `${event.summary.commitCount} commit${event.summary.commitCount === 1 ? '' : 's'}`;
  if (event.eventType === 'pipeline' || event.eventType === 'job')
    return [text('name'), text('status'), text('failureReason')].filter(Boolean).join(' · ');
  if (event.eventType === 'release') return [text('name'), text('tag')].filter(Boolean).join(' · ');
  return '';
}

export function CodeContextPanel({
  workspace,
  confirmingRepositoryId,
  confirmError,
  onConfirm,
}: {
  workspace: IncidentWorkspaceData;
  confirmingRepositoryId: string | null;
  confirmError: string | null;
  onConfirm: (
    provider: 'github' | 'gitlab',
    dataSourceId: string,
    repositoryId: string,
    serviceName: string,
    path: string | null,
  ) => void;
}) {
  const repositories = workspace.codeContext?.repositories ?? [];
  const events = workspace.codeContext?.events ?? [];
  return (
    <section
      aria-labelledby="code-context-title"
      className="@container min-w-0 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="code-context-title" className="font-medium text-ink">
            Code context
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            Repositories resolved for{' '}
            {(workspace.codeContext?.resolvedServices ?? [workspace.incident.service]).join(', ')}{' '}
            and recent authenticated source events.
          </p>
        </div>
        {repositories.length > 0 && (
          <span className="rounded bg-surface-strong px-2 py-1 text-xs font-medium text-ink-secondary">
            {repositories.length}{' '}
            {repositories.length === 1 ? 'repository relationship' : 'repository relationships'}
          </span>
        )}
      </div>
      {repositories.length === 0 ? (
        <div className="mt-3 rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
          <p>No repository relationship is resolved for this service.</p>
          <Link to={productPath('connectors')} className="mt-2 inline-block font-medium underline">
            Check source-control and Argo CD connectors
          </Link>
        </div>
      ) : (
        <div className="mt-3 grid min-w-0 gap-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <ul className="min-w-0 space-y-2" aria-label="Resolved repositories">
            {repositories.map((repository) => {
              const relationshipKey = JSON.stringify([
                repository.provider,
                repository.dataSourceId,
                repository.repositoryId,
                repository.serviceName,
                repository.path,
              ]);
              const href = safeCodeUrl(repository.htmlUrl);
              const relationship = repository.confirmed
                ? 'Confirmed service mapping'
                : repository.source === 'mapping'
                  ? 'Discovered from Argo CD'
                  : 'Exact repository-name match; verify before remediation';
              return (
                <li
                  key={relationshipKey}
                  className="min-w-0 rounded border border-line p-3 text-sm"
                >
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="break-words font-semibold text-accent underline"
                    >
                      {repository.fullName}
                    </a>
                  ) : (
                    <span className="break-words font-semibold">{repository.fullName}</span>
                  )}
                  <p className="mt-1 text-xs text-ink-muted">
                    {repository.provider === 'gitlab' ? 'GitLab' : 'GitHub'} · {relationship}
                    {` · ${repository.serviceName}`}
                    {repository.path ? ` · ${repository.path}` : ''}
                    {repository.defaultBranch ? ` · ${repository.defaultBranch}` : ''}
                  </p>
                  {repository.archived && (
                    <p className="mt-1 text-xs font-medium text-warning">Repository is archived</p>
                  )}
                  {!repository.confirmed && (
                    <button
                      type="button"
                      disabled={confirmingRepositoryId !== null}
                      onClick={() =>
                        onConfirm(
                          repository.provider,
                          repository.dataSourceId,
                          repository.repositoryId,
                          repository.serviceName,
                          repository.path,
                        )
                      }
                      className="sre-action mt-2 min-h-9 text-xs"
                    >
                      {confirmingRepositoryId === relationshipKey
                        ? 'Confirming…'
                        : `Confirm for ${repository.serviceName}`}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="min-w-0">
            <h3 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Recent synchronized changes
            </h3>
            {events.length === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">
                No authenticated source event has been synchronized in this incident window yet.
              </p>
            ) : (
              <ol className="mt-2 min-w-0 space-y-2" aria-label="Recent source events">
                {events.map((event, index) => {
                  const detail = codeEventDetail(event);
                  return (
                    <li
                      key={`${event.provider}-${event.eventType}-${event.sha ?? event.occurredAt}-${index}`}
                      className="min-w-0 border-l-2 border-assessment-line pl-3 text-sm"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="rounded bg-surface-strong px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-muted">
                          {event.provider === 'gitlab' ? 'GitLab' : 'GitHub'}
                        </span>
                        <span className="font-medium">
                          {event.eventType.replaceAll('_', ' ')}
                          {event.action ? ` · ${event.action}` : ''}
                        </span>
                        <time className="text-xs text-ink-muted" dateTime={event.occurredAt}>
                          {formatAbsoluteTime(event.occurredAt)}
                        </time>
                      </div>
                      {detail && <p className="break-words text-xs font-medium">{detail}</p>}
                      <p className="break-words text-xs text-ink-muted">
                        {event.repositoryFullName}
                        {event.ref ? ` · ${event.ref.replace(/^refs\/heads\//, '')}` : ''}
                        {event.sha ? ` · ${event.sha.slice(0, 8)}` : ''}
                        {event.actor ? ` · ${event.actor}` : ''}
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      )}
      {confirmError && (
        <p role="alert" className="mt-3 text-xs text-critical">
          {confirmError}
        </p>
      )}
    </section>
  );
}
