import { useState } from 'react';
import type { InfraSnapshot } from '../lib/types';
import { infrastructureHealth, type InfraHealth } from '../lib/infrastructure';
import { formatAbsoluteTime, relativeTime } from '../lib/time';
import {
  investigationSubjectKey,
  type InvestigationDeclaration,
  type InvestigationSubject,
} from '../lib/investigations';
import { InvestigationAction } from './InvestigationAction';
import { StatePanel } from './PageState';

type StatusFilter = 'all' | 'issues' | InfraHealth;
type KindFilter = 'all' | 'pod' | 'node';

const HEALTH_ORDER: Record<InfraHealth, number> = {
  error: 0,
  stale: 1,
  attention: 2,
  healthy: 3,
};

const HEALTH_STYLE: Record<InfraHealth, string> = {
  error: 'bg-critical-muted text-critical',
  stale: 'bg-warning-muted text-warning',
  attention: 'bg-warning-muted text-warning',
  healthy: 'bg-success-muted text-success',
};

function summarizeMetrics(metrics: Record<string, number>): string {
  const summary = Object.entries(metrics)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  return summary || 'No metrics';
}

function groupBySource(snapshots: InfraSnapshot[]): [string, InfraSnapshot[]][] {
  const groups = new Map<string, InfraSnapshot[]>();
  for (const snapshot of snapshots) {
    const list = groups.get(snapshot.dataSourceId) ?? [];
    list.push(snapshot);
    groups.set(snapshot.dataSourceId, list);
  }
  return [...groups];
}

function resourceName(snapshot: InfraSnapshot): string {
  const prefix = snapshot.namespace ? `${snapshot.namespace}/` : '';
  return prefix && snapshot.entityId.startsWith(prefix)
    ? snapshot.entityId.slice(prefix.length)
    : snapshot.entityId;
}

function searchableText(snapshot: InfraSnapshot): string {
  return [
    snapshot.source,
    snapshot.dataSourceName,
    snapshot.entityId,
    snapshot.kind,
    snapshot.namespace,
    snapshot.phase,
    snapshot.error,
    snapshot.pressures?.join(' '),
    snapshot.containers
      ?.flatMap((container) => [
        container.name,
        container.waitingReason,
        container.terminatedReason,
        container.lastTerminatedReason,
      ])
      .join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function statusMatches(status: StatusFilter, health: InfraHealth): boolean {
  if (status === 'all') return true;
  if (status === 'issues') return health !== 'healthy';
  return status === health;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function PodSignals({ snapshot, now }: { snapshot: InfraSnapshot; now: number }) {
  const phase = snapshot.phase ?? 'Unknown phase';
  const ready = snapshot.metrics.ready;
  const restarts = snapshot.metrics.restartCount ?? 0;
  const oomKilled = (snapshot.metrics.oomKilled ?? 0) > 0;
  const containerIssues =
    snapshot.containers?.flatMap((container) => {
      const reason =
        container.waitingReason ??
        (snapshot.phase === 'Succeeded' ? undefined : container.terminatedReason);
      return reason ? [`${container.name ?? 'container'}: ${reason}`] : [];
    }) ?? [];
  const previousTerminations =
    snapshot.containers?.flatMap((container) =>
      container.lastTerminatedReason ? [container] : [],
    ) ?? [];

  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-ink-secondary">
        {phase}
        {ready !== undefined && phase !== 'Succeeded'
          ? ` · ${ready === 1 ? 'Ready' : 'Not ready'}`
          : ''}
        {` · ${plural(restarts, 'restart')}`}
        {oomKilled ? ' · OOM killed' : ''}
      </p>
      {containerIssues.length > 0 && (
        <ul className="space-y-0.5 text-xs text-critical" aria-label="Container issues">
          {containerIssues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {previousTerminations.length > 0 && (
        <ul className="space-y-0.5 text-xs text-ink-muted" aria-label="Previous terminations">
          {previousTerminations.map((container, index) => (
            <li key={`${container.name ?? 'container'}-${index}`}>
              Previous termination: {container.name ?? 'container'}:{' '}
              {container.lastTerminatedReason}
              {container.lastTerminatedAt ? (
                <>
                  {' · '}
                  <time
                    dateTime={container.lastTerminatedAt}
                    title={formatAbsoluteTime(container.lastTerminatedAt)}
                  >
                    {relativeTime(container.lastTerminatedAt, now)}
                  </time>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NodeSignals({ snapshot }: { snapshot: InfraSnapshot }) {
  const ready = snapshot.metrics.ready;
  const pressures = snapshot.pressures ?? [];
  return (
    <p className="break-words text-ink-secondary">
      {ready === 1 ? 'Ready' : ready === 0 ? 'Not ready' : 'Readiness unavailable'}
      {pressures.length > 0 ? ` · Pressure: ${pressures.join(', ')}` : ' · No pressure'}
    </p>
  );
}

function ResourceSignals({ snapshot, now }: { snapshot: InfraSnapshot; now: number }) {
  if (snapshot.error) return <p className="break-words text-critical">{snapshot.error}</p>;
  if (snapshot.kind === 'pod') return <PodSignals snapshot={snapshot} now={now} />;
  if (snapshot.kind === 'node') return <NodeSignals snapshot={snapshot} />;
  return <p className="break-words text-ink-muted">{summarizeMetrics(snapshot.metrics)}</p>;
}

/** Current connector inventory with issue-first health, Kubernetes scope, and operational signals. */
export function InfrastructureList({
  snapshots,
  activeInvestigations,
  declareInvestigation,
}: {
  snapshots: InfraSnapshot[];
  activeInvestigations?: Map<string, string>;
  declareInvestigation?: (subject: InvestigationSubject) => Promise<InvestigationDeclaration>;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [namespace, setNamespace] = useState('all');

  if (snapshots.length === 0) {
    return (
      <StatePanel
        state="empty"
        title="No infrastructure data yet."
        description="Snapshots from configured connectors will appear here."
      />
    );
  }

  const now = Date.now();
  const health = new Map(
    snapshots.map((snapshot) => [snapshot, infrastructureHealth(snapshot, now)]),
  );
  const healthCounts = snapshots.reduce<Record<InfraHealth, number>>(
    (counts, snapshot) => {
      counts[health.get(snapshot)!] += 1;
      return counts;
    },
    { error: 0, stale: 0, attention: 0, healthy: 0 },
  );
  const namespaces = [...new Set(snapshots.flatMap((snapshot) => snapshot.namespace ?? []))].sort(
    (a, b) => a.localeCompare(b),
  );
  const normalizedSearch = search.trim().toLowerCase();
  const filtered = snapshots.filter((snapshot) => {
    const snapshotHealth = health.get(snapshot)!;
    return (
      statusMatches(status, snapshotHealth) &&
      (kind === 'all' || snapshot.kind === kind) &&
      (namespace === 'all' || snapshot.namespace === namespace) &&
      (!normalizedSearch || searchableText(snapshot).includes(normalizedSearch))
    );
  });
  const filtersActive =
    search.length > 0 || status !== 'all' || kind !== 'all' || namespace !== 'all';
  const latestObservedAt = snapshots.reduce((latest, snapshot) => {
    const time = Date.parse(snapshot.observedAt);
    return Number.isNaN(time) ? latest : Math.max(latest, time);
  }, 0);
  const cellClass =
    'grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] gap-2 break-words py-1 before:text-xs before:font-medium before:text-ink-muted before:content-[attr(data-label)] lg:table-cell lg:px-2 lg:py-2 lg:align-top lg:before:hidden';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">Current health</h2>
          <p className="text-xs text-ink-muted">
            {plural(snapshots.length, 'resource')} across {plural(namespaces.length, 'namespace')}
          </p>
        </div>
        {latestObservedAt > 0 && (
          <p className="text-xs text-ink-muted">
            Latest observation{' '}
            <time
              dateTime={new Date(latestObservedAt).toISOString()}
              title={formatAbsoluteTime(new Date(latestObservedAt).toISOString())}
            >
              {relativeTime(new Date(latestObservedAt).toISOString(), now)}
            </time>
          </p>
        )}
      </div>

      <dl aria-label="Infrastructure overview" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            ['Healthy', healthCounts.healthy, 'border-success-line bg-success-soft text-success'],
            [
              'Attention',
              healthCounts.attention,
              'border-warning-line bg-warning-soft text-warning',
            ],
            ['Stale', healthCounts.stale, 'border-warning-line bg-warning-soft text-warning'],
            ['Errors', healthCounts.error, 'border-critical-line bg-critical-soft text-critical'],
          ] as const
        ).map(([label, count, className]) => (
          <div key={label} className={`rounded-md border p-3 ${className}`}>
            <dt className="text-xs font-medium">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold">{count}</dd>
          </div>
        ))}
      </dl>

      <div className="sre-filter-shell rounded-md border border-line bg-surface-subtle p-3">
        <div className="sre-filter-grid">
          <label className="text-xs font-medium text-ink-muted">
            Search current snapshot
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="mt-1 block w-full rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-info-line focus:outline-none"
            />
          </label>
          <label className="text-xs font-medium text-ink-muted">
            Status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
              className="mt-1 block w-full rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-info-line focus:outline-none"
            >
              <option value="all">All statuses</option>
              <option value="issues">All issues</option>
              <option value="healthy">Healthy</option>
              <option value="attention">Attention</option>
              <option value="stale">Stale</option>
              <option value="error">Errors</option>
            </select>
          </label>
          <label className="text-xs font-medium text-ink-muted">
            Kind
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as KindFilter)}
              className="mt-1 block w-full rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-info-line focus:outline-none"
            >
              <option value="all">All kinds</option>
              <option value="pod">Pods</option>
              <option value="node">Nodes</option>
            </select>
          </label>
          <label className="text-xs font-medium text-ink-muted">
            Namespace
            <select
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              className="mt-1 block w-full rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-info-line focus:outline-none"
            >
              <option value="all">All namespaces</option>
              {namespaces.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!filtersActive}
            onClick={() => {
              setSearch('');
              setStatus('all');
              setKind('all');
              setNamespace('all');
            }}
            className="rounded border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear filters
          </button>
        </div>
        <p className="mt-3 text-xs text-ink-muted" role="status">
          Showing {filtered.length} of {snapshots.length} resources. Issues are shown first.
        </p>
      </div>

      {filtered.length === 0 ? (
        <StatePanel
          state="empty"
          title="No resources match these filters."
          description="Clear or adjust the current snapshot filters."
        />
      ) : (
        groupBySource(filtered).map(([dataSourceId, items]) => {
          const source = items[0]!;
          const sorted = [...items].sort((a, b) => {
            const healthDifference = HEALTH_ORDER[health.get(a)!] - HEALTH_ORDER[health.get(b)!];
            if (healthDifference !== 0) return healthDifference;
            const namespaceDifference = (a.namespace ?? '').localeCompare(b.namespace ?? '');
            return namespaceDifference || a.entityId.localeCompare(b.entityId);
          });
          return (
            <section key={dataSourceId}>
              <h2 className="mb-2 font-instrument text-xs uppercase tracking-wide text-ink-muted">
                {source.dataSourceName} · {source.source} · {plural(items.length, 'resource')}
              </h2>
              <table className="block w-full table-fixed border-separate border-spacing-0 lg:table">
                <thead className="hidden lg:table-header-group">
                  <tr className="text-left text-xs text-ink-muted">
                    <th className="w-24 px-2 py-2 font-medium">Health</th>
                    <th className="px-2 py-2 font-medium">Resource</th>
                    <th className="w-40 px-2 py-2 font-medium">Namespace</th>
                    <th className="px-2 py-2 font-medium">Signals</th>
                    <th className="w-40 px-2 py-2 font-medium">Observed</th>
                    {declareInvestigation ? (
                      <th className="w-44 px-2 py-2 font-medium">Investigation</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="block lg:table-row-group">
                  {sorted.map((snapshot) => {
                    const snapshotHealth = health.get(snapshot)!;
                    const subject: InvestigationSubject = {
                      kind: 'infrastructure_resource',
                      dataSourceId: snapshot.dataSourceId,
                      entityId: snapshot.entityId,
                    };
                    return (
                      <tr
                        key={`${snapshot.dataSourceId}/${snapshot.entityId}`}
                        className="mb-3 grid min-w-0 gap-1 rounded-md border border-line p-3 text-sm last:mb-0 lg:mb-0 lg:table-row lg:border-0 lg:p-0"
                      >
                        <td data-label="Health" className={cellClass}>
                          <span
                            className={`w-fit rounded px-1.5 py-0.5 text-xs font-medium capitalize ${HEALTH_STYLE[snapshotHealth]}`}
                          >
                            {snapshotHealth}
                          </span>
                        </td>
                        <td data-label="Resource" className={`${cellClass} font-medium`}>
                          <span className="min-w-0">
                            <span className="block break-words" title={snapshot.entityId}>
                              {resourceName(snapshot)}
                            </span>
                            <span className="mt-0.5 block text-xs font-normal text-ink-muted">
                              {snapshot.kind ?? snapshot.source}
                            </span>
                          </span>
                        </td>
                        <td data-label="Namespace" className={`${cellClass} text-ink-muted`}>
                          {snapshot.namespace ?? 'Cluster-scoped'}
                        </td>
                        <td data-label="Signals" className={cellClass}>
                          <ResourceSignals snapshot={snapshot} now={now} />
                        </td>
                        <td data-label="Observed" className={`${cellClass} text-ink-muted`}>
                          <span className="min-w-0">
                            <time
                              dateTime={snapshot.observedAt}
                              title={formatAbsoluteTime(snapshot.observedAt)}
                            >
                              {relativeTime(snapshot.observedAt, now)}
                            </time>
                            <span className="mt-0.5 block break-words text-xs text-ink-muted">
                              {formatAbsoluteTime(snapshot.observedAt)}
                            </span>
                          </span>
                        </td>
                        {declareInvestigation ? (
                          <td data-label="Investigation" className={cellClass}>
                            {snapshotHealth !== 'healthy' ? (
                              <InvestigationAction
                                subject={subject}
                                activeIncidentId={activeInvestigations?.get(
                                  investigationSubjectKey(subject),
                                )}
                                preview={{
                                  title: `${snapshot.entityId} needs attention`,
                                  source: `${snapshot.dataSourceName} · ${snapshot.entityId}`,
                                  condition:
                                    snapshot.error ??
                                    `${snapshotHealth} · ${summarizeMetrics(snapshot.metrics)}`,
                                  severity: snapshotHealth === 'error' ? 'SEV2' : 'SEV3',
                                }}
                                declareInvestigation={declareInvestigation}
                              />
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          );
        })
      )}
    </div>
  );
}
