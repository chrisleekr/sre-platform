import type { GraphNode, ServiceStatus, TopologyGraph } from '../lib/topology';

export function TopologySummary({ graph }: { graph: TopologyGraph }) {
  const pods = (graph.infrastructure ?? []).filter((row) => row.kind === 'pod').length;
  const nodes = (graph.infrastructure ?? []).filter(
    (row) => row.kind === 'node' && !row.error,
  ).length;
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink">
        {graph.historicalAt ? 'Recorded topology' : 'Operational overview'}
      </h2>
      <p className="text-xs text-ink-muted">
        {graph.nodes.length} services · {graph.edges.length} registered relationships
        {!graph.historicalAt && (
          <>
            {' '}
            · source inventory: {pods} pods · {nodes} nodes
          </>
        )}
      </p>
    </div>
  );
}

const statuses: Array<{ status: ServiceStatus; label: string; className: string }> = [
  {
    status: 'incident',
    label: 'Active incident',
    className: 'border-critical-line bg-critical-soft text-critical',
  },
  {
    status: 'attention',
    label: 'Needs attention',
    className: 'border-warning-line bg-warning-soft text-warning',
  },
  {
    status: 'stale',
    label: 'Stale',
    className: 'border-warning-line bg-warning-soft text-warning',
  },
  {
    status: 'healthy',
    label: 'Runtime healthy',
    className: 'border-success-line bg-success-soft text-success',
  },
  {
    status: 'unknown',
    label: 'Evidence incomplete',
    className: 'border-line bg-surface-subtle text-ink-secondary',
  },
];

export const TOPOLOGY_STATUSES = statuses.map(({ status, label }) => ({ status, label }));

/** Runtime evidence and incident presence are distinct from service-level reliability. */
export function TopologyOverview({
  nodes,
  selected,
  onSelect,
}: {
  nodes: GraphNode[];
  selected: ServiceStatus | 'all';
  onSelect: (value: ServiceStatus | 'all') => void;
}) {
  const counts = nodes.reduce<Record<ServiceStatus, number>>(
    (totals, node) => {
      totals[node.status ?? 'unknown'] += 1;
      return totals;
    },
    { incident: 0, attention: 0, stale: 0, healthy: 0, unknown: 0 },
  );
  return (
    <div aria-label="Topology health overview" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {statuses.map(({ status, label, className }) => (
        <button
          type="button"
          key={status}
          aria-pressed={selected === status}
          onClick={() => onSelect(selected === status ? 'all' : status)}
          className={`rounded-md border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-pressed:ring-2 aria-pressed:ring-current ${className}`}
        >
          <span className="block text-xs font-medium">{label}</span>
          <span className="mt-1 block text-2xl font-semibold">{counts[status]}</span>
        </button>
      ))}
    </div>
  );
}
