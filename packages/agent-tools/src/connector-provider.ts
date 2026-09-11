import {
  isConnectorType,
  type ConnectorRegistry,
  type IDataSourceConnector,
} from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  listGitHubRepositories,
  listGitLabProjects,
  nextGitLabPollProjects,
  recentGitHubEvents,
  recentGitLabEvents,
  resolveGitHubRepositories,
  resolveGitLabProjects,
  withTenant,
  type Db,
  type SecretStore,
} from '@sre/db';
import { and, eq, isNull } from 'drizzle-orm';

export interface DbConnectorProviderDeps {
  db: Db;
  registry: ConnectorRegistry;
  secrets: SecretStore;
}

const BUILTIN_NETWORK_PROBE_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Builds a tenant-scoped resolver for enabled connector instances.
 *
 * @remarks Unknown connector types are skipped so one stale row cannot hide healthy siblings.
 * @param deps - Registry, database, credentials, and repository catalog dependencies.
 */
export function makeDbConnectorProvider(deps: DbConnectorProviderDeps) {
  return (tenantId: string) => async (): Promise<IDataSourceConnector[]> => {
    const rows = await withTenant(deps.db, tenantId, async (tx) => {
      const configs = await tx
        .select({
          id: connectorConfigs.id,
          name: connectorConfigs.name,
          type: connectorConfigs.type,
          settings: connectorConfigs.settings,
          pollCursor: connectorConfigs.pollCursor,
          lifecycleVersion: connectorConfigs.lifecycleVersion,
        })
        .from(connectorConfigs)
        .where(and(eq(connectorConfigs.enabled, true), isNull(connectorConfigs.deletedAt)))
        .orderBy(connectorConfigs.createdAt, connectorConfigs.id)
        .for('share');
      const captured = [];
      for (const row of configs) {
        if (!isConnectorType(row.type) || !deps.registry.has(row.type)) continue;
        let credential: string | null = null;
        let credentialUnavailable = false;
        try {
          credential = await deps.secrets.get(tenantId, connectorCredentialKey(row.id), tx);
        } catch {
          credentialUnavailable = true;
        }
        captured.push({
          ...row,
          credential,
          credentialUnavailable,
        });
      }
      return captured;
    });
    const connectors: IDataSourceConnector[] = [];
    for (const row of rows) {
      if (!isConnectorType(row.type)) continue;
      const type = row.type;
      const connector = deps.registry.create({
        id: row.id,
        name: row.name,
        tenantId,
        type,
        settings: {
          ...((row.settings ?? {}) as Record<string, unknown>),
          ...(row.pollCursor ? { pollCursor: row.pollCursor } : {}),
        },
        credentialStatus:
          type === 'networkprobe'
            ? 'not_required'
            : row.credentialUnavailable || row.credential == null
              ? 'unavailable'
              : 'available',
        getCredential: async () => {
          if (row.credentialUnavailable)
            throw new Error(`credential unavailable for data source '${row.name}'`);
          if (row.credential == null)
            throw new Error(`no credential stored for data source '${row.name}'`);
          return row.credential;
        },
        ...(type === 'github' || type === 'gitlab'
          ? {
              repositories: {
                ...(type === 'gitlab'
                  ? {
                      pollCandidates: () => nextGitLabPollProjects(deps.db, tenantId, row.id),
                    }
                  : {}),
                resolve: (service: string) =>
                  type === 'github'
                    ? resolveGitHubRepositories(deps.db, tenantId, row.id, service)
                    : resolveGitLabProjects(deps.db, tenantId, row.id, service),
                search: (query: string, limit?: number) =>
                  type === 'github'
                    ? listGitHubRepositories(deps.db, tenantId, row.id, { query, limit })
                    : listGitLabProjects(deps.db, tenantId, row.id, { query, limit }),
                recentEvents: (repositories: string[], since: Date, limit?: number) =>
                  type === 'github'
                    ? recentGitHubEvents(deps.db, tenantId, row.id, repositories, since, limit)
                    : recentGitLabEvents(deps.db, tenantId, row.id, repositories, since, limit),
              },
            }
          : {}),
      });
      Object.defineProperty(connector, 'generation', {
        value: { id: row.id, lifecycleVersion: row.lifecycleVersion },
        enumerable: true,
      });
      connectors.push(connector);
    }
    if (
      deps.registry.has('networkprobe') &&
      !connectors.some((connector) => connector.type === 'networkprobe')
    ) {
      connectors.push(
        deps.registry.create({
          id: BUILTIN_NETWORK_PROBE_ID,
          name: 'Network probe',
          tenantId,
          type: 'networkprobe',
          settings: {},
          getCredential: async () => '',
          credentialStatus: 'not_required',
        }),
      );
    }
    return connectors;
  };
}
