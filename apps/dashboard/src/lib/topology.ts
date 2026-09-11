import type { Incident, InfraSnapshot } from './types';
import { infrastructureHealth } from './infrastructure';

/** One recent deployment for a service (mirrors GET /topology/graph node.recentDeploys). */
export interface RecentDeploy {
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
  /** Added by operationalTopologyGraph when live Kubernetes pods map to this service namespace. */
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
}

export interface TopologyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Safe runtime projection used to derive per-service health; cluster-scoped nodes stay global. */
  infrastructure?: InfraSnapshot[];
}

/** One dependent in a blast radius; `via` marks the insulating hop (async / circuit breaker). */
export interface BlastDep {
  name: string;
  criticality: string | null;
  team: string | null;
  hops: number;
  via?: 'async' | 'circuit_breaker';
}

/** On-demand blast radius for a service (mirrors GET /topology/blast-radius). */
export interface BlastRadius {
  service: string;
  mapped: boolean; // false when the service is not a graph node
  dependents: { direct: BlastDep[]; indirect: BlastDep[]; insulated: BlastDep[] };
  suspects: { name: string; syncType: string; criticality: string | null }[];
  truncated: boolean;
  note?: string;
}

/** Incident statuses that count as "active" for the overlay + drawer alerts list. */
export const ACTIVE_INCIDENT_STATUSES = new Set(['open', 'mitigated']);

/** Active incidents in API order. */
export function activeIncidents(incidents: Incident[]): Incident[] {
  return incidents.filter(
    (incident) =>
      incident.purpose !== 'health_check' && ACTIVE_INCIDENT_STATUSES.has(incident.status),
  );
}

/** The first active incident, or undefined. Drives which service's blast radius the overlay fetches. */
export function activeIncident(incidents: Incident[]): Incident | undefined {
  return activeIncidents(incidents)[0];
}

/** Add live operational status without changing the server's authoritative relationship graph. */
export function operationalTopologyGraph(
  graph: TopologyGraph,
  incidents: Incident[],
  now: number,
): TopologyGraph {
  const activeServices = new Set([
    ...activeIncidents(incidents).map((incident) => incident.service),
    ...graph.nodes.filter((node) => node.sources?.includes('incident')).map((node) => node.name),
  ]);
  const podsByNamespace = new Map<string, InfraSnapshot[]>();
  for (const snapshot of graph.infrastructure ?? []) {
    if (snapshot.kind !== 'pod' || !snapshot.namespace) continue;
    const pods = podsByNamespace.get(snapshot.namespace) ?? [];
    pods.push(snapshot);
    podsByNamespace.set(snapshot.namespace, pods);
  }

  const nodes = graph.nodes
    .map((node) => {
      const pods = podsByNamespace.get(node.name) ?? [];
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
        pods.length > 0
          ? {
              namespace: node.name,
              pods: pods.length,
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
            : pods.length > 0
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
  filters: { status?: ServiceStatus | 'all'; source?: TopologySource | 'all' } = {},
): TopologyGraph {
  const normalizedQuery = query.trim().toLowerCase();
  const nodes = graph.nodes.filter(
    (node) =>
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
export type BlastHighlight = 'affected' | 'direct' | 'indirect';

/**
 * Map service name -> blast-radius highlight. The affected service wins over direct, direct over
 * indirect (a node can appear at multiple hop distances; the closest tier is the strongest signal).
 * Pure so the overlay can be tested without rendering.
 */
export function blastHighlights(
  blastRadius: BlastRadius | null | undefined,
): Map<string, BlastHighlight> {
  const m = new Map<string, BlastHighlight>();
  if (!blastRadius) return m;
  for (const d of blastRadius.dependents.indirect) m.set(d.name, 'indirect');
  for (const d of blastRadius.dependents.direct) m.set(d.name, 'direct');
  m.set(blastRadius.service, 'affected'); // the origin service always wins
  return m;
}
