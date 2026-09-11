import type { GitOpsApplication } from '../lib/types';
import { formatAbsoluteTime, relativeTime } from '../lib/time';

const STALE_AFTER_MS = 90_000;

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function valueOrUnknown(value: string | undefined): string {
  return value || 'Not reported';
}

function isStale(application: GitOpsApplication, now: number): boolean {
  const observedAt = Date.parse(application.observedAt);
  return !Number.isFinite(observedAt) || now - observedAt > STALE_AFTER_MS;
}

function attentionRank(application: GitOpsApplication, now: number): number {
  const hasErrorCondition = application.conditions.some((condition) =>
    condition.type?.toLowerCase().includes('error'),
  );
  if (
    hasErrorCondition ||
    ['Degraded', 'Missing'].includes(application.healthStatus ?? '') ||
    ['Error', 'Failed'].includes(application.operationPhase ?? '')
  )
    return 0;
  if (
    ['OutOfSync', 'Unknown'].includes(application.syncStatus ?? '') ||
    ['Unknown', 'Progressing', 'Suspended'].includes(application.healthStatus ?? '') ||
    ['Running', 'Pending', 'Waiting', 'Progressing', 'Terminating'].includes(
      application.operationPhase ?? '',
    ) ||
    application.conditions.length > 0 ||
    isStale(application, now)
  )
    return 1;
  return 2;
}

export function applicationNeedsAttention(
  application: GitOpsApplication,
  now = Date.now(),
): boolean {
  return attentionRank(application, now) < 2;
}

function healthClass(value: string | undefined): string {
  if (['Degraded', 'Missing'].includes(value ?? '')) return 'bg-critical-muted text-critical';
  if (['Progressing', 'Suspended'].includes(value ?? '')) return 'bg-warning-muted text-warning';
  if (value === 'Healthy') return 'bg-success-muted text-success';
  return 'bg-surface-strong text-ink-secondary';
}

function syncClass(value: string | undefined): string {
  if (value === 'OutOfSync') return 'bg-warning-muted text-warning';
  if (value === 'Synced') return 'bg-success-muted text-success';
  return 'bg-surface-strong text-ink-secondary';
}

function applicationMatches(application: GitOpsApplication, search: string): boolean {
  if (!search) return true;
  const haystack = [
    application.applicationName,
    application.dataSourceName,
    application.project,
    application.applicationNamespace,
    application.destinationNamespace,
    application.syncStatus,
    application.healthStatus,
    application.operationPhase,
    ...application.revisions,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(search.toLowerCase());
}

export function GitOpsApplicationsList({
  applications,
  search = '',
  now = Date.now(),
}: {
  applications: GitOpsApplication[];
  search?: string;
  now?: number;
}) {
  if (applications.length === 0) return null;
  const sorted = applications
    .filter((application) => applicationMatches(application, search))
    .sort((left, right) => attentionRank(left, now) - attentionRank(right, now));
  const attention = sorted.filter((application) => applicationNeedsAttention(application, now));
  const healthy = sorted.filter((application) => !applicationNeedsAttention(application, now));
  const observedTime = (application: GitOpsApplication) =>
    Number.isFinite(Date.parse(application.observedAt))
      ? `${relativeTime(application.observedAt, now)} · ${formatAbsoluteTime(application.observedAt)}`
      : 'Unknown';
  const statusSummary = `${attention.length} need attention · ${healthy.length} healthy`;
  const healthyLabel = `Show ${healthy.length} healthy application${healthy.length === 1 ? '' : 's'}`;
  const staleClass = (application: GitOpsApplication) =>
    isStale(application, now) ? 'text-warning' : 'text-ink-muted';

  const applicationTitle = (application: GitOpsApplication) =>
    isHttpUrl(application.url) ? (
      <a className="text-info hover:underline" href={application.url}>
        {application.applicationName}
      </a>
    ) : (
      application.applicationName
    );

  return (
    <section aria-labelledby="gitops-live-heading" className="mb-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="gitops-live-heading" className="text-base font-semibold text-ink">
            Application health
          </h2>
          <p className="text-sm text-ink-muted">
            Exceptions stay visible; healthy Argo CD applications are collapsed.
          </p>
        </div>
        <p className="text-sm font-medium text-ink-secondary">{statusSummary}</p>
      </div>

      {sorted.length === 0 && (
        <p className="rounded-md border border-line bg-surface p-4 text-sm text-ink-muted">
          No applications match the current search.
        </p>
      )}

      {attention.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {attention.map((application) => (
            <article
              key={`${application.dataSourceId}/${application.entityId}`}
              aria-label={application.applicationName}
              className="min-w-0 rounded-lg border border-warning-line bg-warning-soft/40 p-4"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="break-words font-medium text-ink">
                    {applicationTitle(application)}
                  </h3>
                  <p className="break-words text-xs text-ink-muted">
                    {application.dataSourceName} · {application.project} ·{' '}
                    {application.applicationNamespace}
                  </p>
                  <p className={`text-xs ${staleClass(application)}`}>
                    Observed {observedTime(application)}
                    {isStale(application, now) ? ' · stale' : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1 text-xs font-medium">
                  <span className={`rounded px-2 py-0.5 ${syncClass(application.syncStatus)}`}>
                    Sync: {valueOrUnknown(application.syncStatus)}
                  </span>
                  <span className={`rounded px-2 py-0.5 ${healthClass(application.healthStatus)}`}>
                    Health: {valueOrUnknown(application.healthStatus)}
                  </span>
                </div>
              </div>
              <dl className="mt-3 grid gap-2 text-xs text-ink-muted sm:grid-cols-2">
                <div>
                  <dt className="font-medium text-ink-secondary">Operation</dt>
                  <dd className="break-words">{valueOrUnknown(application.operationPhase)}</dd>
                </div>
                <div>
                  <dt className="font-medium text-ink-secondary">Destination</dt>
                  <dd className="break-words">
                    {valueOrUnknown(application.destinationNamespace)}
                    {application.destinationServer ? ` · ${application.destinationServer}` : ''}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="font-medium text-ink-secondary">Revisions</dt>
                  <dd className="break-all font-instrument">
                    {application.revisions.length > 0
                      ? application.revisions.join(', ')
                      : 'Not reported'}
                  </dd>
                </div>
              </dl>
              {application.healthMessage && (
                <p className="mt-3 break-words rounded bg-surface/70 p-2 text-xs text-ink-secondary">
                  {application.healthMessage}
                </p>
              )}
              {application.conditions.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-warning">
                  {application.conditions.map((condition, index) => (
                    <li key={`${condition.type ?? 'condition'}-${index}`} className="break-words">
                      {condition.type ? `${condition.type}: ` : ''}
                      {condition.message ?? 'Condition reported'}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}

      {healthy.length > 0 && (
        <details
          className={`${attention.length > 0 ? 'mt-3' : ''} rounded-lg border border-line bg-surface`}
        >
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-secondary hover:bg-surface-subtle">
            {healthyLabel}
          </summary>
          <ul className="divide-y divide-line border-t border-line">
            {healthy.map((application) => (
              <li
                key={`${application.dataSourceId}/${application.entityId}`}
                className="grid min-w-0 gap-2 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium text-ink">
                    {applicationTitle(application)}
                  </p>
                  <p className="break-words text-xs text-ink-muted">
                    {application.dataSourceName} · {application.project} ·{' '}
                    {valueOrUnknown(application.destinationNamespace)} ·{' '}
                    {application.revisions[0]?.slice(0, 12) ?? 'revision unavailable'}
                  </p>
                </div>
                <p className="text-xs text-ink-muted">Observed {observedTime(application)}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
