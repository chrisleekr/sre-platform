import type { GraphNode, TopologyGraph, TopologyIncident } from '../lib/topology';
import { activeIncidents, topologyIncidentServices } from '../lib/topology';
import { formatAbsoluteTime, relativeTime } from '../lib/time';
import type { InvestigationDeclaration, InvestigationSubject } from '../lib/investigations';
import { InvestigationAction } from './InvestigationAction';
import type { ReactNode } from 'react';

export interface NodeDetailProps {
  node: GraphNode;
  incidents: TopologyIncident[];
  graph?: TopologyGraph;
  onClose: () => void;
  activeIncidentId?: string | null;
  declareInvestigation?: (subject: InvestigationSubject) => Promise<InvestigationDeclaration>;
  onSelect?: (node: GraphNode) => void;
  reliability?: ReactNode;
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
  onSelect,
  reliability,
}: NodeDetailProps) {
  const now = Date.now();
  const activeAlerts = activeIncidents(incidents).filter((i) =>
    graph ? topologyIncidentServices(graph, i).includes(node.name) : i.service === node.name,
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
      className="order-first w-full min-w-0 shrink-0 self-start rounded border border-line bg-surface p-4 text-sm lg:order-last lg:sticky lg:top-4 lg:w-80"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="break-all font-medium tracking-tight">{node.name}</h2>
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

      {reliability}
      <section className="mb-4">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Runtime</h3>
        {node.runtime ? (
          <div className="space-y-1 text-xs text-ink-muted">
            <p>
              Mapped namespaces <span className="font-instrument">{node.runtime.namespace}</span>
            </p>
            {node.runtime.scopes?.map((scope) => (
              <p key={`${scope.dataSourceId}/${scope.namespace}/${scope.environment}`}>
                {scope.environment} ·{' '}
                {graph?.coverage?.find((source) => source.dataSourceId === scope.dataSourceId)
                  ?.dataSourceName ?? 'Unavailable connection'}{' '}
                / {scope.namespace}
                {' · '}
                <a
                  className="text-accent underline"
                  href={`/w/connectors?connection=${encodeURIComponent(scope.dataSourceId)}`}
                >
                  Connection
                </a>
              </p>
            ))}
            <p>Runtime health does not measure request success or service availability.</p>
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
            <p className="mb-2 text-xs text-ink-muted">
              Investigates this logical service across all confirmed runtime scopes.
            </p>
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
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
          Relationships
        </h3>
        {callers.length === 0 && dependencies.length === 0 ? (
          <p className="text-xs text-ink-muted">No registered service relationships.</p>
        ) : (
          <div className="space-y-2 text-xs text-ink-muted">
            {(
              [
                ['Called by', callers, 'upstream'],
                ['Depends on', dependencies, 'downstream'],
              ] as const
            ).map(([label, edges, endpoint]) => (
              <div key={label}>
                <h4 className="font-medium">{label}</h4>
                {edges.length === 0 ? (
                  <p>None registered</p>
                ) : (
                  <ul>
                    {edges.map((edge) => (
                      <li key={JSON.stringify([edge[endpoint], edge.environment ?? ''])}>
                        <button
                          type="button"
                          className="sre-hit-target break-all text-accent underline"
                          onClick={() => {
                            const target = graph?.nodes.find(
                              (item) => item.name === edge[endpoint],
                            );
                            if (target) onSelect?.(target);
                          }}
                        >
                          {edge[endpoint]}
                        </button>{' '}
                        ({edge.syncType}
                        {edge.circuitBreaker ? ', breaker' : ''}
                        {edge.protocol ? `, ${edge.protocol}` : ''}){' · '}
                        {edge.environment || 'Unscoped'}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-4">
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
          Reported deployment matches
        </h3>
        <p className="mb-2 text-xs text-ink-muted">
          Matched by the provider's service name, not a confirmed runtime association. Check the
          connection and environment before treating a deployment as relevant.
        </p>
        {node.recentDeploys.length === 0 ? (
          <p className="text-xs text-ink-muted">No deploys.</p>
        ) : (
          <ul className="space-y-1">
            {node.recentDeploys.map((d) => (
              <li
                key={d.id ?? `${d.sha}/${d.deployedAt}`}
                className="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span className="min-w-0 break-all font-instrument text-xs text-ink-muted">
                  {d.sha}
                </span>
                <span className="text-xs text-ink-muted">
                  {d.environment ?? 'Environment not recorded'}
                  {d.dataSourceName || d.source ? ` · ${d.dataSourceName ?? d.source}` : ''}
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
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
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
                  <a
                    href={`/w/incidents/${i.id}`}
                    className="basis-full text-xs text-accent underline"
                  >
                    {i.title}
                  </a>
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
