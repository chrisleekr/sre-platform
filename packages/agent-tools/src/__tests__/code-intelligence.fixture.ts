import type {
  IDataSourceConnector,
  RuntimeArtifact,
  SourceCodeReader,
  SourceRepository,
} from '@sre/connectors';
import type { DeployRow, IncidentSummary } from '@sre/db';
import { vi } from 'vitest';
import { makeInMemoryAuditSink } from '../audit';
import { makeInvestigateCodeTool, type CodeContextReader } from '../code-intelligence';
import { runTool } from '../dispatch';
import type { ToolContext } from '../types';

export function createFixture() {
  const OLD = 'a'.repeat(40);

  const PREVIOUS = 'b'.repeat(40);

  const HEAD = 'c'.repeat(40);

  const ARTIFACT = 'd'.repeat(40);

  function repository(overrides: Partial<SourceRepository> = {}): SourceRepository {
    const fullName = overrides.fullName ?? 'acme/checkout';
    return {
      dataSourceId: '00000000-0000-4000-8000-000000000001',
      dataSourceName: 'GitHub production',
      provider: 'github',
      repositoryId: '42',
      fullName,
      defaultBranch: 'main',
      webUrl: `https://github.com/${fullName}`,
      pathPrefix: null,
      mappingSource: null,
      role: 'application_source',
      resolution: 'confirmed_mapping',
      ...overrides,
    };
  }

  function deployment(sha: string, deployedAt: string): DeployRow {
    return {
      id: sha,
      connectorId: '00000000-0000-4000-8000-000000000001',
      dataSourceName: 'GitHub production',
      source: 'github',
      providerId: sha,
      repo: 'acme/checkout',
      ref: 'main',
      environment: 'production',
      transientEnvironment: false,
      actor: 'deploy-bot',
      sha,
      revisions: null,
      operationPhase: null,
      service: 'checkout',
      status: 'success',
      url: null,
      deployedAt: new Date(deployedAt),
      providerCreatedAt: null,
      providerUpdatedAt: null,
      budgetRemaining: null,
      highRisk: false,
    };
  }

  function incident(): IncidentSummary {
    return {
      id: '11111111-1111-4111-8111-111111111111',
      service: 'checkout',
      severity: 'sev2',
      status: 'open',
      investigationStatus: 'gathering',
      lifecycleVersion: 1,
      resolutionPolicy: 'verified_recovery',
      resolutionBasis: null,
      alertSource: 'slack',
      title: 'checkout failed',
      rcaSummary: null,
      confidence: null,
      archivedAt: null,
      createdAt: new Date('2026-08-21T00:00:00Z'),
    };
  }

  function sourceText(extra = ''): string {
    return Array.from({ length: 80 }, (_, index) =>
      index === 41
        ? `export function chargeAccount() { throw new Error('account missing'); ${extra} }`
        : `// line ${index + 1}`,
    ).join('\n');
  }

  function reader(repo = repository(), text = sourceText()): SourceCodeReader {
    return {
      resolve: vi.fn(async () => [repo]),
      verifyRevision: vi.fn(async (_repository, revision) => ({
        revision: revision === 'main' ? HEAD : revision,
        providerUrl: `https://github.com/acme/checkout/commit/${revision === 'main' ? HEAD : revision}`,
      })),
      search: vi.fn(async () => ({ matches: [], incomplete: false })),
      read: vi.fn(async (_repository, revision, path) => ({
        path,
        revision,
        text,
        providerUrl: `https://github.com/acme/checkout/blob/${revision}/${path}`,
      })),
      compare: vi.fn(async () => ({
        files: [{ path: 'src/orders.ts', status: 'modified' }],
        filesIncomplete: false,
      })),
    };
  }

  function connector(sourceCode: SourceCodeReader): IDataSourceConnector {
    return {
      id: repository().dataSourceId,
      name: 'GitHub production',
      type: 'github',
      sourceCode,
      snapshot: async () => [],
      fetchTriageContext: async () => ({ source: 'github', data: {} }),
      tools: () => [],
      probe: async () => ({
        status: 'healthy',
        reachable: true,
        authorized: true,
        warnings: [],
      }),
    };
  }

  function artifactConnector(
    artifacts: RuntimeArtifact[],
    incomplete = false,
  ): IDataSourceConnector {
    return {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Kubernetes production',
      type: 'kubernetes',
      runtimeArtifacts: {
        observe: vi.fn(async () => ({ artifacts, incomplete })),
      },
      snapshot: async () => [],
      fetchTriageContext: async () => ({ source: 'kubernetes', data: {} }),
      tools: () => [],
      probe: async () => ({
        status: 'healthy',
        reachable: true,
        authorized: true,
        warnings: [],
      }),
    };
  }

  function setup(
    options: {
      reader?: SourceCodeReader;
      deployments?: DeployRow[];
      artifacts?: RuntimeArtifact[];
      connectors?: IDataSourceConnector[];
      onsetAt?: Date | null;
    } = {},
  ) {
    const source = options.reader ?? reader();
    const connectors = options.connectors ?? [
      connector(source),
      ...(options.artifacts ? [artifactConnector(options.artifacts)] : []),
    ];
    const context: CodeContextReader = {
      incident: vi.fn(async () => incident()),
      onset: vi.fn(async () => options.onsetAt ?? null),
      evidenceIds: vi.fn(async (_tenantId, _incidentId, proposed) => proposed),
      deploymentBoundary: vi.fn(async (_tenantId, _service, repo, at) => {
        const matching = (options.deployments ?? [])
          .filter(
            (item) =>
              item.source === repo.provider &&
              item.repo.toLowerCase() === repo.fullName.toLowerCase() &&
              item.status === 'success',
          )
          .sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime());
        const before = matching.filter((item) => item.deployedAt <= at);
        const after = matching.filter((item) => item.deployedAt > at).reverse();
        return {
          current: before[0] ?? null,
          previous: before[1] ?? null,
          firstAfter: after[0] ?? null,
        };
      }),
    };
    const audit = makeInMemoryAuditSink();
    const toolContext: ToolContext = {
      tenantId: 'tenant-a',
      incidentId: incident().id,
      service: 'checkout',
      resolveConnectors: async () => connectors,
      audit,
    };
    return {
      source,
      context,
      audit,
      toolContext,
      run: (input: Record<string, unknown>) =>
        runTool(makeInvestigateCodeTool({ context }), toolContext, input),
    };
  }

  return {
    OLD,
    PREVIOUS,
    HEAD,
    ARTIFACT,
    repository,
    deployment,
    incident,
    sourceText,
    reader,
    connector,
    artifactConnector,
    setup,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
