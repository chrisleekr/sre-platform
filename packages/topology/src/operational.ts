import type { DiscoveredTopologyGraph, OperationalTopology, TopologySubject } from '@sre/contracts';
import { topologyRefKey } from '@sre/contracts';

/** Group runtime by explicit ownership and retain logical service identity as a separate fact.
 * @param graph - Resolved, tenant-scoped discovery evidence.
 */
export function discoveredOperationalTopology(graph: DiscoveredTopologyGraph): OperationalTopology {
  const entities = new Map(graph.entities.map((entity) => [entity.key, entity]));
  const conflicts = new Set(
    graph.conflicts
      .filter((conflict) => conflict.reason === 'conflicting_identity')
      .map((conflict) => topologyRefKey(conflict.ref)),
  );
  const evidenceByResource = new Map(
    graph.entities.map((entity) => [entity.key, [...entity.sources]]),
  );
  for (const relation of graph.relations)
    for (const key of new Set([relation.fromKey, relation.toKey])) {
      if (key) evidenceByResource.get(key)?.push(...relation.sources);
    }
  const parents = new Map<string, Set<string>>();
  for (const relation of graph.relations) {
    if (
      relation.kind !== 'owns' ||
      relation.evidence !== 'provider_reference' ||
      !relation.fromKey ||
      !relation.toKey ||
      relation.stale ||
      entities.get(relation.fromKey)?.kind === 'service' ||
      entities.get(relation.toKey)?.kind === 'service'
    )
      continue;
    const incoming = parents.get(relation.toKey) ?? new Set<string>();
    incoming.add(relation.fromKey);
    parents.set(relation.toKey, incoming);
  }
  const rootFor = (key: string) => {
    let current = key;
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      const owners = parents.get(current);
      if (!owners?.size) return current;
      // Conflicting ownership is not a license to choose an arbitrary service.
      if (owners.size !== 1) return key;
      current = [...owners][0]!;
    }
    return key;
  };
  const roots = new Map(graph.entities.map((entity) => [entity.key, rootFor(entity.key)]));
  const subjects = new Map<string, TopologySubject>();
  const addSubject = (key: string, kind: TopologySubject['kind']) => {
    if (subjects.has(key)) return subjects.get(key)!;
    const entity = entities.get(key)!;
    const subject: TopologySubject = {
      key,
      kind,
      name: entity.name,
      scope: entity.scope,
      resourceKeys: [],
      sources: entity.sources,
      stale: entity.stale,
      ...(conflicts.has(key) ? { identityConflict: true } : {}),
    };
    subjects.set(key, subject);
    return subject;
  };
  for (const entity of graph.entities) {
    const root = roots.get(entity.key)!;
    const subject = addSubject(root, entities.get(root)!.kind);
    if (entity.kind !== 'service') subject.resourceKeys.push(entity.key);
  }
  const relations = new Map<string, OperationalTopology['relations'][number]>();
  for (const relation of graph.relations) {
    if (!relation.fromKey || !relation.toKey) continue;
    const from = roots.get(relation.fromKey) ?? relation.fromKey;
    const to = roots.get(relation.toKey) ?? relation.toKey;
    if (
      relation.kind === 'runs_on' &&
      relation.evidence !== 'inferred' &&
      !relation.stale &&
      subjects.get(from)?.kind === 'service'
    ) {
      const subject = subjects.get(from)!;
      subject.resourceKeys.push(relation.toKey);
    }
    if (from === to || !subjects.has(from) || !subjects.has(to) || relation.kind === 'owns')
      continue;
    const key = JSON.stringify([from, to, relation.kind, relation.evidence]);
    const existing = relations.get(key);
    const observedAt = relation.sources
      .map((source) => source.observedAt)
      .sort()
      .at(-1);
    relations.set(key, {
      from,
      to,
      kind: relation.kind,
      evidence: relation.evidence,
      evidenceKeys: [...(existing?.evidenceKeys ?? []), relation.key],
      stale: (existing?.stale ?? true) && relation.stale,
      ...(existing?.observedAt && observedAt && existing.observedAt > observedAt
        ? { observedAt: existing.observedAt, attributes: existing.attributes }
        : { observedAt, ...(relation.attributes ? { attributes: relation.attributes } : {}) }),
    });
  }
  const runtimeBindings = new Map<string, DiscoveredTopologyGraph['relations']>();
  for (const relation of graph.relations) {
    if (
      relation.kind !== 'runs_on' ||
      !relation.toKey ||
      !relation.fromKey ||
      relation.stale ||
      relation.evidence === 'inferred' ||
      subjects.get(relation.fromKey)?.kind !== 'service'
    )
      continue;
    const bucket = runtimeBindings.get(relation.toKey) ?? [];
    bucket.push(relation);
    runtimeBindings.set(relation.toKey, bucket);
  }
  for (const call of graph.relations.filter(
    (relation) =>
      relation.kind === 'calls' &&
      relation.attributes?.parser &&
      !relation.stale &&
      relation.fromKey &&
      relation.toKey,
  )) {
    const at = Math.max(...call.sources.map((source) => Date.parse(source.observedAt)));
    const bindings = (resource: string) =>
      (runtimeBindings.get(resource) ?? []).filter((relation) =>
        relation.sources.some(
          (source) =>
            source.validFrom &&
            Date.parse(source.validFrom) <= at &&
            at <= Date.parse(source.observedAt),
        ),
      );
    const fromBindings = bindings(call.fromKey!),
      toBindings = bindings(call.toKey!);
    const callers = [...new Set(fromBindings.map((binding) => binding.fromKey!))],
      targets = [...new Set(toBindings.map((binding) => binding.fromKey!))];
    if (callers.length !== 1 || targets.length !== 1 || callers[0] === targets[0]) continue;
    const from = callers[0]!,
      to = targets[0]!;
    const key = JSON.stringify([from, to, 'calls', 'observed']);
    const old = relations.get(key);
    relations.set(key, {
      from,
      to,
      kind: 'calls',
      evidence: 'observed',
      stale: false,
      ...(old?.observedAt && Date.parse(old.observedAt) > at
        ? { observedAt: old.observedAt, attributes: old.attributes }
        : {
            observedAt: new Date(at).toISOString(),
            attributes: { ...call.attributes, projection: 'Explicit runtime service bindings' },
          }),
      evidenceKeys: [
        ...new Set([
          ...(old?.evidenceKeys ?? []),
          call.key,
          ...fromBindings.map((item) => item.key),
          ...toBindings.map((item) => item.key),
        ]),
      ],
    });
  }
  return {
    subjects: [...subjects.values()]
      .map((subject) => {
        const keys = new Set([subject.key, ...subject.resourceKeys]);
        const sources = [...keys].flatMap((key) => evidenceByResource.get(key) ?? []);
        return {
          ...subject,
          resourceKeys: [...new Set(subject.resourceKeys)].sort(),
          sources: [
            ...new Map(
              sources.map((source) => [
                JSON.stringify([source.connectorId, source.collection, source.observedAt]),
                source,
              ]),
            ).values(),
          ],
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)),
    relations: [...relations.values()],
  };
}
