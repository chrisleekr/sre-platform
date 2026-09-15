import type { IDataSourceConnector } from '@sre/connectors';
import type { TopologySourceEvidence } from '@sre/contracts';
import type { RepositoryTarget } from './contracts';

/** Compare admission boundaries without invalidating an unchanged source merely for a newer observation. */
export function topologyRepositoryIdentity(target: RepositoryTarget): string {
  return JSON.stringify([
    target.repository.dataSourceId,
    target.repository.repositoryId,
    target.repository.fullName,
    target.repository.pathPrefix,
    target.repository.role,
    target.topology?.key,
    target.topology?.revision,
    [...(target.topology?.evidenceKeys ?? [])].sort(),
    [
      ...new Set(
        target.topology?.sources.map((source) =>
          JSON.stringify([source.connectorId, source.lifecycleVersion]),
        ),
      ),
    ].sort(),
  ]);
}

export function topologyPathPrefix(value: string | null | undefined): string | null | false {
  if (!value || value === '.') return null;
  const normalized = value.replace(/\/+$/, '');
  return normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
    ? false
    : normalized;
}

/** Select exact, currently admitted repositories from the incident's topology source evidence.
 * @param connectors - Current tenant connector generations, never arbitrary external URLs.
 * @param evidence - Shared topology source selection, including component and revision provenance.
 */
export async function resolveTopologyRepositories(
  connectors: IDataSourceConnector[],
  evidence: TopologySourceEvidence,
): Promise<{ repositories: RepositoryTarget[]; failed: boolean }> {
  if (evidence.status !== 'partial') return { repositories: [], failed: false };
  const targets = new Map<string, RepositoryTarget>();
  let failed = false;
  for (const source of evidence.repositories.slice(0, 50)) {
    if (source.role === 'unknown') continue;
    const candidates = connectors.filter(
      (connector) =>
        connector.sourceCode?.resolveRepository &&
        connector.generation &&
        source.sources.some(
          (item) =>
            item.connectorId === connector.id &&
            item.lifecycleVersion === connector.generation?.lifecycleVersion &&
            item.completeness !== 'unavailable',
        ),
    );
    for (const connector of candidates.slice(0, 3)) {
      try {
        const reader = connector.sourceCode!;
        const repository = await reader.resolveRepository!(source.repository);
        if (!repository) continue;
        const catalogPrefix = topologyPathPrefix(repository.pathPrefix),
          sourcePrefix = topologyPathPrefix(source.path);
        if (catalogPrefix === false || sourcePrefix === false) {
          failed = true;
          continue;
        }
        if (
          catalogPrefix &&
          sourcePrefix &&
          sourcePrefix !== catalogPrefix &&
          !sourcePrefix.startsWith(`${catalogPrefix}/`)
        ) {
          failed = true;
          continue;
        }
        const pathPrefix = sourcePrefix ?? catalogPrefix;
        const key = JSON.stringify([
          connector.id,
          repository.repositoryId,
          pathPrefix,
          source.role,
          source.revision,
        ]);
        targets.set(key, {
          reader,
          repository: {
            ...repository,
            pathPrefix,
            role: source.role,
            resolution: 'discovered_mapping',
          },
          topology: source,
        });
      } catch {
        failed = true;
      }
    }
  }
  return { repositories: [...targets.values()], failed };
}
