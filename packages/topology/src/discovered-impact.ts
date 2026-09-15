import type { OperationalTopology, TopologySubject } from '@sre/contracts';
import { isTopologyDependency } from '@sre/contracts';
import type { BlastRadius, BlastRadiusDependent } from './blast-radius';
import { selectTopologySubject } from './selection';

export interface DeclaredImpactService {
  name: string;
  team: string | null;
  criticality: string | null;
}
export interface DeclaredImpactEdge {
  id: string;
  upstream: string;
  downstream: string;
  environment: string;
  syncType: string;
  circuitBreaker: boolean;
}
interface Edge {
  from: string;
  to: string;
  tier: number;
  syncType: string;
  evidenceKeys: string[];
}
const tierName = ['direct', 'unclassified', 'indirect', 'insulated'] as const;

/** Traverse known service calls and declarations, never ownership, routing or monitor edges.
 * @param graph - The same scoped identities and relationships shown by the topology explorer.
 * @param subject - Unambiguously selected failing service.
 * @param declared - Tenant catalog declarations. Their scoped names select, but never merge, identities.
 * @param maxDepth - Maximum reverse-call traversal depth.
 */
export function discoveredBlastRadius(
  graph: OperationalTopology,
  subject: TopologySubject,
  declared: { services: DeclaredImpactService[]; edges: DeclaredImpactEdge[] },
  maxDepth = 10,
): BlastRadius {
  const originScope: Record<string, string> = subject.scope.environment
    ? { environment: subject.scope.environment }
    : {};
  const nodes = new Map(
    graph.subjects.filter((item) => item.kind === 'service').map((item) => [item.key, item]),
  );
  const metadata = new Map<string, DeclaredImpactService>();
  const edges: Edge[] = [];
  let omitted = 0;
  for (const relation of graph.relations) {
    if (!isTopologyDependency(relation.kind)) continue;
    if (
      relation.stale ||
      relation.evidence === 'inferred' ||
      !nodes.has(relation.from) ||
      !nodes.has(relation.to)
    ) {
      omitted++;
      continue;
    }
    edges.push({
      from: relation.from,
      to: relation.to,
      tier: 1,
      syncType: 'unknown',
      evidenceKeys: relation.evidenceKeys,
    });
  }
  const catalog = new Map(declared.services.map((item) => [item.name, item]));
  const selectDeclared = (name: string, scope: Record<string, string>): string | null => {
    const selected = selectTopologySubject(graph, { name, kind: 'service', scope });
    if (selected.status === 'resolved') return selected.subject.key;
    if (selected.status === 'ambiguous') return null;
    const service = catalog.get(name);
    if (!service) return null;
    const key = JSON.stringify(['catalog', name, scope]);
    metadata.set(key, service);
    nodes.set(key, {
      key,
      kind: 'service',
      name,
      scope,
      resourceKeys: [],
      sources: [],
      stale: false,
    });
    return key;
  };
  for (const declaration of declared.edges) {
    const declarationScope = declaration.environment
      ? { environment: declaration.environment }
      : originScope;
    const from = selectDeclared(declaration.upstream, declarationScope),
      to = selectDeclared(declaration.downstream, declarationScope);
    if (!from || !to) {
      omitted++;
      continue;
    }
    edges.push({
      from,
      to,
      tier: declaration.circuitBreaker
        ? 3
        : declaration.syncType === 'async'
          ? 2
          : declaration.syncType === 'sync'
            ? 0
            : 1,
      syncType: declaration.syncType,
      evidenceKeys: [`catalog-dependency:${declaration.id}`],
    });
  }
  const incoming = new Map<string, Edge[]>();
  for (const edge of edges) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  const reached = new Map<string, { tier: number; hops: number; evidenceKeys: string[] }>();
  const visited = new Map<string, number>();
  const queue = [{ key: subject.key, tier: 0, hops: 0, evidenceKeys: [] as string[] }];
  const boundary: Array<{ key: string; tier: number }> = [];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    for (const edge of incoming.get(current.key) ?? []) {
      if (edge.from === subject.key) continue;
      const tier = Math.max(current.tier, edge.tier),
        hops = current.hops + 1;
      const state = JSON.stringify([edge.from, tier]);
      if ((visited.get(state) ?? Infinity) <= hops) continue;
      if (hops > maxDepth) {
        boundary.push({ key: edge.from, tier });
        continue;
      }
      visited.set(state, hops);
      const evidenceKeys = [...new Set([...current.evidenceKeys, ...edge.evidenceKeys])];
      queue.push({ key: edge.from, tier, hops, evidenceKeys });
      const known = reached.get(edge.from);
      if (!known || tier < known.tier || (tier === known.tier && hops < known.hops))
        reached.set(edge.from, { tier, hops, evidenceKeys });
    }
  }
  const dependents: BlastRadius['dependents'] = {
    direct: [],
    indirect: [],
    insulated: [],
    unclassified: [],
  };
  for (const [key, path] of reached) {
    const node = nodes.get(key)!;
    const entry: BlastRadiusDependent = {
      name: node.name,
      subjectKey: key,
      scope: node.scope,
      hops: path.hops,
      team: (metadata.get(key) ?? catalog.get(node.name))?.team ?? null,
      criticality: (metadata.get(key) ?? catalog.get(node.name))?.criticality ?? null,
      evidenceKeys: path.evidenceKeys,
    };
    if (path.tier === 2) entry.via = 'async';
    if (path.tier === 3) entry.via = 'circuit_breaker';
    dependents[tierName[path.tier]!]!.push(entry);
  }
  for (const values of Object.values(dependents))
    values.sort(
      (a, b) =>
        a.hops - b.hops ||
        a.name.localeCompare(b.name) ||
        (a.subjectKey ?? '').localeCompare(b.subjectKey ?? ''),
    );
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges.filter((item) => item.from === subject.key && item.to !== subject.key))
    outgoing.set(edge.to, [...(outgoing.get(edge.to) ?? []), edge]);
  return {
    service: subject.name,
    subjectKey: subject.key,
    scope: subject.scope,
    mapped: true,
    dependents,
    truncated: boundary.some(({ key, tier }) => !reached.has(key) || reached.get(key)!.tier > tier),
    suspects: [...outgoing].map(([key, paths]) => ({
      name: nodes.get(key)!.name,
      subjectKey: key,
      scope: nodes.get(key)!.scope,
      syncType: paths.every((path) => path.syncType === paths[0]!.syncType)
        ? paths[0]!.syncType
        : 'unknown',
      criticality: (metadata.get(key) ?? catalog.get(nodes.get(key)!.name))?.criticality ?? null,
      evidenceKeys: [...new Set(paths.flatMap((path) => path.evidenceKeys))],
    })),
    note: `Known service-call evidence and dependency declarations, not observed outages. Coverage may be incomplete.${omitted ? ` ${omitted} stale, inferred, ambiguous or non-service dependency relationships were excluded.` : ''}`,
  };
}
