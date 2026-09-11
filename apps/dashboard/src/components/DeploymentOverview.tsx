import type { DeploymentSummary } from '../lib/useDeployments';
import { formatAbsoluteTime, relativeTime } from '../lib/time';

interface DeploymentOverviewProps {
  summary: DeploymentSummary;
  range: string;
  searchDraft: string;
  source: string;
  status: string;
  applicationCount: number;
  applicationAttentionCount: number;
  relatedIncidentCount: number;
  gitOpsObservedAt: string | null;
  gitOpsStale: boolean;
  onRangeChange: (value: string) => void;
  onSearchDraftChange: (value: string) => void;
  onSourceChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onApplySearch: () => void;
  onClear: () => void;
}

const cardClass = 'rounded-lg border border-line bg-surface p-4';

export function DeploymentOverview({
  summary,
  range,
  searchDraft,
  source,
  status,
  applicationCount,
  applicationAttentionCount,
  relatedIncidentCount,
  gitOpsObservedAt,
  gitOpsStale,
  onRangeChange,
  onSearchDraftChange,
  onSourceChange,
  onStatusChange,
  onApplySearch,
  onClear,
}: DeploymentOverviewProps) {
  const now = Date.now();
  return (
    <section aria-labelledby="deployment-overview-heading" className="mb-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="deployment-overview-heading" className="text-base font-semibold text-ink">
            Operational change overview
          </h2>
          <p className="text-sm text-ink-muted">
            Start with exceptions, recent changes, and incidents sharing the same service identity.
          </p>
        </div>
        {gitOpsObservedAt && (
          <p className={`text-xs ${gitOpsStale ? 'font-medium text-warning' : 'text-ink-muted'}`}>
            GitOps evidence {relativeTime(gitOpsObservedAt, now)}
            {gitOpsStale ? ' · stale' : ''} · {formatAbsoluteTime(gitOpsObservedAt)}
          </p>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className={cardClass}>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            Applications
          </dt>
          <dd className="mt-1 text-2xl font-semibold text-ink">{applicationAttentionCount}</dd>
          <dd className="text-xs text-ink-muted">need attention of {applicationCount} observed</dd>
        </div>
        <div className={cardClass}>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            Matching changes
          </dt>
          <dd className="mt-1 text-2xl font-semibold text-ink">{summary.total}</dd>
          <dd className="text-xs text-ink-muted">
            {summary.latestAt
              ? `latest ${relativeTime(summary.latestAt, now)} · ${formatAbsoluteTime(summary.latestAt)}`
              : 'inside the selected evidence window'}
          </dd>
        </div>
        <div className={cardClass}>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            Deployment risk
          </dt>
          <dd className="mt-1 text-2xl font-semibold text-ink">{summary.failed}</dd>
          <dd className="text-xs text-ink-muted">
            failed · {summary.active} running, pending, or blocked
          </dd>
        </div>
        <div className={cardClass}>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            Related incidents
          </dt>
          <dd className="mt-1 text-2xl font-semibold text-ink">{relatedIncidentCount}</dd>
          <dd className="text-xs text-ink-muted">same service as the loaded changes</dd>
        </div>
      </dl>

      <form
        className="sre-filter-grid sre-filter-shell mt-4 rounded-lg border border-line bg-surface p-4"
        onSubmit={(event) => {
          event.preventDefault();
          onApplySearch();
        }}
      >
        <label className="grid gap-1 text-sm font-medium text-ink-secondary">
          Search evidence
          <input
            type="search"
            value={searchDraft}
            onChange={(event) => onSearchDraftChange(event.target.value)}
            placeholder="Service, application, revision, actor"
            className="min-w-0 rounded-md border border-line-strong px-3 py-2 font-normal text-ink"
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-ink-secondary">
          Time range
          <select
            value={range}
            onChange={(event) => onRangeChange(event.target.value)}
            className="rounded-md border border-line-strong px-3 py-2 font-normal text-ink"
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All history</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium text-ink-secondary">
          Source
          <select
            value={source}
            onChange={(event) => onSourceChange(event.target.value)}
            className="rounded-md border border-line-strong px-3 py-2 font-normal text-ink"
          >
            <option value="">All sources</option>
            <option value="argocd">Argo CD</option>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium text-ink-secondary">
          Status
          <select
            value={status}
            onChange={(event) => onStatusChange(event.target.value)}
            className="rounded-md border border-line-strong px-3 py-2 font-normal text-ink"
          >
            <option value="">All statuses</option>
            <option value="failed">Failed</option>
            <option value="error">Error</option>
            <option value="running">Running</option>
            <option value="pending">Pending</option>
            <option value="blocked">Blocked</option>
            <option value="success">Succeeded</option>
            <option value="canceled">Canceled</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button
            type="submit"
            className="sre-hit-target rounded-md bg-strong px-4 py-2 text-sm font-medium text-on-strong hover:bg-strong-hover"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={onClear}
            className="sre-hit-target rounded-md border border-line-strong px-4 py-2 text-sm font-medium text-ink-secondary hover:bg-surface-subtle"
          >
            Clear
          </button>
        </div>
      </form>

      {summary.total > 0 && summary.environmentMissing > 0 && (
        <p className="mt-3 rounded-md border border-warning-line bg-warning-soft p-3 text-sm text-warning">
          Environment evidence is unavailable for {summary.environmentMissing} of {summary.total}{' '}
          matching changes. Service and destination namespace remain visible; no environment is
          inferred.
        </p>
      )}
    </section>
  );
}
