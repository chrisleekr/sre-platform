import type { ConnectorSummary } from '../../lib/connectors';
import { Link } from 'react-router-dom';
import type { SurfaceSummary } from '../../lib/surfaces';
import { CONNECTOR_CATALOG, safeConnectorSummary } from '../connectorPresentation';
import { accessEvidence, activityEvidence, slackEvidence, type ConnectionEvidence } from './status';

export interface ConnectionFilters {
  q: string;
  provider: string;
  attention: boolean;
}

function Evidence({ value }: { value: ConnectionEvidence }) {
  return (
    <div className="min-w-0">
      <p className={'text-sm font-medium ' + (value.attention ? 'text-warning' : 'text-ink')}>
        {value.label}
      </p>
      <p className="mt-1 break-words text-xs leading-5 text-ink-muted">{value.detail}</p>
    </div>
  );
}

export function ConnectionInventory({
  connectors,
  surfaces,
  onSelect,
  filters,
  onFiltersChange,
}: {
  connectors: ConnectorSummary[];
  surfaces: SurfaceSummary[];
  onSelect: (id: string) => void;
  filters: ConnectionFilters;
  onFiltersChange: (filters: ConnectionFilters) => void;
}) {
  const search = filters.q;
  const provider = filters.provider;
  const attentionOnly = filters.attention;
  const updateFilters = (values: Partial<ConnectionFilters>) =>
    onFiltersChange({ ...filters, ...values });
  const rows = [
    ...connectors
      .filter((c) => c.capabilities?.availability !== 'incomplete')
      .map((c) => ({
        id: c.id,
        name: c.name,
        provider: CONNECTOR_CATALOG.find((p) => p.type === c.type)?.name ?? c.type,
        scope: safeConnectorSummary(c.type, c.settings),
        access: accessEvidence(c),
        activity: activityEvidence(c),
      })),
    ...surfaces
      .filter((s) => s.surface === 'slack')
      .map((s) => ({
        id: 'slack',
        name: 'Slack',
        provider: 'Slack',
        scope: ['Workspace conversations'],
        ...slackEvidence(s),
      })),
  ];
  const attention = (row: (typeof rows)[number]) => row.access.attention || row.activity.attention;
  const visible = rows
    .filter(
      (row) =>
        (!attentionOnly || attention(row)) &&
        (provider === 'All providers' || provider === row.provider) &&
        [row.name, row.provider, ...row.scope]
          .join(' ')
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(attention(b)) - Number(attention(a)) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  return (
    <section aria-label="Your connections">
      <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="text-sm font-medium">
          Search connections
          <input
            type="search"
            placeholder="Name, provider or scope"
            value={search}
            onChange={(e) => updateFilters({ q: e.target.value })}
            className="sre-field mt-1 block w-full"
          />
        </label>
        <label className="text-sm font-medium">
          Provider
          <select
            value={provider}
            onChange={(e) => updateFilters({ provider: e.target.value })}
            className="sre-field mt-1 block w-full"
          >
            {['All providers', ...new Set(rows.map((r) => r.provider))].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p role="status" className="text-ink-muted">
          {visible.length} of {rows.length} connections
        </p>
        <label className="flex min-h-10 items-center gap-2">
          <input
            type="checkbox"
            checked={attentionOnly}
            onChange={(e) => updateFilters({ attention: e.target.checked })}
          />
          Needs attention ({rows.filter(attention).length})
        </label>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div
          aria-hidden="true"
          className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_7rem] gap-5 border-b border-line bg-surface-subtle px-5 py-3 text-xs font-semibold text-ink-muted lg:grid"
        >
          <span>Connection</span>
          <span>Access</span>
          <span>Data activity</span>
          <span />
        </div>
        <ul className="divide-y divide-line">
          {visible.map((row) => (
            <li key={row.id}>
              <article
                aria-label={row.name}
                className="grid min-w-0 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_7rem] lg:gap-5"
              >
                <div className="min-w-0 sm:col-span-2 lg:col-span-1">
                  <Link
                    to={'?connection=' + encodeURIComponent(row.id)}
                    className="break-words text-left font-semibold text-ink underline-offset-4 hover:underline"
                  >
                    {row.name}
                  </Link>
                  <p className="mt-1 text-xs text-ink-muted">{row.provider}</p>
                  <div className="mt-2 flex flex-wrap gap-x-2 text-xs text-ink-muted">
                    {row.scope.map((s, i) => (
                      <span key={i} className="break-all">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs text-ink-muted lg:hidden">Access</p>
                  <Evidence value={row.access} />
                </div>
                <div>
                  <p className="mb-1 text-xs text-ink-muted lg:hidden">Data activity</p>
                  <Evidence value={row.activity} />
                </div>
                <button
                  type="button"
                  onClick={() => onSelect(row.id)}
                  className="sre-action min-h-10 self-start"
                >
                  {attention(row) ? 'Review setup' : 'View details'}
                </button>
              </article>
            </li>
          ))}
        </ul>
        {visible.length === 0 && (
          <div className="p-6 text-sm">
            <p>No matching connections.</p>
            <button
              type="button"
              className="mt-3 underline"
              onClick={() => {
                updateFilters({ q: '', provider: 'All providers', attention: false });
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
