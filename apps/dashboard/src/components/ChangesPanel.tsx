import { useMemo, useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { useChanges } from '../lib/useChanges';
import { useKeysetPages } from '../lib/useKeysetPages';
import type { ChangeEvent } from '../lib/types';
import { formatAbsoluteTime, relativeTime } from '../lib/time';
import { PageHeader } from './PageHeader';
import { InlineAlert, StatePanel } from './PageState';

const PAGE_SIZE = 25;
const CATEGORY_STYLE: Record<ChangeEvent['category'], string> = {
  code: 'bg-assessment-muted text-assessment',
  review: 'bg-info-muted text-info',
  ci: 'bg-warning-muted text-warning',
  release: 'bg-success-muted text-success',
};

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function sourceName(provider: string): string {
  return provider === 'github' ? 'GitHub' : 'GitLab';
}

export function ChangesPanel() {
  const { getCredentials } = useSession();
  const [range, setRange] = useState('24h');
  const [provider, setProvider] = useState('');
  const [dataSourceId, setDataSourceId] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [repositoryDraft, setRepositoryDraft] = useState('');
  const [repository, setRepository] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();

  const filters = useMemo(() => {
    const rangeMs =
      range === '24h'
        ? 86_400_000
        : range === '7d'
          ? 7 * 86_400_000
          : range === '30d'
            ? 30 * 86_400_000
            : null;
    return {
      ...(rangeMs ? { from: new Date(Date.now() - rangeMs).toISOString() } : {}),
      ...(provider ? { provider } : {}),
      ...(dataSourceId ? { dataSourceId } : {}),
      ...(category ? { category } : {}),
      ...(status ? { status } : {}),
      ...(repository ? { repository } : {}),
      ...(search ? { search } : {}),
    };
  }, [range, provider, dataSourceId, category, status, repository, search]);
  const filterKey = JSON.stringify(filters);
  const { changes, nextCursor, summary, sources, loading, error, refetch } = useChanges({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    cursor,
    limit: PAGE_SIZE,
    filters,
  });
  const { pages, rows } = useKeysetPages({
    cursor,
    page: changes,
    loading,
    error,
    resetKey: filterKey,
  });
  const hasRows = pages.length > 0;
  const initialLoading = loading && !hasRows;
  const reset = (): void => setCursor(undefined);

  if (initialLoading) {
    return (
      <section>
        <PageHeader
          title="Changes"
          description="Correlate code, review, CI, and release activity before and during an incident. Deployment records remain in Deployments."
        />
        <StatePanel state="loading" title="Loading changes…" skeleton="table" />
      </section>
    );
  }

  return (
    <section>
      <PageHeader
        title="Changes"
        description="Correlate code, review, CI, and release activity before and during an incident. Deployment records remain in Deployments."
      />

      <section aria-label="Change event delivery health" className="mb-4 grid gap-3 sm:grid-cols-2">
        {sources.length === 0 && (
          <article className="rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
            No GitHub or GitLab data sources are connected. Add one from Connectors to receive
            authenticated change events.
          </article>
        )}
        {sources.map((source) => {
          return (
            <article key={source.id} className="rounded border border-line bg-surface p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="font-medium">{source.name}</h2>
                  <p className="text-xs text-ink-muted">{sourceName(source.provider)} event sync</p>
                </div>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${!source.enabled ? 'bg-surface-strong text-ink-secondary' : source.failureCategory ? 'bg-critical-muted text-critical' : source.lastSuccessAt ? 'bg-success-muted text-success' : 'bg-warning-muted text-warning'}`}
                >
                  {!source.enabled
                    ? 'Disabled'
                    : source.failureCategory
                      ? 'Action required'
                      : source.lastSuccessAt
                        ? 'Receiving'
                        : 'Awaiting delivery'}
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                {source.enabled
                  ? `${source.count} authenticated events. Last verified ${source.lastSuccessAt ? relativeTime(source.lastSuccessAt, Date.now()) : 'never'}.`
                  : `${source.name} is configured but disabled. Verify it to resume event sync.`}
              </p>
              {source.failureCategory && (
                <p className="mt-1 text-xs text-critical">
                  Latest failure: {source.failureCategory.replaceAll('_', ' ')}
                </p>
              )}
            </article>
          );
        })}
      </section>

      <section aria-label="Change summary" className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Summary label="Matching activity" value={summary.total} />
        <Summary label="Failing CI" value={summary.failing} tone="text-critical" />
        <Summary label="Successful" value={summary.succeeded} tone="text-success" />
        <Summary
          label="Latest"
          value={summary.latestAt ? relativeTime(summary.latestAt, Date.now()) : 'None'}
        />
      </section>

      <form
        className="sre-filter-grid sre-filter-shell mb-4 rounded border border-line bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          setRepository(repositoryDraft.trim());
          setSearch(searchDraft.trim());
          reset();
        }}
      >
        <Filter
          label="Range"
          value={range}
          onChange={(value) => {
            setRange(value);
            reset();
          }}
          options={[
            ['24h', '24 hours'],
            ['7d', '7 days'],
            ['30d', '30 days'],
            ['all', 'All time'],
          ]}
        />
        <Filter
          label="Provider"
          value={provider}
          onChange={(value) => {
            setProvider(value);
            reset();
          }}
          options={[
            ['', 'All providers'],
            ['github', 'GitHub'],
            ['gitlab', 'GitLab'],
          ]}
        />
        <Filter
          label="Data source"
          value={dataSourceId}
          onChange={(value) => {
            setDataSourceId(value);
            reset();
          }}
          options={[
            ['', 'All data sources'],
            ...sources.map((source) => [source.id, source.name] as [string, string]),
          ]}
        />
        <Filter
          label="Category"
          value={category}
          onChange={(value) => {
            setCategory(value);
            reset();
          }}
          options={[
            ['', 'All categories'],
            ['code', 'Code'],
            ['review', 'Review'],
            ['ci', 'CI'],
            ['release', 'Release'],
          ]}
        />
        <Filter
          label="Outcome"
          value={status}
          onChange={(value) => {
            setStatus(value);
            reset();
          }}
          options={[
            ['', 'All outcomes'],
            ['failed', 'Failed'],
            ['success', 'Successful'],
            ['active', 'Active'],
          ]}
        />
        <label className="text-xs font-medium text-ink-secondary">
          Repository
          <input
            value={repositoryDraft}
            onChange={(event) => setRepositoryDraft(event.target.value)}
            placeholder="owner/repository"
            className="sre-field mt-1 w-full"
          />
        </label>
        <label className="text-xs font-medium text-ink-secondary">
          Search
          <span className="mt-1 flex gap-1">
            <input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="repo, actor, SHA"
              className="sre-field min-w-0 flex-1"
            />
            <button type="submit" className="sre-action sre-action-primary">
              Apply
            </button>
          </span>
        </label>
      </form>

      {error &&
        (hasRows ? (
          <InlineAlert message="Failed to load more changes." onRetry={refetch} />
        ) : (
          <StatePanel
            state="error"
            title="Failed to load changes."
            description="Authenticated change events could not be retrieved."
            onRetry={refetch}
          />
        ))}
      {!loading && !error && !hasRows && (
        <StatePanel
          state="empty"
          title="No matching changes."
          description="Adjust the filters or verify GitHub and GitLab event delivery."
        />
      )}
      {hasRows && <ChangesList changes={rows} />}
      {nextCursor && !loading && (
        <button
          type="button"
          onClick={() => (cursor === nextCursor ? refetch() : setCursor(nextCursor))}
          className="mt-3 w-full rounded border border-line py-2 text-sm font-medium text-ink-muted hover:bg-surface-subtle"
        >
          Load older
        </button>
      )}
    </section>
  );
}

function Summary({
  label,
  value,
  tone = 'text-ink',
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <article className="rounded border border-line bg-surface p-3">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${tone}`}>{value}</p>
    </article>
  );
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="text-xs font-medium text-ink-secondary">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="sre-field mt-1 w-full"
      >
        {options.map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ChangesList({ changes }: { changes: ChangeEvent[] }) {
  const now = Date.now();
  return (
    <ol className="space-y-2" aria-label="Change evidence ledger">
      {changes.map((change) => (
        <li
          key={`${change.provider}-${change.id}`}
          className="rounded border border-line bg-surface p-3"
        >
          <article className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${CATEGORY_STYLE[change.category]}`}
                >
                  {change.category}
                </span>
                <span className="text-xs font-medium text-ink-muted">
                  {change.dataSourceName} · {sourceName(change.provider)}
                </span>
                {change.status && (
                  <span className="rounded bg-surface-strong px-2 py-0.5 text-xs text-ink-secondary">
                    {change.status}
                  </span>
                )}
              </div>
              <h2 className="mt-2 break-words font-medium text-ink">
                {isHttpUrl(change.url) ? (
                  <a href={change.url} className="text-accent hover:underline">
                    {change.title}
                  </a>
                ) : (
                  change.title
                )}
              </h2>
              <p className="mt-1 break-words text-sm text-ink-muted">
                {change.repository ?? 'Repository not reported'}
                {change.ref ? ` · ${change.ref.replace(/^refs\/(heads|tags)\//, '')}` : ''}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                {change.actor ? `By ${change.actor}` : 'Actor not reported'}
                {change.sha ? ` · ${change.sha.slice(0, 12)}` : ''}
              </p>
            </div>
            <time
              dateTime={change.occurredAt}
              title={formatAbsoluteTime(change.occurredAt)}
              className="shrink-0 text-xs text-ink-muted"
            >
              {relativeTime(change.occurredAt, now)}
            </time>
          </article>
        </li>
      ))}
    </ol>
  );
}
