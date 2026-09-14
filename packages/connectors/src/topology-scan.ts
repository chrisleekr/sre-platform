import type {
  TopologyCollection,
  TopologyScanProgress,
  TopologyDiscoveryOptions,
} from '@sre/contracts';

/** Keep continuation reads confined to the collections whose cursors made progress.
 * @param options - Optional collection selection from the durable discovery job.
 * @param key - Adapter-owned collection identifier.
 */
export function shouldReadTopologyCollection(
  options: TopologyDiscoveryOptions | undefined,
  key: string,
): boolean {
  return !options?.collections || options.collections.includes(key);
}

/** Finish one bounded inventory page without claiming an unfinished or failed scan is complete.
 * @param collection - Facts collected during this page, including any read failures.
 * @param cursor - Next page checkpoint, or null when the inventory ends.
 * @param previous - Persisted progress from earlier pages in this scan.
 */
export function finishTopologyPage(
  collection: TopologyCollection,
  cursor: string | null,
  previous?: TopologyScanProgress,
): TopologyCollection {
  const incomplete = !!previous?.incomplete || collection.completeness !== 'complete';
  collection.scan = { cursor, incomplete };
  if (cursor || incomplete) {
    if (collection.completeness === 'complete') collection.completeness = 'partial';
    collection.issue ??= 'limit';
  }
  return collection;
}
