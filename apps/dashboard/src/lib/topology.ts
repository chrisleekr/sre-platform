import { INFRA_STALE_AFTER_MS, type Incident, type InfraSnapshot } from './types';
import { infrastructureHealth } from './infrastructure';
import type { BlastRadius } from '@sre/contracts';
export type { BlastRadius, BlastRadiusDependent as BlastDep } from '@sre/contracts';
import type { DiscoveredTopologyGraph, OperationalTopology } from '@sre/contracts';

export type TopologyDiscoveryGraph = DiscoveredTopologyGraph & { operational: OperationalTopology };

/** One recent deployment for a service (mirrors GET /topology/graph node.recentDeploys). */
export interface RecentDeploy {
  id?: string;
  dataSourceId?: string | null;
  dataSourceName?: string;
  attribution?: 'provider_reported';
  environment?: string | null;
  source?: string;
  url?: string | null;
  sha: string;
  ref: string | null;
  status: string;
  deployedAt: string; // ISO
}

/** A service discovered from one or more current sources (mirrors GET /topology/graph). */
export interface GraphNode {
  name: string;
  team: string | null;
  criticality: string | null; // tier1 | tier2 | tier3
  /** Why this service is visible. Edges still come only from the registered catalog. */
  sources?: TopologySource[];
  lastDeployAt: string | null; // ISO; null when never deployed
  recentDeploys: RecentDeploy[];
  /** Added by operationalTopologyGraph in the dashboard. */
  status?: ServiceStatus;
  /** Runtime evidence from explicitly bound connection and resource selectors. */
  runtime?: ServiceRuntime;
}

export type TopologySource = 'catalog' | 'kubernetes' | 'incident' | 'deployment';
export type ServiceStatus = 'incident' | 'attention' | 'stale' | 'healthy' | 'unknown';

export interface ServiceRuntime {
  namespace: string;
  pods: number;
  healthy: number;
  attention: number;
  stale: number;
  errors: number;
  restarts: number;
  oomKilled: number;
  observedAt: string | null;
  scopes?: Array<{ dataSourceId: string; namespace: string; environment: string }>;
}

const STATUS_ORDER: Record<ServiceStatus, number> = {
  incident: 0,
  attention: 1,
  stale: 2,
  healthy: 3,
  unknown: 4,
};

/** A dependency edge: `upstream` depends on / calls `downstream`. */
export interface GraphEdge {
  upstream: string;
  downstream: string;
  syncType: string; // sync | async
  circuitBreaker: boolean;
  protocol?: string | null;
  environment?: string;
  rationale?: string | null;
  confirmedByUserId?: string | null;
  lastConfirmedAt?: string | null;
}

export interface TopologyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Safe runtime projection used to derive per-service health; cluster-scoped nodes stay global. */
  infrastructure?: InfraSnapshot[];
  incidentMappings?: Array<{ incidentId: string; services: string[] }>;
  incidents?: TopologyIncident[];
  coverage?: TopologyCoverage[];
  runtimeBindings?: RuntimeBinding[];
  historicalAt?: string;
  discovery?: TopologyDiscoveryGraph;
}

export interface RuntimeBinding {
  id: string;
  serviceName: string;
  connectorId: string;
  namespace: string;
  labelKey: string;
  labelValue: string;
  environment: string;
  rationale: string;
  updatedAt: string;
}

export function bindingMatchesPod(binding: RuntimeBinding, pod: InfraSnapshot): boolean {
  return (
    pod.kind === 'pod' &&
    pod.dataSourceId === binding.connectorId &&
    pod.namespace === binding.namespace &&
    (!binding.labelKey || pod.labels?.[binding.labelKey] === binding.labelValue)
  );
}

export interface TopologyCoverage {
  dataSourceId: string;
  dataSourceName: string;
  state: 'complete' | 'partial' | 'unknown' | 'unavailable';
  observedAt: string | null;
  lastSucceededAt: string | null;
}

/** Scope observations before aggregation; an unscoped deploy does not match an environment. */
export function scopeTopologyGraph(graph: TopologyGraph, environment: string): TopologyGraph {
  if (!environment) return graph;
  const runtimeBindings =
    graph.runtimeBindings?.filter((binding) => binding.environment === environment) ?? [];
  const names = new Set(runtimeBindings.map((binding) => binding.serviceName));
  const edges = graph.edges.filter((edge) => !edge.environment || edge.environment === environment);
  for (const edge of edges) {
    names.add(edge.upstream);
    names.add(edge.downstream);
  }
  const nodes = graph.nodes.flatMap((node) => {
    const recentDeploys = node.recentDeploys.filter((deploy) => deploy.environment === environment);
    return names.has(node.name) || recentDeploys.length
      ? [{ ...node, recentDeploys, lastDeployAt: recentDeploys[0]?.deployedAt ?? null }]
      : [];
  });
  const visible = new Set(nodes.map((node) => node.name));
  return {
    ...graph,
    nodes,
    runtimeBindings,
    edges: edges.filter(
      (edge) =>
        visible.has(edge.upstream) &&
        visible.has(edge.downstream) &&
        (!edge.environment || edge.environment === environment),
    ),
  };
}

export type TopologyIncident = Pick<
  Incident,
  | 'id'
  | 'service'
  | 'title'
  | 'severity'
  | 'status'
  | 'createdAt'
  | 'purpose'
  | 'archivedAt'
  | 'alertSource'
>;

/** Mentions alone do not describe an incident, and transport identifiers are not titles. */
export function topologyIncidentTitle(incident: Pick<TopologyIncident, 'id' | 'title'>): string {
  const title = incident.title
    ?.replace(/<@[A-Z0-9]+>/g, '')
    .replace(/<https?:\/\/[^>|]+\|([^>]+)>/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .trim();
  return title || `Incident ${incident.id.slice(0, 8)}`;
}

/** Prefer the server's resolved service identities, including an explicitly unresolved result. */
export function topologyIncidentServices(
  graph: TopologyGraph,
  incident: Pick<Incident, 'id' | 'service'>,
): string[] {
  return graph.incidentMappings
    ? (graph.incidentMappings.find((mapping) => mapping.incidentId === incident.id)?.services ?? [])
    : [incident.service];
}

/** Incident statuses that count as "active" for the overlay + drawer alerts list. */
export const ACTIVE_INCIDENT_STATUSES = new Set(['open', 'mitigated']);

/** Active incidents in API order. */
export function activeIncidents<T extends Pick<Incident, 'purpose' | 'archivedAt' | 'status'>>(
  incidents: T[],
): T[] {
  return incidents.filter(
    (incident) =>
      incident.purpose !== 'health_check' &&
      !incident.archivedAt &&
      ACTIVE_INCIDENT_STATUSES.has(incident.status),
  );
}

/** The first active incident, or undefined. Drives which service's blast radius the overlay fetches. */
export function activeIncident<T extends Pick<Incident, 'purpose' | 'archivedAt' | 'status'>>(
  incidents: T[],
): T | undefined {
  return activeIncidents(incidents)[0];
}

/** Add live operational status without changing the server's authoritative relationship graph. */
export function operationalTopologyGraph(
  graph: TopologyGraph,
  incidents: TopologyIncident[],
  now: number,
): TopologyGraph {
  const activeServices = new Set([
    ...activeIncidents(incidents).flatMap((incident) => topologyIncidentServices(graph, incident)),
    ...graph.nodes.filter((node) => node.sources?.includes('incident')).map((node) => node.name),
  ]);
  const podsByScope = new Map<string, InfraSnapshot[]>();
  for (const pod of graph.infrastructure ?? []) {
    if (pod.kind !== 'pod') continue;
    const key = JSON.stringify([pod.dataSourceId, pod.namespace]);
    const scoped = podsByScope.get(key) ?? [];
    scoped.push(pod);
    podsByScope.set(key, scoped);
  }
  const bindingsByService = new Map<string, RuntimeBinding[]>();
  for (const binding of graph.runtimeBindings ?? []) {
    const bindings = bindingsByService.get(binding.serviceName) ?? [];
    bindings.push(binding);
    bindingsByService.set(binding.serviceName, bindings);
  }
  const nodes = graph.nodes
    .map((node) => {
      const bindings = bindingsByService.get(node.name) ?? [];
      const matches = bindings.map((binding) =>
        (podsByScope.get(JSON.stringify([binding.connectorId, binding.namespace])) ?? []).filter(
          (pod) => bindingMatchesPod(binding, pod),
        ),
      );
      const pods = new Set(matches.flat());
      const counts = { healthy: 0, attention: 0, stale: 0, error: 0 };
      let observedAtMs = 0;
      let restarts = 0;
      let oomKilled = 0;
      for (const pod of pods) {
        counts[infrastructureHealth(pod, now)] += 1;
        const observedAt = Date.parse(pod.observedAt);
        if (!Number.isNaN(observedAt)) observedAtMs = Math.max(observedAtMs, observedAt);
        restarts += pod.metrics.restartCount ?? 0;
        if ((pod.metrics.oomKilled ?? 0) > 0) oomKilled += 1;
      }
      const runtime: ServiceRuntime | undefined =
        pods.size > 0
          ? {
              namespace: [...new Set(bindings.map((binding) => binding.namespace))].join(', '),
              scopes: [
                ...new Map(
                  bindings.map((binding) => [
                    JSON.stringify([binding.connectorId, binding.namespace, binding.environment]),
                    {
                      dataSourceId: binding.connectorId,
                      namespace: binding.namespace,
                      environment: binding.environment,
                    },
                  ]),
                ).values(),
              ],
              pods: pods.size,
              healthy: counts.healthy,
              attention: counts.attention,
              stale: counts.stale,
              errors: counts.error,
              restarts,
              oomKilled,
              observedAt: observedAtMs > 0 ? new Date(observedAtMs).toISOString() : null,
            }
          : undefined;
      const status: ServiceStatus = activeServices.has(node.name)
        ? 'incident'
        : counts.error > 0 || counts.attention > 0
          ? 'attention'
          : counts.stale > 0
            ? 'stale'
            : pods.size > 0 &&
                matches.every((matched) => matched.length > 0) &&
                bindings.every((binding) =>
                  graph.coverage?.some(
                    (source) =>
                      source.dataSourceId === binding.connectorId &&
                      source.state === 'complete' &&
                      source.observedAt !== null &&
                      Number.isFinite(Date.parse(source.observedAt)) &&
                      now - Date.parse(source.observedAt) <= INFRA_STALE_AFTER_MS,
                  ),
                )
              ? 'healthy'
              : 'unknown';
      return { ...node, status, ...(runtime ? { runtime } : {}) };
    })
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status ?? 'unknown'] - STATUS_ORDER[b.status ?? 'unknown'] ||
        a.name.localeCompare(b.name),
    );
  return { ...graph, nodes };
}

/** Filter services while retaining only edges whose two endpoints remain visible. */
export function filterTopologyGraph(
  graph: TopologyGraph,
  query: string,
  filters: {
    status?: ServiceStatus | 'all';
    source?: TopologySource | 'all';
    focus?: string | null;
  } = {},
): TopologyGraph {
  const normalizedQuery = query.trim().toLowerCase();
  const neighbors = new Set([filters.focus]);
  for (const edge of graph.edges) {
    if (edge.upstream === filters.focus) neighbors.add(edge.downstream);
    if (edge.downstream === filters.focus) neighbors.add(edge.upstream);
  }
  const nodes = graph.nodes.filter(
    (node) =>
      (!filters.focus || neighbors.has(node.name)) &&
      (!normalizedQuery || node.name.toLowerCase().includes(normalizedQuery)) &&
      (!filters.status || filters.status === 'all' || node.status === filters.status) &&
      (!filters.source ||
        filters.source === 'all' ||
        node.sources?.includes(filters.source) === true),
  );
  if (nodes.length === graph.nodes.length) return graph;
  const names = new Set(nodes.map((node) => node.name));
  const edges = graph.edges.filter(
    (edge) => names.has(edge.upstream) && names.has(edge.downstream),
  );
  return { ...graph, nodes, edges };
}

/** How a node is highlighted by the blast-radius overlay. */
export type BlastHighlight = 'affected' | 'direct' | 'indirect' | 'insulated' | 'unclassified';

/**
 * Map service name to potential exposure. Precedence is affected, direct, unclassified,
 * indirect, insulated.
 * Pure so the overlay can be tested without rendering.
 */
export function blastHighlights(
  blastRadius: BlastRadius | null | undefined,
): Map<string, BlastHighlight> {
  const m = new Map<string, BlastHighlight>();
  if (!blastRadius) return m;
  for (const d of blastRadius.dependents.insulated) m.set(d.name, 'insulated');
  for (const d of blastRadius.dependents.indirect) m.set(d.name, 'indirect');
  for (const d of blastRadius.dependents.unclassified ?? []) m.set(d.name, 'unclassified');
  for (const d of blastRadius.dependents.direct) m.set(d.name, 'direct');
  m.set(blastRadius.service, 'affected'); // the origin service always wins
  return m;
}
