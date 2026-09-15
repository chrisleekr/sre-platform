import type { TopologyCollection, TopologyReader } from '@sre/contracts';
import type { ConnectorConfig } from './registry';
import { finishTopologyPage, shouldReadTopologyCollection } from './topology-scan';
import { repositoryServiceDiscovery } from './repository-service-discovery';
import type { SourceCodeReader } from './types';
import { repositoryTopologyRef } from './repository-reference';
export { repositoryTopologyRef } from './repository-reference';

/** Discover repositories already admitted to this connector's tenant-scoped repository catalog.
 * @param config - Provider settings and bounded catalog reader.
 * @param createReader - Optional fresh bounded source reader for explicit service declarations.
 */
export function repositoryTopology(
  config: ConnectorConfig,
  createReader?: () => SourceCodeReader | Promise<SourceCodeReader>,
): TopologyReader | undefined {
  const catalog = config.repositories;
  if (!catalog) return undefined;
  return {
    async discover(options) {
      const observedAt = new Date().toISOString();
      const collections: TopologyCollection[] = [];
      if (shouldReadTopologyCollection(options, 'repositories')) {
        const previous = options?.scans?.repositories;
        const repositories = catalog.page
          ? await catalog.page(previous?.cursor ?? null, 100)
          : await catalog.search('', 100);
        const entities = repositories.flatMap((repository) => {
          const ref = repositoryTopologyRef(repository.htmlUrl);
          return ref
            ? [
                {
                  ref,
                  kind: 'repository' as const,
                  name: repository.fullName,
                  scope: {},
                  attributes: {
                    providerId: repository.repositoryId,
                    evidence: 'connector_catalog',
                    ...(repository.defaultBranch
                      ? { defaultBranch: repository.defaultBranch }
                      : {}),
                  },
                },
              ]
            : [];
        });
        const partial =
          (!catalog.page && repositories.length >= 100) || entities.length !== repositories.length;
        const collection: TopologyCollection = {
          key: 'repositories',
          completeness: partial ? 'partial' : 'complete',
          ...(partial
            ? {
                issue:
                  entities.length !== repositories.length
                    ? ('invalid_response' as const)
                    : ('limit' as const),
              }
            : {}),
          entities,
          relations: [],
        };
        collections.push(
          catalog.page
            ? finishTopologyPage(
                collection,
                repositories.length >= 100 ? repositories.at(-1)!.repositoryId : null,
                previous,
              )
            : collection,
        );
      }
      if (createReader && shouldReadTopologyCollection(options, 'service-declarations'))
        collections.push(
          await repositoryServiceDiscovery(
            config,
            createReader,
            options?.scans?.['service-declarations'],
          ),
        );
      return { observedAt, collections };
    },
  };
}
