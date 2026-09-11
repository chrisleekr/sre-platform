import type { GraphNode, TopologyGraph } from '../lib/topology';
import { ACTIVE_INCIDENT_STATUSES } from '../lib/topology';
import type { Incident } from '../lib/types';
import { formatAbsoluteTime, relativeTime } from '../lib/time';
import type { InvestigationDeclaration, InvestigationSubject } from '../lib/investigations';
import { InvestigationAction } from './InvestigationAction';

export interface NodeDetailProps {
  node: GraphNode;
  incidents: Incident[];
  graph?: TopologyGraph;
  onClose: () => void;
  activeIncidentId?: string | null;
  declareInvestigation?: (subject: InvestigationSubject) => Promise<InvestigationDeclaration>;
}

export function runtimeNeedsInvestigation(node: GraphNode): boolean {
  const runtime = node.runtime;
  return !!runtime && runtime.attention + runtime.errors + runtime.stale > 0;
}

/**
 * Inline side-drawer for one service: its recent deploys and active alerts. Pure and presentational;
 * it filters the tenant-wide incident rows down to this service by name, so the owning panel can pass
 * the raw hook data.
 */
export function NodeDetail({
  node,
  incidents,
  graph,
  onClose,
  activeIncidentId,
  declareInvestigation,
}: NodeDetailProps) {
  const now = Date.now();
  const activeAlerts = incidents.filter(
    (i) => i.service === node.name && ACTIVE_INCIDENT_STATUSES.has(i.status),
  );
  const callers = graph?.edges.filter((edge) => edge.downstream === node.name) ?? [];
  const dependencies = graph?.edges.filter((edge) => edge.upstream === node.name) ?? [];

  return (
    <aside
      aria-label={`Service details: ${node.name}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
      className="w-full min-w-0 shrink-0 rounded border border-line bg-surface p-4 text-sm lg:w-80"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="break-all font-semibold tracking-tight">{node.name}</h2>
          <p className="break-words text-xs text-ink-muted">
            {node.team ?? 'no team'}
            {node.criticality ? ` · ${node.criticality}` : ''}
          </p>
          <p className="mt-1 break-words text-xs text-ink-muted">
            {node.sources?.join(' · ') ?? 'catalog'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-strong hover:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Close
        </button>
      </div>

      <section className="mb-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Runtime
        </h3>
        {node.runtime ? (
          <div className="space-y-1 text-xs text-ink-muted">
            <p>
              Kubernetes namespace <span className="font-instrument">{node.runtime.namespace}</span>
            </p>
            <p>
              {node.runtime.healthy}/{node.runtime.pods} pods healthy · {node.runtime.attention}{' '}
              attention · {node.runtime.stale} stale · {node.runtime.errors} errors
            </p>
            <p>
              {node.runtime.restarts} restarts · {node.runtime.oomKilled} OOM-killed pods
            </p>
            {node.runtime.observedAt && (
              <p>
                Observed{' '}
                <time
                  dateTime={node.runtime.observedAt}
                  title={formatAbsoluteTime(node.runtime.observedAt)}
                >
                  {relativeTime(node.runtime.observedAt, now)}
                </time>
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-ink-muted">No live Kubernetes runtime mapped.</p>
        )}
        {declareInvestigation && runtimeNeedsInvestigation(node) ? (
          <div className="mt-3">
            <InvestigationAction
              subject={{ kind: 'topology_service', service: node.name }}
              activeIncidentId={activeIncidentId}
              preview={{
                title: `${node.name} runtime needs attention`,
                source: `Topology · ${node.name}`,
                condition: node.runtime
                  ? `${node.runtime.attention + node.runtime.errors + node.runtime.stale} of ${node.runtime.pods} pods need attention`
                  : 'Runtime telemetry is unavailable',
                severity: node.criticality === 'tier1' ? 'SEV2' : 'SEV3',
              }}
              declareInvestigation={declareInvestigation}
            />
          </div>
        ) : null}
      </section>

      <section className="mb-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Relationships
        </h3>
        {callers.length === 0 && dependencies.length === 0 ? (
          <p className="text-xs text-ink-muted">No registered service relationships.</p>
        ) : (
          <div className="space-y-2 text-xs text-ink-muted">
            <p>
              Called by:{' '}
              {callers.length > 0
                ? callers.map((edge) => edge.upstream).join(', ')
                : 'No registered callers'}
            </p>
            <p>
              Depends on:{' '}
              {dependencies.length > 0
                ? dependencies
                    .map(
                      (edge) =>
                        `${edge.downstream} (${edge.syncType}${edge.circuitBreaker ? ', breaker' : ''})`,
                    )
                    .join(', ')
                : 'No registered dependencies'}
            </p>
          </div>
        )}
      </section>

      <section className="mb-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Recent deploys
        </h3>
        {node.recentDeploys.length === 0 ? (
          <p className="text-xs text-ink-muted">No deploys.</p>
        ) : (
          <ul className="space-y-1">
            {node.recentDeploys.map((d) => (
              <li
                key={`${d.sha}/${d.deployedAt}`}
                className="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span className="min-w-0 break-all font-instrument text-xs text-ink-muted">
                  {d.sha}
                </span>
                {d.ref && (
                  <span className="min-w-0 break-all font-instrument text-xs text-ink-faint">
                    {d.ref}
                  </span>
                )}
                <span className="ml-auto text-xs text-ink-faint">
                  {relativeTime(d.deployedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Active alerts
        </h3>
        {activeAlerts.length === 0 ? (
          <p className="text-xs text-ink-muted">No active alerts.</p>
        ) : (
          <ul className="space-y-1">
            {activeAlerts.map((i) => (
              <li key={i.id} className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-instrument text-xs uppercase text-critical">
                  {i.severity}
                </span>
                <span className="text-xs text-ink-muted">{i.status}</span>
                {i.title && (
                  <span className="basis-full text-xs text-ink-secondary">{i.title}</span>
                )}
                <span className="ml-auto min-w-0 break-all text-xs text-ink-faint">
                  {i.alertSource}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
