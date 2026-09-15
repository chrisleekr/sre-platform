import type { EntityKind } from './entities';

/** An external locator, scoped by the provider authority rather than a display name. */
export interface TopologyRef {
  authority: string;
  kind: string;
  id: string;
}

export interface TopologyEntity {
  ref: TopologyRef;
  kind: EntityKind;
  name: string;
  scope: Record<string, string>;
  /** Provider-asserted alternate locators for this exact resource, never fuzzy name matches. */
  aliases?: TopologyRef[];
  attributes: Record<string, string>;
  /** Event time for telemetry-derived facts. Inventory reads default to the read start time. */
  evidenceAt?: string;
  /** Scoped network identity from provider inventory, never inferred from a name. */
  network?: { addresses: string[]; ports: number[] };
}

export type TopologyRelationKind =
  | 'owns'
  | 'manages'
  | 'routes_to'
  | 'deployed_from'
  | 'declared_in'
  | 'monitors'
  | 'calls'
  | 'depends_on'
  | 'runs_on'
  | 'reads_from';

/** Identify dependency evidence without conflating declarations with observed calls.
 * @param kind - Typed relationship from the shared topology resolver.
 */
export function isTopologyDependency(kind: TopologyRelationKind): boolean {
  return kind === 'calls' || kind === 'depends_on';
}

export interface TopologyRelation {
  from: TopologyRef;
  to: TopologyRef;
  kind: TopologyRelationKind;
  evidence: 'provider_reference' | 'observed' | 'declared' | 'inferred';
  description: string;
  /** Component or environment context that distinguishes otherwise equal directed relationships. */
  scope?: Record<string, string>;
  attributes?: Record<string, string>;
  evidenceAt?: string;
}

/** Completeness applies only to this collection, not every capability of the connector. */
export interface TopologyCollection {
  /** Transient admission boundary used to prune earlier log evidence on persistence. */
  runtimeScopes?: TopologyRuntimeScope[];
  /** Transient provider cooldown hint; the worker enforces it before another scheduled read. */
  retryAfterMs?: number;
  key: string;
  completeness: 'complete' | 'partial' | 'unavailable';
  entities: TopologyEntity[];
  relations: TopologyRelation[];
  /** A persisted scan checkpoint. A null cursor finishes the scan, not just this page. */
  scan?: TopologyScanProgress;
  issue?:
    | 'permission_denied'
    | 'unreachable'
    | 'rate_limited'
    | 'invalid_response'
    | 'request_rejected'
    | 'limit'
    | 'sampling'
    | 'missing_scope'
    | 'no_matches'
    | 'unsupported_schema';
}

export interface TopologyScanProgress {
  cursor: string | null;
  incomplete: boolean;
}

export interface TopologyRuntimeScope {
  clusterId: string;
  namespace: string;
}

export interface TopologyDiscoveryOptions {
  /** Verified Kubernetes namespaces from this tenant's enabled inventory connections. */
  runtimeScopes?: TopologyRuntimeScope[];
  scans?: Record<string, TopologyScanProgress>;
  /** Continuations read only these collections; omitted means a fresh pass across all collections. */
  collections?: string[];
}

export interface TopologyDiscovery {
  observedAt: string;
  collections: TopologyCollection[];
}

/** Inventory-first, read-only discovery. It must stay inside the connector's configured scope. */
export interface TopologyReader {
  discover(options?: TopologyDiscoveryOptions): Promise<TopologyDiscovery>;
}

export interface ObservedTopologyFact<T> {
  value: T;
  observedAt: string;
  /** Last successful inventory sighting, independent of the evidence's age. Optional for older rows. */
  seenAt?: string;
  /** First continuous inventory observation of the current identity and address binding. */
  firstObservedAt?: string;
  retired?: boolean;
  history?: Array<{ value: T; firstObservedAt: string; observedAt: string }>;
}

export interface TopologyFactSource {
  retired?: boolean;
  connectorId: string;
  connectorName: string;
  connectorType: string;
  collection: string;
  observedAt: string;
  validFrom?: string;
  completeness: TopologyCollection['completeness'];
  lifecycleVersion?: number;
}

/** Provider-normalized resource state, not a measurement of overall service availability. */
export interface TopologyRuntimeState {
  ref: TopologyRef;
  state: 'healthy' | 'attention' | 'unknown';
}

export interface TopologyRuntimeEvidence {
  status: 'partial' | 'unavailable' | 'ambiguous';
  subject: TopologySubject | null;
  observations: Array<{
    resourceKey: string;
    name: string;
    kind: TopologySubject['kind'];
    scope: Record<string, string>;
    state: TopologyRuntimeState['state'];
    observedAt: string;
    stale: boolean;
    sources: TopologyFactSource[];
  }>;
  note: string;
}

/** Repository evidence reached through exact runtime or deployment relationships. */
export interface TopologySourceEvidence {
  status: 'partial' | 'unavailable' | 'ambiguous';
  subject: TopologySubject | null;
  repositories: Array<{
    key: string;
    repository: TopologyRef;
    repositoryKey: string;
    name: string;
    role: 'application_source' | 'deployment_config' | 'unknown';
    path: string | null;
    revision: string | null;
    declaredBy: string;
    evidenceKeys: string[];
    sources: TopologyFactSource[];
  }>;
  note: string;
}

/** Audited on-demand observations of an exact endpoint, not resource ownership evidence. */
export interface TopologyEndpointEvidence {
  status: 'observed' | 'unavailable';
  endpoint: string | null;
  probes: Array<{
    kind: 'dns' | 'tcp' | 'tls' | 'http';
    state: 'observed' | 'unavailable';
    evidenceId: string;
    incidentId: string;
    tool: string;
    observedAt: string;
    stale: boolean;
    facts: {
      addresses?: string[];
      reachable?: boolean;
      latencyMs?: number;
      authorized?: boolean;
      expiresAt?: string;
      status?: number;
    };
  }>;
  note: string;
}

export interface DiscoveredTopologyGraph {
  capabilities?: Array<{
    connectorId: string | null;
    name: string;
    type: string;
    mode: 'inventory' | 'on_demand' | 'unsupported';
    state: 'not_connected' | 'disabled' | 'pending' | 'collected' | 'on_demand' | 'unsupported';
  }>;
  entities: Array<TopologyEntity & { key: string; sources: TopologyFactSource[]; stale: boolean }>;
  relations: Array<
    TopologyRelation & {
      key: string;
      fromKey: string | null;
      toKey: string | null;
      sources: TopologyFactSource[];
      stale: boolean;
    }
  >;
  conflicts: Array<{ ref: TopologyRef; reason: 'ambiguous_reference' | 'conflicting_identity' }>;
  coverage: Array<{
    connectorId: string;
    connectorName: string;
    connectorType: string;
    collection: string;
    completeness: TopologyCollection['completeness'];
    observedAt: string;
    attemptedAt: string;
    issue: TopologyCollection['issue'] | null;
    hasMore?: boolean;
    scanHasGaps?: boolean;
  }>;
}

/** An operational grouping with a proven identity, not an automatically guessed catalog service. */
export interface TopologySubject {
  key: string;
  kind: EntityKind;
  name: string;
  scope: Record<string, string>;
  resourceKeys: string[];
  sources: TopologyFactSource[];
  stale: boolean;
  identityConflict?: boolean;
}

export interface OperationalTopology {
  subjects: TopologySubject[];
  relations: Array<{
    from: string;
    to: string;
    kind: TopologyRelationKind;
    evidence: TopologyRelation['evidence'];
    evidenceKeys: string[];
    stale: boolean;
    observedAt?: string;
    attributes?: Record<string, string>;
  }>;
}

/** Incident candidates resolved against the same scoped identities used for topology impact. */
export interface IncidentTopologyContext {
  resolutions: Array<{
    candidateKey: string;
    status: 'resolved' | 'ambiguous' | 'unmapped' | 'needs_evidence';
    subjectKey?: string;
    candidateSubjectKeys: string[];
  }>;
  subjects: TopologySubject[];
  relations: OperationalTopology['relations'];
}

export interface TopologyIncidentSelection {
  incidentId: string;
  topology: IncidentTopologyContext;
  assignedServices: string[];
}

/** Stable reference key; display names and connector names never participate in identity.
 * @param ref - Provider-scoped external locator.
 */
export function topologyRefKey(ref: TopologyRef): string {
  return JSON.stringify([ref.authority, ref.kind, ref.id]);
}

/** Stable relationship identity independent of its wording or most recent observation.
 * @param relation - Directed, typed external relationship.
 */
export function topologyRelationKey(relation: TopologyRelation): string {
  return JSON.stringify([
    topologyRefKey(relation.from),
    relation.kind,
    topologyRefKey(relation.to),
    relation.evidence,
    Object.entries(relation.scope ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
}
