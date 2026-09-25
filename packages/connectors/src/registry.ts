import type { TopologyReader } from '@sre/contracts';
import type { IssueManager } from './issues';
import type {
  ConnectorCapabilities,
  ConnectorPollEvidence,
  ConnectorTool,
  ConnectorType,
  IDataSourceConnector,
  NormalizedSnapshot,
  ProbeResult,
  RepositoryRole,
  RuntimeArtifactReader,
  SliRatioReader,
  SourceCodeReader,
  EntityCoverageReader,
  TriageContext,
} from './types';

/** Per-tenant connector configuration handed to a factory at construction. */
export interface ConnectorConfig<TType extends ConnectorType = ConnectorType> {
  id: string;
  name: string;
  tenantId: string;
  type: TType;
  settings: Record<string, unknown>;
  /** Lazily resolves the connector's credential (wired to the SecretStore by the caller). */
  getCredential: () => Promise<string>;
  /** Separate GitLab issue-write credential, never supplied to investigation read tools. */
  getIssueCredential?: () => Promise<string>;
  /** Whether the captured connector credential can be used by this runtime generation. */
  credentialStatus?: 'available' | 'unavailable' | 'not_required';
  /** Tenant-scoped repository catalog access, supplied only to source-control connectors. */
  repositories?: {
    resolve(service: string): Promise<RepositoryCatalogEntry[]>;
    search(query: string, limit?: number): Promise<RepositoryCatalogEntry[]>;
    /** Stable admitted-catalog inventory, starting after the previous repository identifier. */
    page?(afterRepositoryId: string | null, limit: number): Promise<RepositoryCatalogEntry[]>;
    pollCandidates?(): Promise<
      {
        repositoryId: string;
        fullName: string;
        cursor: Record<string, unknown> | null;
      }[]
    >;
    recentEvents(
      repositories: string[],
      since: Date,
      limit?: number,
    ): Promise<RepositoryEventSummary[]>;
  };
}

export interface RepositoryCatalogEntry {
  repositoryId: string;
  fullName: string;
  defaultBranch: string | null;
  private: boolean;
  archived: boolean;
  htmlUrl: string;
  path?: string | null;
  source?: string;
  mappingSource?: string | null;
  role?: RepositoryRole;
  confirmed?: boolean;
}

export interface RepositoryEventSummary {
  eventType: string;
  action: string | null;
  repositoryFullName: string | null;
  actor: string | null;
  ref: string | null;
  sha: string | null;
  summary: Record<string, unknown>;
  occurredAt: Date;
}

export interface ConnectorMetadata<TType extends ConnectorType = ConnectorType> {
  readonly type: TType;
  readonly capabilities: ConnectorCapabilities;
}

/** Provider code supplies only the ports it supports. The constructor fills compatibility defaults. */
export interface ConnectorImplementation {
  alertLifecycle?: import('./alert-lifecycle').AlertLifecycle;
  issues?: IssueManager;
  snapshot?: () => Promise<NormalizedSnapshot[]>;
  pollEvidence?: () => ConnectorPollEvidence | undefined;
  fetchTriageContext?: (query: {
    service: string;
    windowMinutes: number;
  }) => Promise<TriageContext>;
  sourceCode?: SourceCodeReader;
  runtimeArtifacts?: RuntimeArtifactReader;
  topology?: TopologyReader;
  sli?: SliRatioReader;
  entityCoverage?: EntityCoverageReader;
  tools?: () => ConnectorTool[];
  probe: () => Promise<ProbeResult>;
  identity?: () => Promise<string | null>;
}

export type ConnectorFactory = (config: ConnectorConfig) => IDataSourceConnector;

/** One compile-time adapter module: product metadata and its bound runtime factory cannot drift. */
export interface ConnectorDefinition<
  TType extends ConnectorType = ConnectorType,
> extends ConnectorMetadata<TType> {
  readonly create: ConnectorFactory;
}

/**
 * Freezes a connector definition so its declared capabilities cannot drift at runtime.
 *
 * @param definition - Provider metadata and factory to register.
 */
export function defineConnector<TType extends ConnectorType>(
  definition: ConnectorDefinition<TType>,
): ConnectorDefinition<TType> {
  return Object.freeze({
    ...definition,
    capabilities: Object.freeze({ ...definition.capabilities }),
  });
}

/**
 * Builds the stable connector port and fills unsupported operations with fail-closed defaults.
 *
 * @param config - Tenant-scoped identity, settings, and lazy credential accessor.
 * @param metadata - Provider type and capability contract.
 * @param implementation - Provider operations supported by this adapter.
 */
export function createDataSourceConnector<TType extends ConnectorType>(
  config: ConnectorConfig<TType>,
  metadata: ConnectorMetadata<TType>,
  implementation: ConnectorImplementation,
): IDataSourceConnector {
  if (config.type !== metadata.type) {
    throw new Error(
      `connector factory for ${metadata.type} cannot create configuration type: ${config.type}`,
    );
  }
  const entityCoverage = implementation.entityCoverage
    ? {
        ...implementation.entityCoverage,
        assess: (candidate: Parameters<EntityCoverageReader['assess']>[0]) => {
          if (!implementation.entityCoverage!.entityKinds.includes(candidate.kind))
            return 'unsupported' as const;
          return config.credentialStatus === 'unavailable'
            ? ('unavailable' as const)
            : implementation.entityCoverage!.assess(candidate);
        },
      }
    : undefined;
  return {
    alertLifecycle: implementation.alertLifecycle,
    id: config.id,
    name: config.name,
    type: metadata.type,
    capabilities: metadata.capabilities,
    snapshot:
      implementation.snapshot ??
      (async () => {
        throw new Error(`${metadata.type} connector does not support snapshot polling`);
      }),
    pollEvidence: implementation.pollEvidence,
    fetchTriageContext:
      implementation.fetchTriageContext ??
      (async () => {
        throw new Error(`${metadata.type} connector does not support triage context`);
      }),
    sourceCode: implementation.sourceCode,
    issues: implementation.issues,
    runtimeArtifacts: implementation.runtimeArtifacts,
    topology: config.credentialStatus === 'unavailable' ? undefined : implementation.topology,
    sli: implementation.sli,
    entityCoverage,
    tools: implementation.tools ?? (() => []),
    probe: implementation.probe,
    // Same rule as topology: an unreadable credential would fail every lookup.
    identity: config.credentialStatus === 'unavailable' ? undefined : implementation.identity,
  };
}

/** Resolves the connector implementation for a given source type. */
export class ConnectorRegistry {
  private readonly definitions = new Map<ConnectorType, ConnectorDefinition>();

  constructor(definitions: readonly ConnectorDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ConnectorDefinition): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`connector already registered for type: ${definition.type}`);
    }
    this.definitions.set(definition.type, defineConnector(definition));
  }

  has(type: ConnectorType): boolean {
    return this.definitions.has(type);
  }

  types(): ConnectorType[] {
    return [...this.definitions.keys()];
  }

  create(config: ConnectorConfig): IDataSourceConnector {
    const definition = this.definitions.get(config.type);
    if (!definition) throw new Error(`no connector registered for type: ${config.type}`);
    const connector = definition.create(config);
    if (connector.type !== definition.type) {
      throw new Error(`connector factory for ${definition.type} returned type: ${connector.type}`);
    }
    if (connector.id !== config.id || connector.name !== config.name) {
      throw new Error(`connector factory for ${definition.type} changed data-source identity`);
    }
    for (const capability of Object.keys(definition.capabilities) as Array<
      keyof ConnectorCapabilities
    >) {
      if (connector.capabilities?.[capability] !== definition.capabilities[capability]) {
        throw new Error(
          `connector factory for ${definition.type} returned inconsistent capabilities`,
        );
      }
    }
    return connector;
  }
}
