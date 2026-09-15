import type { GraphNode } from '../lib/topology';
import { relativeTime } from '../lib/time';

const STATUS_STYLE: Record<NonNullable<GraphNode['status']>, string> = {
  incident: 'bg-critical-muted text-critical',
  attention: 'bg-warning-muted text-warning',
  stale: 'bg-warning-muted text-warning',
  healthy: 'bg-success-muted text-success',
  unknown: 'bg-surface-strong text-ink-secondary',
};

const STATUS_LABEL: Record<NonNullable<GraphNode['status']>, string> = {
  incident: 'Active incident',
  attention: 'Needs attention',
  stale: 'Stale telemetry',
  healthy: 'Runtime healthy',
  unknown: 'Evidence incomplete',
};

export interface TopologyServiceListProps {
  nodes: GraphNode[];
  selected?: string | null;
  onSelect?: (node: GraphNode) => void;
}

/** Keyboard-native projection of the currently filtered topology services. */
export function TopologyServiceList({ nodes, selected, onSelect }: TopologyServiceListProps) {
  const now = Date.now();

  return (
    <ul className="min-w-0 space-y-2" aria-label="Topology services">
      {nodes.map((node) => {
        const latestDeploy = node.recentDeploys[0];
        return (
          <li key={node.name} className="min-w-0">
            <button
              type="button"
              aria-pressed={selected === node.name}
              onClick={() => onSelect?.(node)}
              className="grid w-full min-w-0 gap-2 rounded-md border border-line bg-surface p-3 text-left text-sm hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] aria-pressed:border-line-strong aria-pressed:bg-surface-subtle"
            >
              <span className="min-w-0">
                <span className="block break-all font-medium text-ink">{node.name}</span>
                <span className="mt-1 block break-words text-xs text-ink-muted">
                  {node.sources?.join(' · ') ?? 'catalog'}
                </span>
              </span>
              <span className="min-w-0">
                <span
                  className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLE[node.status ?? 'unknown']}`}
                >
                  {STATUS_LABEL[node.status ?? 'unknown']}
                </span>
              </span>
              <span className="min-w-0 break-words text-ink-muted">
                {node.runtime ? (
                  <>
                    <span className="block">
                      {node.runtime.healthy}/{node.runtime.pods} pods healthy
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {node.runtime.restarts} restarts · {node.runtime.oomKilled} OOM killed
                    </span>
                  </>
                ) : (
                  'No Kubernetes runtime'
                )}
              </span>
              <span className="min-w-0 break-words text-ink-muted">
                <span className="block">{node.team ?? 'No team'}</span>
                <span className="block text-xs text-ink-muted">
                  {node.criticality ?? 'No criticality'}
                </span>
              </span>
              <span className="min-w-0 break-words text-ink-muted">
                {latestDeploy ? (
                  <>
                    <span className="block">Reported deployment · {latestDeploy.status}</span>
                    <time
                      className="block text-xs text-ink-muted"
                      dateTime={latestDeploy.deployedAt}
                    >
                      {relativeTime(latestDeploy.deployedAt, now)}
                    </time>
                  </>
                ) : node.lastDeployAt ? (
                  <time dateTime={node.lastDeployAt}>{relativeTime(node.lastDeployAt, now)}</time>
                ) : (
                  'No recorded deployment'
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
