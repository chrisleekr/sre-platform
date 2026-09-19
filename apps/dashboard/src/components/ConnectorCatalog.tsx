import { useState } from 'react';
import type { ConnectorSummary } from '../lib/connectors';
import { CONNECTOR_CATALOG, type ManagedConnectorType } from './connectorPresentation';

const CATEGORIES: Record<ManagedConnectorType, string> = {
  kubernetes: 'Infrastructure',
  argocd: 'Code & delivery',
  github: 'Code & delivery',
  gitlab: 'Code & delivery',
  datadog: 'Metrics & logs',
  grafana: 'Metrics & logs',
  prometheus: 'Metrics & logs',
  statuscake: 'Uptime',
};
const PROVIDERS = [
  ...CONNECTOR_CATALOG.map((item) => ({ ...item, category: CATEGORIES[item.type] })),
  {
    type: 'slack' as const,
    name: 'Slack',
    category: 'Chat',
    description: 'Receive alerts and investigate with your team in subscribed channels.',
  },
];

export function ConnectorCatalog({
  connectors,
  unavailable,
  slackConfigured,
  slackUnavailable,
  onAdd,
  onSlack,
}: {
  connectors: ConnectorSummary[];
  unavailable: boolean;
  slackConfigured: boolean;
  slackUnavailable: boolean;
  onAdd: (type: ManagedConnectorType, trigger: HTMLButtonElement) => void;
  onSlack: () => void;
}) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All categories');
  const visible = PROVIDERS.filter(
    (p) =>
      (category === 'All categories' || category === p.category) &&
      [p.name, p.description, p.category]
        .join(' ')
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <section aria-label="Available providers">
      <div className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="text-sm font-medium">
          Search providers
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tools or capabilities, e.g. metrics"
            className="sre-field mt-1 block w-full"
          />
        </label>
        <label className="text-sm font-medium">
          Category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="sre-field mt-1 block w-full"
          >
            {['All categories', ...new Set(PROVIDERS.map((p) => p.category))].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <p role="status" className="mb-3 text-sm text-ink-muted">
        {visible.length} providers
      </p>
      {visible.length === 0 && (
        <p className="rounded-lg border border-line p-6">
          No matching providers. Try another name or category.
        </p>
      )}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map((item) => {
          const saved = connectors.filter((c) => c.type === item.type);
          const count = item.type === 'slack' ? Number(slackConfigured) : saved.length;
          const singleton =
            item.type === 'slack' || saved.some((c) => c.capabilities?.instances === 'singleton');
          const disabled = item.type === 'slack' ? slackUnavailable : unavailable;
          return (
            <li key={item.type}>
              <article className="flex h-full min-w-0 flex-col rounded-lg border border-line bg-surface p-5">
                <p className="mb-2 text-xs font-medium text-ink-muted">{item.category}</p>
                <h2 className="font-medium text-ink">{item.name}</h2>
                <p className="mt-2 flex-1 text-sm leading-6 text-ink-muted">{item.description}</p>
                {count > 0 && <p className="mt-3 text-xs text-ink-muted">{count} configured</p>}
                <button
                  type="button"
                  disabled={disabled || (singleton && count > 0 && item.type !== 'slack')}
                  onClick={(e) =>
                    item.type === 'slack' ? onSlack() : onAdd(item.type, e.currentTarget)
                  }
                  className="sre-action mt-4 min-h-10 self-start"
                >
                  {item.type === 'slack' && count > 0
                    ? 'Manage Slack'
                    : singleton && count > 0
                      ? 'Already configured'
                      : (count > 0 ? 'Add another ' : 'Add ') + item.name}
                </button>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
