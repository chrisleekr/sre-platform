import { topologyRefKey, type TopologyRef } from '@sre/contracts';
import type { ConnectorConfig } from './registry';
import { repositoryTopologyRef } from './repository-reference';
import type { SourceProvider, SourceRepository } from './types';

/** Resolve a declared repository through admitted catalog identity, never arbitrary URL access.
 * @param config - Tenant connector and its already-authorized repository catalog.
 * @param provider - Source provider owning this reader.
 * @param reference - Exact repository locator from discovery evidence.
 */
export async function resolveSourceRepository(
  config: ConnectorConfig,
  provider: SourceProvider,
  reference: TopologyRef,
): Promise<SourceRepository | null> {
  if (reference.kind !== 'repository' || !reference.authority.startsWith('repository:'))
    return null;
  const entries = (await config.repositories?.search(reference.id, 100)) ?? [];
  const matches = entries.filter((entry) => {
    const ref = repositoryTopologyRef(entry.htmlUrl);
    return ref && topologyRefKey(ref) === topologyRefKey(reference);
  });
  if (matches.length !== 1) return null;
  const entry = matches[0]!;
  return {
    dataSourceId: config.id,
    dataSourceName: config.name,
    provider,
    repositoryId: entry.repositoryId,
    fullName: entry.fullName,
    defaultBranch: entry.defaultBranch,
    webUrl: entry.htmlUrl,
    pathPrefix: entry.path?.replace(/^\/+|\/+$/g, '') || null,
    mappingSource: 'topology_identity',
    role: entry.role ?? 'application_source',
    resolution: 'discovered_mapping',
  };
}
