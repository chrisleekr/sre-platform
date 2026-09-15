import {
  topologyRefKey,
  topologyRelationKey,
  type DiscoveredTopologyGraph,
  type ObservedTopologyFact,
  type TopologyCollection,
  type TopologyEntity,
  type TopologyFactSource,
  type TopologyRef,
  type TopologyRelation,
} from '@sre/contracts';
import { resolveTrafficReference } from './traffic-reference';

interface CollectionInput {
  connectorId: string;
  connectorName: string;
  connectorType: string;
  key: string;
  observedAt: string;
  attemptedAt: string;
  completeness: TopologyCollection['completeness'];
  issue: TopologyCollection['issue'] | null;
  entities: ObservedTopologyFact<TopologyEntity>[];
  relations: ObservedTopologyFact<TopologyRelation>[];
  generation?: number;
  scan?: TopologyCollection['scan'] | null;
}

function compatible(a: TopologyEntity, b: TopologyEntity) {
  return (
    a.kind === b.kind &&
    !(a.network && b.network && JSON.stringify(a.network) !== JSON.stringify(b.network)) &&
    !(a.attributes.uid && b.attributes.uid && a.attributes.uid !== b.attributes.uid) &&
    Object.entries(a.scope).every(([key, value]) => !b.scope[key] || b.scope[key] === value)
  );
}

/** Resolve exact provider locators across sources without using names, labels or model confidence.
 * @param collections - Current-generation, tenant-scoped evidence loaded by the caller.
 * @param now - Read time used only to report freshness, not to manufacture observations.
 */
export function resolveDiscoveredTopology(
  collections: CollectionInput[],
  now = Date.now(),
): DiscoveredTopologyGraph {
  const graph: DiscoveredTopologyGraph = {
    entities: [],
    relations: [],
    conflicts: [],
    coverage: [],
  };
  const entities = new Map<string, DiscoveredTopologyGraph['entities'][number]>();
  const trafficEntities: DiscoveredTopologyGraph['entities'] = [];
  const aliases = new Map<string, Set<string>>();
  const conflicting = new Set<string>();
  const fresh = (sources: TopologyFactSource[]) =>
    sources.some(
      (source) =>
        !source.retired &&
        source.completeness !== 'unavailable' &&
        Number.isFinite(Date.parse(source.observedAt)) &&
        Date.parse(source.observedAt) <= now &&
        now - Date.parse(source.observedAt) <= 600_000,
    );
  const sourceFor = (collection: CollectionInput, observedAt: string): TopologyFactSource => ({
    connectorId: collection.connectorId,
    connectorName: collection.connectorName,
    connectorType: collection.connectorType,
    collection: collection.key,
    completeness: collection.completeness,
    observedAt,
    ...(collection.generation !== undefined ? { lifecycleVersion: collection.generation } : {}),
  });
  for (const collection of collections) {
    graph.coverage.push({
      connectorId: collection.connectorId,
      connectorName: collection.connectorName,
      connectorType: collection.connectorType,
      collection: collection.key,
      completeness: collection.completeness,
      issue: collection.issue,
      observedAt: collection.observedAt,
      attemptedAt: collection.attemptedAt,
      ...(collection.scan
        ? { hasMore: collection.scan.cursor !== null, scanHasGaps: collection.scan.incomplete }
        : {}),
    });
    for (const fact of collection.entities) {
      const key = topologyRefKey(fact.value.ref);
      const old = entities.get(key);
      if (old && !compatible(old, fact.value)) conflicting.add(key);
      const source = sourceFor(collection, fact.observedAt);
      if (fact.retired) source.retired = true;
      if (fact.firstObservedAt) source.validFrom = fact.firstObservedAt;
      for (const binding of [...(fact.history ?? []), fact]) {
        if (!binding.firstObservedAt) continue;
        trafficEntities.push({
          ...binding.value,
          key,
          sources: [
            { ...sourceFor(collection, binding.observedAt), validFrom: binding.firstObservedAt },
          ],
          stale: true,
        });
      }
      const sources = [...(old?.sources ?? []), source].sort((a, b) =>
        b.observedAt.localeCompare(a.observedAt),
      );
      const newest = !old || fact.observedAt >= old.sources[0]!.observedAt ? fact.value : old;
      entities.set(key, {
        ...newest,
        key,
        sources,
        stale: !fresh(sources),
      });
      for (const alias of fact.retired ? [] : (fact.value.aliases ?? [])) {
        const aliasKey = topologyRefKey(alias);
        const candidates = aliases.get(aliasKey) ?? new Set();
        candidates.add(key);
        aliases.set(aliasKey, candidates);
      }
    }
  }
  const canonical = (ref: TopologyRef): string | null => {
    const key = topologyRefKey(ref),
      candidates = aliases.get(key);
    if (conflicting.has(key) || (candidates && candidates.size > 1)) return null;
    const target = candidates?.values().next().value as string | undefined;
    if (target && target !== key) {
      if (conflicting.has(target)) return null;
      if ([...(aliases.get(target) ?? [])].some((candidate) => candidate !== target)) return null;
      const own = entities.get(key),
        other = entities.get(target)!;
      if (own && !compatible(own, other)) return null;
      if (
        own &&
        (own.attributes.uid || other.attributes.uid) &&
        own.attributes.uid !== other.attributes.uid
      )
        return null;
      return target;
    }
    return entities.has(key) ? key : null;
  };
  for (const [key, entity] of entities) {
    const resolved = canonical(entity.ref);
    if (!resolved)
      graph.conflicts.push({
        ref: entity.ref,
        reason: conflicting.has(key) ? 'conflicting_identity' : 'ambiguous_reference',
      });
    if (resolved && resolved !== key) {
      const target = entities.get(resolved)!;
      target.sources.push(...entity.sources);
      target.stale = !fresh(target.sources);
    } else graph.entities.push(entity);
  }
  const resolvableTrafficEntities = trafficEntities.filter(
    (entity) => !conflicting.has(entity.key),
  );
  const relations = new Map<string, DiscoveredTopologyGraph['relations'][number]>();
  for (const collection of collections)
    for (const fact of collection.relations) {
      const relation = fact.value;
      const resolve = (ref: TopologyRef) =>
        ref.authority.startsWith('kubernetes-traffic:')
          ? resolveTrafficReference(ref, fact.observedAt, resolvableTrafficEntities)
          : canonical(ref);
      const fromKey = resolve(relation.from),
        toKey = resolve(relation.to);
      const key = JSON.stringify([
        fromKey ?? topologyRefKey(relation.from),
        toKey ?? topologyRefKey(relation.to),
        relation.kind,
        relation.evidence,
        Object.entries(relation.scope ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ]);
      const old = relations.get(key);
      const source = sourceFor(collection, fact.observedAt);
      if (fact.firstObservedAt) source.validFrom = fact.firstObservedAt;
      const sources = [...(old?.sources ?? []), source].sort((a, b) =>
        b.observedAt.localeCompare(a.observedAt),
      );
      const newest = !old || fact.observedAt >= old.sources[0]!.observedAt ? relation : old;
      relations.set(key, {
        ...newest,
        key,
        fromKey,
        toKey,
        sources,
        stale:
          !fresh(sources) ||
          !fromKey ||
          !toKey ||
          entities.get(fromKey)!.stale ||
          entities.get(toKey)!.stale,
      });
      // Unresolved endpoints stay visible as missing evidence instead of silently losing an edge.
      for (const ref of [relation.from, relation.to])
        if (!canonical(ref) && (aliases.get(topologyRefKey(ref))?.size ?? 0) > 1)
          graph.conflicts.push({ ref, reason: 'ambiguous_reference' });
    }
  graph.entities.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  graph.relations = [...relations.values()].sort((a, b) =>
    topologyRelationKey(a).localeCompare(topologyRelationKey(b)),
  );
  graph.conflicts = [
    ...new Map(
      graph.conflicts.map((conflict) => [topologyRefKey(conflict.ref), conflict]),
    ).values(),
  ];
  return graph;
}
