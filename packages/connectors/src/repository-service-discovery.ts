import { topologyRefKey, type TopologyCollection, type TopologyScanProgress } from '@sre/contracts';
import type { ConnectorConfig } from './registry';
import type { SourceCodeReader, SourceRepository } from './types';
import { repositoryTopologyRef } from './repository-reference';
import { SourceFileNotFoundError, SourceRateLimitError } from './source-file-error';
import { serviceDeclarations } from './service-declarations';
import { topologyReadIssue } from './topology-transport';
import { finishTopologyPage } from './topology-scan';

const BATCH = 5;
const identity = (repository: SourceRepository) =>
  JSON.stringify([
    repository.dataSourceId,
    repository.repositoryId,
    repository.fullName,
    repository.pathPrefix,
    repository.role,
  ]);

/** Read service descriptors through current admitted repository identities and immutable commits.
 * @param config - Tenant-owned provider catalog. No arbitrary repository URLs are fetched.
 * @param createReader - Fresh, bounded source transport for this discovery attempt.
 * @param previous - Durable repository scan checkpoint.
 */
export async function repositoryServiceDiscovery(
  config: ConnectorConfig,
  createReader: () => SourceCodeReader | Promise<SourceCodeReader>,
  previous?: TopologyScanProgress,
): Promise<TopologyCollection> {
  const collection: TopologyCollection = {
    key: 'service-declarations',
    completeness: 'complete',
    entities: [],
    relations: [],
  };
  let cursor = previous?.cursor ?? null;
  let interrupted = false;
  try {
    const catalog = config.repositories!;
    const reader = await createReader();
    if (!reader.resolveRepository) throw new Error('Repository identity resolution unavailable');
    const all = catalog.page ? null : await catalog.search('', 100);
    const rows = catalog.page
      ? await catalog.page(cursor, BATCH)
      : all!
          .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId))
          .filter((entry) => !cursor || entry.repositoryId.localeCompare(cursor) > 0)
          .slice(0, BATCH);
    for (const entry of rows) {
      try {
        const reference = repositoryTopologyRef(entry.htmlUrl);
        if (!reference) throw new Error('Invalid repository identity');
        const repository = await reader.resolveRepository(reference);
        if (
          !repository ||
          repository.dataSourceId !== config.id ||
          repository.repositoryId !== entry.repositoryId ||
          !repository.defaultBranch
        )
          throw new Error('Repository admission unavailable');
        const prefix = repository.pathPrefix?.replace(/\/$/, '') ?? '';
        if (
          prefix &&
          (prefix.startsWith('/') ||
            prefix.includes('\\') ||
            prefix.split('/').some((part) => !part || part === '.' || part === '..'))
        )
          throw new Error('Invalid component path');
        const path = `${prefix ? `${prefix}/` : ''}catalog-info.yaml`;
        const revision = (await reader.verifyRevision(repository, repository.defaultBranch))
          .revision;
        if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error('Immutable revision required');
        let projected: ReturnType<typeof serviceDeclarations> = { entities: [], relations: [] };
        try {
          const file = await reader.read(repository, revision, path);
          if (file.path !== path || file.revision.toLowerCase() !== revision.toLowerCase())
            throw new Error('Source identity changed');
          projected = serviceDeclarations(reference, path, revision.toLowerCase(), file.text);
        } catch (error) {
          if (!(error instanceof SourceFileNotFoundError)) throw error;
          // A missing file is authoritative only while the repository commit remains readable.
          if (
            (await reader.verifyRevision(repository, revision)).revision.toLowerCase() !==
            revision.toLowerCase()
          )
            throw new Error('Source revision changed', { cause: error });
        }
        const current = await reader.resolveRepository(reference);
        const currentRef = current && repositoryTopologyRef(current.webUrl);
        if (
          !current ||
          identity(current) !== identity(repository) ||
          !currentRef ||
          topologyRefKey(currentRef) !== topologyRefKey(reference)
        )
          throw new Error('Repository admission changed');
        collection.entities.push(...projected.entities);
        collection.relations.push(...projected.relations);
      } catch (error) {
        collection.completeness = 'partial';
        collection.issue =
          error instanceof SourceRateLimitError
            ? 'rate_limited'
            : (topologyReadIssue(error) ?? 'request_rejected');
        if (collection.issue === 'rate_limited') {
          interrupted = true;
          break;
        }
      }
      cursor = entry.repositoryId;
    }
    if (!interrupted && rows.length < BATCH) cursor = null;
    if (all && all.length >= 100) {
      collection.completeness = 'partial';
      collection.issue ??= 'limit';
    }
  } catch (error) {
    collection.completeness = 'unavailable';
    collection.issue = topologyReadIssue(error) ?? 'unreachable';
  }
  return finishTopologyPage(collection, cursor, previous);
}
