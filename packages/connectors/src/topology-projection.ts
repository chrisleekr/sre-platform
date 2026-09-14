import { createHash } from 'node:crypto';
import {
  topologyRefKey,
  topologyRelationKey,
  type TopologyCollection,
  type TopologyEntity,
  type TopologyRef,
} from '@sre/contracts';

/** Identify an observation without retaining credential-bearing provider URLs in its key.
 * @param parts - Provider-owned identity fields, never exposed as a concatenated raw key.
 */
export function topologyOpaqueId(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Project a public endpoint location only when its entire URI is safe to share and compare.
 * @param raw - Provider-reported HTTP endpoint. This function never fetches the destination.
 */
export function topologyEndpoint(raw: unknown): TopologyEntity | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const ref: TopologyRef = { authority: 'http-endpoint', kind: 'endpoint', id: url.href };
    return {
      ref,
      kind: 'endpoint',
      name: `${url.host}${url.pathname}`,
      scope: {},
      attributes: { url: url.href, resourceKind: 'HTTP endpoint' },
    };
  } catch {
    return null;
  }
}

/** Remove repeated facts within a collection while keeping the newest event observation.
 * @param collection - Projected provider collection to normalize before persistence.
 */
export function deduplicateTopology(collection: TopologyCollection): TopologyCollection {
  const entities = new Map<string, TopologyEntity>();
  for (const entity of collection.entities) {
    const key = topologyRefKey(entity.ref),
      previous = entities.get(key);
    if (!previous || (entity.evidenceAt ?? '') >= (previous.evidenceAt ?? ''))
      entities.set(key, entity);
  }
  const relations = new Map<string, TopologyCollection['relations'][number]>();
  for (const relation of collection.relations) {
    const key = topologyRelationKey(relation),
      previous = relations.get(key);
    if (!previous || (relation.evidenceAt ?? '') >= (previous.evidenceAt ?? ''))
      relations.set(key, relation);
  }
  return { ...collection, entities: [...entities.values()], relations: [...relations.values()] };
}
