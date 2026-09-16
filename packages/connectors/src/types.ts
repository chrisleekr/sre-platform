// Source-agnostic connector contract (Ports & Adapters). Every source normalises
// into these shapes so the rest of the platform never sees vendor specifics.

import type { ZodType } from 'zod';
import type {
  AffectedEntityCandidate,
  EntityCapability,
  EntityKind,
  TopologyReader,
  TopologyRuntimeState,
} from '@sre/contracts';

export const CONNECTOR_TYPE_IDS = [
  'datadog',
  'prometheus',
  'github',
  'gitlab',
  'confluence',
  'aws',
  'kubernetes',
  'argocd',
  'statuscake',
  'grafana',
  'networkprobe',
] as const;

export type ConnectorType = (typeof CONNECTOR_TYPE_IDS)[number];

export interface ConnectorCapabilities {
  topology?: 'inventory' | 'on_demand';
  availability: 'ready' | 'incomplete';
  configuration: 'tenant' | 'builtin';
  instances: 'multiple' | 'singleton';
  investigation: 'tools' | 'none';
  polling: 'snapshots' | 'none';
  events: 'authenticated' | 'none';
}

/**
 * A granular tool a connector exposes to the triage engine. Each connector owns its own tools with
 * their own input contracts, replacing the five fixed signal tools. `@sre/agent-tools`
 * `connectorTools()` namespaces these by type and immutable data-source identity, then wraps `run`
 * in the audited dispatch path. `I`/`O` are the tool's input and output shapes.
 */
export interface ConnectorTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  run(input: I): Promise<O>;
}

export interface NormalizedSnapshot {
  tenantId: string;
  source: ConnectorType;
  entityId: string;
  metrics: Record<string, number>;
  metadata: Record<string, unknown>;
  observedAt: Date;
  topology?: TopologyRuntimeState;
}

export interface TriageContext {
  source: ConnectorType;
  data: Record<string, unknown>;
}

export type SourceProvider = 'github' | 'gitlab';
export type RepositoryRole = 'application_source' | 'deployment_config';

/** One repository selected from a tenant-owned connector catalog. */
export interface SourceRepository {
  dataSourceId: string;
  dataSourceName: string;
  provider: SourceProvider;
  repositoryId: string;
  fullName: string;
  defaultBranch: string | null;
  webUrl: string;
  pathPrefix: string | null;
  mappingSource: string | null;
  role: RepositoryRole;
  resolution: 'confirmed_mapping' | 'discovered_mapping' | 'exact_name';
}

export interface SourceRevision {
  revision: string;
  providerUrl: string;
}

export interface SourceSearchMatch {
  path: string;
  /** Provider search is discovery only. The caller must read this path at the deployed revision. */
  scope: { kind: 'default_branch'; ref: string | null };
  fragment: string | null;
  line: number | null;
}

export interface SourceFile {
  path: string;
  revision: string;
  text: string;
  providerUrl: string;
}

export interface SourceComparison {
  files: Array<{ path: string; status: string }>;
  /** True when the provider may have omitted changed files from this response. */
  filesIncomplete: boolean;
}

/**
 * Provider-neutral, read-only source capability. Repository identity always originates from
 * `resolve` or exact admitted-catalog resolution; callers cannot turn this into an installation-wide
 * arbitrary repository reader.
 */
export interface SourceCodeReader {
  resolve(service: string): Promise<SourceRepository[]>;
  /** Resolve an exact external repository identity inside this connector's admitted catalog. */
  resolveRepository?(
    reference: import('@sre/contracts').TopologyRef,
  ): Promise<SourceRepository | null>;
  verifyRevision(repository: SourceRepository, revision: string): Promise<SourceRevision>;
  search(
    repository: SourceRepository,
    query: string,
    limit: number,
  ): Promise<{ matches: SourceSearchMatch[]; incomplete: boolean }>;
  read(repository: SourceRepository, revision: string, path: string): Promise<SourceFile>;
  compare(
    repository: SourceRepository,
    baseRevision: string,
    headRevision: string,
  ): Promise<SourceComparison>;
}

export interface RuntimeArtifact {
  dataSourceId: string;
  dataSourceName: string;
  kind: 'oci_image';
  service: string;
  namespace: string;
  workload: string | null;
  container: string;
  image: string | null;
  identity: string;
  digest: string | null;
  sourceUrl: string | null;
  revision: string | null;
  /** Authority tying sourceUrl/revision to this runtime artifact. */
  provenance: 'verified' | 'corroborated' | 'declared' | null;
  observedAt: string;
}

/**
 * Reads one service level indicator ratio from a metrics backend. The expression is evaluated by the
 * backend, which already holds the time series, so the platform never stores SLI samples of its own.
 */
export interface SliRatioReader {
  /** Returns the bad-event ratio in [0,1] the query resolves to over the window. */
  sliRatio(query: { query: string; windowSeconds: number }): Promise<number>;
}

/** Current runtime artifact observations. Historical identity remains deployment evidence. */
export interface RuntimeArtifactReader {
  observe(service: string): Promise<{ artifacts: RuntimeArtifact[]; incomplete: boolean }>;
}

/**
 * Test-connection outcome. `not_applicable` means the connector has no outbound connection to probe
 * (e.g. an inbound-only stub); the route leaves enablement untouched for it. `healthy`/`unhealthy`
 * are conclusive and flip `enabled`. `checks` carries connector-specific booleans for the UI.
 */
export interface ProbeResult {
  status: 'healthy' | 'unhealthy' | 'not_applicable';
  reachable: boolean;
  authorized: boolean;
  warnings: string[];
  checks?: Record<string, boolean>;
  /** Secret-free connector-specific evidence for compound probes. */
  details?: Record<string, unknown>;
  /** Secret-free operator category for the decisive failed read. */
  failureCategory?:
    'permission_denied' | 'rate_limited' | 'provider_unavailable' | 'unreachable' | 'tls';
  durationMs?: number;
  rateLimitRemaining?: number;
  rateLimitResetAt?: string;
}

export interface ConnectorPollEvidence {
  cursor?: Record<string, unknown>;
  /** Cursor captured before incremental work, compared under the persistence lock. */
  expectedCursor?: Record<string, unknown>;
  errorCount?: number;
  durationMs?: number;
  rateLimitRemaining?: number;
  rateLimitResetAt?: string;
  failureCategory?: string;
}

export interface EntityCoverageReader {
  readonly capabilities: readonly EntityCapability[];
  readonly entityKinds: readonly EntityKind[];
  /** Non-secret saved boundary used to explain why a candidate is outside this instance. */
  readonly scope?: Readonly<Record<string, string>>;
  assess(
    candidate: AffectedEntityCandidate,
  ):
    | 'covered'
    | 'out_of_scope'
    | 'unsupported'
    | 'unavailable'
    | Promise<'covered' | 'out_of_scope' | 'unsupported' | 'unavailable'>;
}

export interface IDataSourceConnector {
  /** External issue writes are callable only by the confirmed-action application, never tool binding. */
  readonly issues?: import('./issues').IssueManager;
  /** Immutable tenant-owned data-source identity. */
  readonly id: string;
  /** Editable responder-facing label; never used as a persistence or routing key. */
  readonly name: string;
  readonly type: ConnectorType;
  /** Declared by production connectors. Optional only for external test doubles. */
  readonly capabilities?: ConnectorCapabilities;
  /** Immutable DB row generation captured with settings and credential for one worker read. */
  readonly generation?: { id: string; lifecycleVersion: number };
  snapshot(): Promise<NormalizedSnapshot[]>;
  /** Operational evidence from the most recent snapshot attempt; contains no provider payloads. */
  pollEvidence?(): ConnectorPollEvidence | undefined;
  fetchTriageContext(query: { service: string; windowMinutes: number }): Promise<TriageContext>;
  /** Optional deep capability used by the provider-neutral code investigation application. */
  readonly sourceCode?: SourceCodeReader;
  /** Optional runtime provenance capability, currently supplied by Kubernetes connectors. */
  readonly runtimeArtifacts?: RuntimeArtifactReader;
  /** Inventory discovery does not require a pre-existing catalog service. */
  readonly topology?: TopologyReader;
  /** Optional metrics capability the scheduled error-budget evaluator reads objectives through. */
  readonly sli?: SliRatioReader;
  /** Declares which affected entities this instance can inspect and whether its saved scope covers one. */
  readonly entityCoverage?: EntityCoverageReader;
  /** The granular triage tools this connector exposes to the engine; empty means none. */
  tools(): ConnectorTool[];
  /** Test-connection probe. Never returns connector data — only a reachability/authorization verdict. */
  probe(): Promise<ProbeResult>;
}
