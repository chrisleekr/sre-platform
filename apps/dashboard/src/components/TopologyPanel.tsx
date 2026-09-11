import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { useTopology, fetchBlastRadius } from '../lib/useTopology';
import { useIncidents } from '../lib/useIncidents';
import {
  activeIncident,
  activeIncidents,
  filterTopologyGraph,
  operationalTopologyGraph,
} from '../lib/topology';
import type { BlastRadius, GraphNode, ServiceStatus, TopologySource } from '../lib/topology';
import { formatAbsoluteTime, relativeTime } from '../lib/time';
import { DeploymentGraph } from './DeploymentGraph';
import { NodeDetail, runtimeNeedsInvestigation } from './NodeDetail';
import { PageHeader } from './PageHeader';
import { StatePanel } from './PageState';
import { TopologyServiceList } from './TopologyServiceList';
import { TopologyCatalogManager } from './TopologyCatalogManager';
import {
  declareInvestigation,
  investigationSubjectKey,
  type InvestigationSubject,
} from '../lib/investigations';
import { useInvestigationWorkspaces } from '../lib/useInvestigationWorkspaces';

type Representation = 'map' | 'list';

const STATUS_SUMMARY: Array<{
  status: ServiceStatus;
  label: string;
  className: string;
}> = [
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
    label: 'Healthy',
    className: 'border-success-line bg-success-soft text-success',
  },
  {
    status: 'unknown',
    label: 'No telemetry',
    className: 'border-line bg-surface-subtle text-ink-secondary',
  },
];

function initialRepresentation(): Representation {
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches
    ? 'list'
    : 'map';
}

/**
 * The Service topology panel: operational service inventory plus the registered dependency graph,
 * with a blast-radius overlay driven by the selected active incident and inline per-service detail.
 * Data owner: it calls the topology/incident hooks and passes plain props to its views.
 */
export function TopologyPanel() {
  const { getCredentials } = useSession();

  const { graph, loading, error, refetch } = useTopology({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  });
  const { incidents } = useIncidents({ apiBaseUrl: config.apiBaseUrl, getCredentials });

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [representation, setRepresentation] = useState<Representation>(initialRepresentation);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ServiceStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<TopologySource | 'all'>('all');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [blastRadius, setBlastRadius] = useState<BlastRadius | null>(null);
  const selectionTargetRef = useRef<{ focus: () => void; isConnected: boolean } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const representationInitializedRef = useRef(false);
  const getTokenRef = useRef(getCredentials);
  getTokenRef.current = getCredentials;

  const currentActiveIncidents = activeIncidents(incidents);
  const defaultIncident = activeIncident(incidents);
  const selectedIncident =
    currentActiveIncidents.find((incident) => incident.id === selectedIncidentId) ??
    defaultIncident;
  const incidentId = selectedIncident?.id ?? null;
  const incidentService = selectedIncident?.service ?? null;
  const operationalGraph = operationalTopologyGraph(graph, incidents, Date.now());
  const topologySubjects = useMemo<InvestigationSubject[]>(
    () =>
      operationalGraph.nodes
        .filter(runtimeNeedsInvestigation)
        .map((node) => ({ kind: 'topology_service', service: node.name })),
    [operationalGraph.nodes],
  );
  const activeInvestigations = useInvestigationWorkspaces({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    subjects: topologySubjects,
  });
  const filteredGraph = filterTopologyGraph(operationalGraph, search, {
    status: statusFilter,
    source: sourceFilter,
  });
  const selectedNode = operationalGraph.nodes.find((node) => node.name === selectedName) ?? null;
  const statusCounts = operationalGraph.nodes.reduce<Record<ServiceStatus, number>>(
    (counts, node) => {
      counts[node.status ?? 'unknown'] += 1;
      return counts;
    },
    { incident: 0, attention: 0, stale: 0, healthy: 0, unknown: 0 },
  );
  const infrastructure = graph.infrastructure ?? [];
  const podCount = infrastructure.filter((snapshot) => snapshot.kind === 'pod').length;
  const nodeCount = infrastructure.filter(
    (snapshot) => snapshot.kind === 'node' && !snapshot.error,
  ).length;
  const latestObservedAt = infrastructure.reduce((latest, snapshot) => {
    const observedAt = Date.parse(snapshot.observedAt);
    return Number.isNaN(observedAt) ? latest : Math.max(latest, observedAt);
  }, 0);
  const infrastructureErrors = infrastructure.filter((snapshot) => snapshot.error);

  // With no relationships, a scatter plot communicates less than the health list. Pick List once when
  // the first graph arrives, then leave the operator's Map/List choice alone.
  useEffect(() => {
    if (loading || operationalGraph.nodes.length === 0 || representationInitializedRef.current)
      return;
    representationInitializedRef.current = true;
    if (operationalGraph.edges.length === 0) setRepresentation('list');
  }, [loading, operationalGraph.edges.length, operationalGraph.nodes.length]);

  // Clear a previous incident's rings before requesting the newly selected service. A late response
  // is discarded when the incident selection changes.
  useEffect(() => {
    setBlastRadius(null);
    if (!incidentService) {
      return;
    }
    let active = true;
    void fetchBlastRadius(config.apiBaseUrl, getTokenRef.current, incidentService)
      .then((br) => {
        if (active) setBlastRadius(br);
      })
      .catch(() => {
        if (active) setBlastRadius(null); // overlay is best-effort; keep the base graph on failure
      });
    return () => {
      active = false;
    };
  }, [incidentId, incidentService]);

  const selectService = (node: GraphNode) => {
    const activeElement = document.activeElement;
    if (
      activeElement &&
      activeElement !== document.body &&
      'focus' in activeElement &&
      typeof activeElement.focus === 'function'
    ) {
      selectionTargetRef.current = activeElement as unknown as {
        focus: () => void;
        isConnected: boolean;
      };
    }
    setSelectedName(node.name);
  };

  const closeDetail = () => {
    setSelectedName(null);
    if (selectionTargetRef.current?.isConnected) {
      selectionTargetRef.current.focus();
    } else {
      searchInputRef.current?.focus();
    }
  };

  return (
    <section className="min-w-0">
      <PageHeader
        title="Service topology"
        action={
          <TopologyCatalogManager
            graph={graph}
            apiBaseUrl={config.apiBaseUrl}
            getCredentials={getCredentials}
            onSaved={refetch}
          />
        }
      />
      <p className="mb-4 max-w-4xl text-sm text-ink-muted">
        Operational services discovered from Kubernetes, active incidents, recent deployments, and
        the explicit service catalog. Health reflects live runtime and incident state; relationships
        are shown only when evidence has been registered.
      </p>
      {loading && <StatePanel state="loading" title="Loading topology…" skeleton="topology" />}
      {/* Show the error only when we have nothing to show; a transient poll failure keeps the
          last-good graph rather than blanking the panel (the hook retains prior data). */}
      {!loading && error && graph.nodes.length === 0 && (
        <StatePanel
          state="error"
          title="Failed to load topology."
          description="The service graph could not be retrieved."
        />
      )}
      {!loading && !error && graph.nodes.length === 0 && (
        <StatePanel
          state="empty"
          title="No services in topology."
          description="Connect Kubernetes, receive an incident, ingest a service-tagged deployment, or register a service to populate the topology."
        />
      )}
      {!loading && !(error && graph.nodes.length === 0) && graph.nodes.length > 0 && (
        <div
          className="min-w-0 space-y-4"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !selectedNode) return;
            event.stopPropagation();
            closeDetail();
          }}
        >
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-ink">Operational overview</h2>
              <p className="text-xs text-ink-muted">
                {operationalGraph.nodes.length} services · {operationalGraph.edges.length}{' '}
                registered relationships · {podCount} pods · {nodeCount} nodes
              </p>
            </div>
            {latestObservedAt > 0 && (
              <p className="text-xs text-ink-muted">
                Runtime observed{' '}
                <time
                  dateTime={new Date(latestObservedAt).toISOString()}
                  title={formatAbsoluteTime(new Date(latestObservedAt).toISOString())}
                >
                  {relativeTime(new Date(latestObservedAt).toISOString(), Date.now())}
                </time>
              </p>
            )}
          </div>
          <div
            aria-label="Topology health overview"
            className="grid grid-cols-2 gap-2 sm:grid-cols-5"
          >
            {STATUS_SUMMARY.map(({ status, label, className }) => (
              <button
                type="button"
                key={status}
                aria-pressed={statusFilter === status}
                onClick={() => setStatusFilter(statusFilter === status ? 'all' : status)}
                className={`rounded-md border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-pressed:ring-2 aria-pressed:ring-current aria-pressed:ring-offset-1 ${className}`}
              >
                <span className="block text-xs font-medium">{label}</span>
                <span className="mt-1 block text-2xl font-semibold">{statusCounts[status]}</span>
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface-subtle p-3 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="flex gap-2" aria-label="Topology representation">
              <button
                type="button"
                aria-pressed={representation === 'map'}
                onClick={() => setRepresentation('map')}
                className="rounded border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-pressed:border-line-strong aria-pressed:bg-line"
              >
                Map
              </button>
              <button
                type="button"
                aria-pressed={representation === 'list'}
                onClick={() => setRepresentation('list')}
                className="rounded border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-pressed:border-line-strong aria-pressed:bg-line"
              >
                List
              </button>
            </div>
            <label className="min-w-0 flex-1 text-xs font-medium text-ink-muted">
              Search services
              <input
                ref={searchInputRef}
                type="search"
                aria-label="Search services"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="mt-1 block w-full min-w-0 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-info-line focus:outline-none"
              />
            </label>
            <label className="min-w-0 text-xs font-medium text-ink-muted">
              Status
              <select
                aria-label="Topology status"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as ServiceStatus | 'all')}
                className="mt-1 block w-full min-w-0 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-info-line focus:outline-none"
              >
                <option value="all">All statuses</option>
                {STATUS_SUMMARY.map(({ status, label }) => (
                  <option key={status} value={status}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 text-xs font-medium text-ink-muted">
              Source
              <select
                aria-label="Topology source"
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value as TopologySource | 'all')}
                className="mt-1 block w-full min-w-0 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-info-line focus:outline-none"
              >
                <option value="all">All sources</option>
                <option value="kubernetes">Kubernetes</option>
                <option value="incident">Active incident</option>
                <option value="deployment">Deployment</option>
                <option value="catalog">Catalog</option>
              </select>
            </label>
            {selectedIncident && (
              <label className="min-w-0 text-xs font-medium text-ink-muted">
                Incident overlay
                <select
                  aria-label="Incident overlay"
                  value={selectedIncident.id}
                  onChange={(event) => {
                    setBlastRadius(null);
                    setSelectedIncidentId(event.target.value);
                  }}
                  className="mt-1 block w-full min-w-0 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-info-line focus:outline-none"
                >
                  {currentActiveIncidents.map((incident) => (
                    <option key={incident.id} value={incident.id}>
                      {incident.severity.toUpperCase()} · {incident.service} ·{' '}
                      {incident.title ?? incident.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {selectedIncident && (
            <section
              aria-label="Selected incident context"
              className="rounded-md border border-critical-line bg-critical-soft p-3 text-sm text-critical"
            >
              <p className="font-semibold">
                {selectedIncident.severity.toUpperCase()} · {selectedIncident.status} ·{' '}
                {selectedIncident.service}
              </p>
              <p>{selectedIncident.title ?? 'Active incident'}</p>
              {blastRadius?.mapped === false && (
                <p className="mt-1 text-xs text-critical">
                  The affected service is visible from live signals, but dependency blast radius is
                  unavailable until relationships are registered.
                </p>
              )}
            </section>
          )}
          {operationalGraph.edges.length === 0 && (
            <div className="rounded-md border border-info-line bg-info-soft p-3 text-sm text-info">
              <p className="font-medium">No service relationships are registered.</p>
              <p className="mt-1 text-xs text-info">
                Runtime health and incident mapping remain available. The platform does not infer
                call edges from pods sharing a cluster or namespace. Use Edit catalog to register
                ownership and the relationships responders need for blast-radius analysis.
              </p>
            </div>
          )}
          {infrastructureErrors.length > 0 && (
            <div
              role="alert"
              className="rounded-md border border-warning-line bg-warning-soft p-3 text-sm text-warning"
            >
              <p className="font-medium">Runtime coverage is incomplete.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-warning">
                {infrastructureErrors.map((snapshot) => (
                  <li key={`${snapshot.dataSourceId}/${snapshot.entityId}`}>
                    {snapshot.dataSourceName} · {snapshot.entityId}: {snapshot.error}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-warning">
                Available pod health is still shown; restore connector access for the missing scope.
              </p>
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-4 lg:flex-row">
            <div className="min-w-0 flex-1">
              {filteredGraph.nodes.length === 0 ? (
                <StatePanel
                  state="empty"
                  title="No services match your search."
                  description="Clear or adjust the current topology filters."
                />
              ) : representation === 'map' ? (
                <DeploymentGraph
                  graph={filteredGraph}
                  blastRadius={blastRadius}
                  selected={selectedName}
                  onSelect={selectService}
                />
              ) : (
                <TopologyServiceList
                  nodes={filteredGraph.nodes}
                  selected={selectedName}
                  onSelect={selectService}
                />
              )}
            </div>
            {selectedNode && (
              <NodeDetail
                node={selectedNode}
                incidents={incidents}
                graph={operationalGraph}
                onClose={closeDetail}
                activeIncidentId={activeInvestigations.get(
                  investigationSubjectKey({
                    kind: 'topology_service',
                    service: selectedNode.name,
                  }),
                )}
                declareInvestigation={(subject) =>
                  declareInvestigation(config.apiBaseUrl, getCredentials, subject)
                }
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
