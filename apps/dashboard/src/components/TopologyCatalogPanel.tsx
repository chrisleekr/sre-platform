import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import type { UseTopology } from '../lib/useTopology';
import { useTopologyImpact } from '../lib/useTopologyImpact';
import {
  activeIncidents,
  filterTopologyGraph,
  operationalTopologyGraph,
  topologyIncidentServices,
  topologyIncidentTitle,
  scopeTopologyGraph,
} from '../lib/topology';
import type { GraphNode, ServiceStatus, TopologySource } from '../lib/topology';
import { formatAbsoluteTime } from '../lib/time';
import { DeploymentGraph } from './DeploymentGraph';
import { NodeDetail, runtimeNeedsInvestigation } from './NodeDetail';
import { StatePanel } from './PageState';
import { TopologyServiceList } from './TopologyServiceList';
import { TopologyCatalogManager } from './TopologyCatalogManager';
import { TopologyImpact } from './TopologyImpact';
import { TopologyCoverage } from './TopologyCoverage';
import { TopologyRuntimeManager } from './TopologyRuntimeManager';
import { TopologyHistory } from './TopologyHistory';
import { TopologyReliability } from './TopologyReliability';
import { TopologyIncidentContext } from './TopologyIncidentContext';
import { TopologyOverview, TopologySummary, TOPOLOGY_STATUSES } from './TopologyOverview';
import {
  declareInvestigation,
  investigationSubjectKey,
  type InvestigationSubject,
} from '../lib/investigations';
import { useInvestigationWorkspaces } from '../lib/useInvestigationWorkspaces';

type Representation = 'map' | 'list';

function initialRepresentation(): Representation {
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches
    ? 'list'
    : 'map';
}

/** Catalog corrections, declared impact and historical evidence for the current workspace. */
export function TopologyCatalogPanel({
  graph,
  loading,
  error,
  refetch,
  at,
  setAt,
}: UseTopology & {
  at: string;
  setAt: (at: string) => void;
}) {
  const { getCredentials } = useSession();
  const incidents = graph.incidents ?? [];

  const [selectedName, setSelectedName] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('catalogService'),
  );
  const [representation, setRepresentation] = useState<Representation>(initialRepresentation);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ServiceStatus | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<TopologySource | 'all'>('all');
  const [environment, setEnvironment] = useState('');
  const [focusNeighbors, setFocusNeighbors] = useState(false);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('incident'),
  );
  const selectionTargetRef = useRef<{ focus: () => void; isConnected: boolean } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const representationInitializedRef = useRef(false);

  const currentActiveIncidents = activeIncidents(incidents);
  const selectedIncident = currentActiveIncidents.find(
    (incident) => incident.id === selectedIncidentId,
  );
  const incidentServices = selectedIncident
    ? topologyIncidentServices(graph, selectedIncident)
    : [];
  const incidentService = incidentServices.length === 1 ? incidentServices[0]! : null;
  const scopedGraph = scopeTopologyGraph(graph, environment);
  const operationalGraph = operationalTopologyGraph(scopedGraph, incidents, Date.now());
  const environments = [
    ...new Set([
      ...graph.edges.flatMap((edge) => (edge.environment ? [edge.environment] : [])),
      ...(graph.runtimeBindings ?? []).map((binding) => binding.environment),
      ...graph.nodes.flatMap((node) =>
        node.recentDeploys.flatMap((deploy) => (deploy.environment ? [deploy.environment] : [])),
      ),
    ]),
  ].sort();
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
    focus: focusNeighbors ? selectedName : null,
  });
  const selectedNode = operationalGraph.nodes.find((node) => node.name === selectedName) ?? null;
  const impactService = selectedNode?.name ?? incidentService;
  const {
    result: blastRadius,
    loading: blastLoading,
    error: blastError,
    retry: retryBlast,
  } = useTopologyImpact(
    config.apiBaseUrl,
    getCredentials,
    graph,
    loading || graph.historicalAt ? null : impactService,
    environment || undefined,
  );
  const infrastructure = graph.infrastructure ?? [];
  const infrastructureErrors = infrastructure.filter((snapshot) => snapshot.error);

  // With no relationships, a scatter plot communicates less than the health list. Pick List once when
  // the first graph arrives, then leave the operator's Map/List choice alone.
  useEffect(() => {
    if (loading || operationalGraph.nodes.length === 0 || representationInitializedRef.current)
      return;
    representationInitializedRef.current = true;
    if (operationalGraph.edges.length === 0) setRepresentation('list');
  }, [loading, operationalGraph.edges.length, operationalGraph.nodes.length]);

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
    setSelectedIncidentId('');
    if (!filteredGraph.nodes.some((item) => item.name === node.name)) {
      setSearch('');
      setStatusFilter('all');
      setSourceFilter('all');
    }
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Service catalog</h2>
        {!graph.historicalAt && (
          <TopologyCatalogManager
            graph={graph}
            apiBaseUrl={config.apiBaseUrl}
            getCredentials={getCredentials}
            onSaved={refetch}
          />
        )}
      </div>
      <p className="mb-4 max-w-4xl text-sm text-ink-muted">
        Explore registered services, their confirmed runtime and declared dependencies. Runtime
        health and potential dependency exposure are not measurements of service availability.
      </p>
      <TopologyHistory
        apiBaseUrl={config.apiBaseUrl}
        getCredentials={getCredentials}
        at={at}
        onChange={(time) => {
          setAt(time);
          setSelectedName(null);
          setSelectedIncidentId('');
          setEnvironment('');
          setStatusFilter('all');
          setSourceFilter('all');
        }}
      />
      {graph.historicalAt && (
        <p className="mb-4 text-sm text-info">
          Recorded declarations at {formatAbsoluteTime(graph.historicalAt)}. Runtime health and
          current impact calculation are not shown in historical mode.
        </p>
      )}
      <TopologyCoverage sources={graph.coverage ?? []} />
      {!loading && !graph.historicalAt && (
        <TopologyRuntimeManager
          graph={graph}
          apiBaseUrl={config.apiBaseUrl}
          getCredentials={getCredentials}
          onSaved={refetch}
        />
      )}
      {loading && <StatePanel state="loading" title="Loading topology…" skeleton="topology" />}
      {!loading && error && graph.nodes.length === 0 && (
        <StatePanel
          state="error"
          title="Failed to load topology."
          description="The service graph could not be retrieved."
        />
      )}
      {!loading &&
        !error &&
        graph.nodes.length === 0 &&
        (graph.historicalAt ? (
          <StatePanel
            state="empty"
            title="No relationships recorded at this time."
            description="History cannot establish dependencies before recording began. Return to live topology to inspect current declarations."
          />
        ) : (
          <div className="border-t border-line pt-3 text-sm text-ink-muted">
            <p className="font-medium">No manual catalog entries</p>
            <p className="mt-1">
              Automatic discovery works independently. Add an entry only to record ownership, a
              known dependency or an explicit correction.
            </p>
          </div>
        ))}
      {!loading && !(error && graph.nodes.length === 0) && graph.nodes.length > 0 && (
        <div
          className="min-w-0 space-y-4"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !selectedNode) return;
            event.stopPropagation();
            closeDetail();
          }}
        >
          {error && (
            <div
              role="alert"
              className="rounded-md border border-warning-line bg-warning-soft p-3 text-sm text-warning"
            >
              Topology refresh failed. Showing the last successful snapshot.{' '}
              <button type="button" onClick={refetch} className="underline">
                Refresh topology
              </button>
            </div>
          )}
          <TopologySummary graph={operationalGraph} />
          {!graph.historicalAt && (
            <TopologyOverview
              nodes={operationalGraph.nodes}
              selected={statusFilter}
              onSelect={setStatusFilter}
            />
          )}
          <div className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface-subtle p-3 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="min-w-0 text-xs font-medium text-ink-muted">
              Environment
              <select
                aria-label="Topology environment"
                value={environment}
                onChange={(event) => {
                  setEnvironment(event.target.value);
                  setSelectedName(null);
                  setSelectedIncidentId('');
                }}
                className="mt-1 block w-full rounded border border-line-strong bg-surface px-3 py-1.5 text-sm"
              >
                <option value="">All environments (combined runtime)</option>
                {environments.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
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
                disabled={Boolean(graph.historicalAt)}
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as ServiceStatus | 'all')}
                className="mt-1 block w-full min-w-0 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-info-line focus:outline-none"
              >
                <option value="all">All statuses</option>
                {TOPOLOGY_STATUSES.map(({ status, label }) => (
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
                disabled={Boolean(graph.historicalAt)}
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
            {currentActiveIncidents.length > 0 && (
              <label className="w-full min-w-0 text-xs font-medium text-ink-muted">
                Incident overlay
                <select
                  aria-label="Incident overlay"
                  value={selectedIncident?.id ?? ''}
                  onChange={(event) => {
                    setSelectedName(null);
                    setSelectedIncidentId(event.target.value);
                  }}
                  className="mt-1 block w-full min-w-0 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink focus:border-info-line focus:outline-none"
                >
                  <option value="">No incident overlay</option>
                  {currentActiveIncidents.map((incident) => (
                    <option key={incident.id} value={incident.id}>
                      {incident.severity.toUpperCase()} · {topologyIncidentTitle(incident)}
                      {topologyIncidentTitle(incident) === `Incident ${incident.id.slice(0, 8)}`
                        ? ''
                        : ` · ${incident.id.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {selectedIncident && (
            <TopologyIncidentContext
              incident={selectedIncident}
              services={incidentServices}
              graph={graph}
              apiBaseUrl={config.apiBaseUrl}
              getCredentials={getCredentials}
              onSaved={refetch}
              onSelect={(name) => {
                const node = operationalGraph.nodes.find((item) => item.name === name);
                if (node) selectService(node);
              }}
            />
          )}
          {impactService && !graph.historicalAt && (
            <TopologyImpact
              service={impactService}
              result={blastRadius}
              loading={blastLoading}
              error={blastError}
              onRetry={retryBlast}
              onSelect={(name) => {
                const node = operationalGraph.nodes.find((item) => item.name === name);
                if (node) selectService(node);
              }}
            />
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
          {selectedNode && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={focusNeighbors}
                onChange={(event) => setFocusNeighbors(event.target.checked)}
              />
              Show selected service and direct neighbors
            </label>
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
                onSelect={selectService}
                reliability={
                  !graph.historicalAt && (
                    <TopologyReliability
                      key={selectedNode.name}
                      service={selectedNode.name}
                      apiBaseUrl={config.apiBaseUrl}
                      getCredentials={getCredentials}
                    />
                  )
                }
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
