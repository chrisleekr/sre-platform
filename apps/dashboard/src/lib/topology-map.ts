import type { TopologySubject, OperationalTopology } from '@sre/contracts';
import { isTopologyDependency } from '@sre/contracts';

export type TopologyMapMode = 'dependencies' | 'traffic' | 'resources';
export interface TopologyMapNode {
  key: string;
  name: string;
  scope: string;
  members: TopologySubject[];
  group: boolean;
  parent?: string;
}
export interface TopologyMapEdge {
  key: string;
  from: string;
  to: string;
  kind: OperationalTopology['relations'][number]['kind'];
  evidence: OperationalTopology['relations'][number]['evidence'];
  relations: OperationalTopology['relations'];
  stale: boolean;
  staleCount: number;
}
export const mapRelationLabel = (kind: string) => kind.replaceAll('_', ' ');
const scopeLabel = (subject: TopologySubject) =>
  Object.entries(subject.scope)
    .map(([field, value]) => `${field}: ${value}`)
    .join(' · ');
const nodeOf = (subject: TopologySubject): TopologyMapNode => ({
  key: subject.key,
  name: subject.name,
  scope: scopeLabel(subject),
  members: [subject],
  group: false,
});

/** Scope containers preserve resource identities, including unknown cluster and source boundaries. */
export function topologyMapGroups(subjects: TopologySubject[]): TopologyMapNode[] {
  const groups = new Map<string, TopologyMapNode>();
  for (const subject of subjects) {
    const sources = [...new Set(subject.sources.map((source) => source.connectorId))].sort();
    const key = JSON.stringify([
      'scope',
      subject.scope.cluster ?? '',
      subject.scope.namespace ?? '',
      subject.scope.environment ?? '',
      subject.scope.project ?? '',
      subject.scope.serviceNamespace ?? '',
      subject.scope.namespace ? '' : subject.kind,
      subject.scope.cluster ? [] : sources,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: subject.scope.namespace || subject.scope.environment || subject.kind,
        scope:
          scopeLabel(subject) ||
          [...new Set(subject.sources.map((source) => source.connectorName))].sort().join(' · '),
        members: [],
        group: true,
      };
      groups.set(key, group);
    }
    group.members.push(subject);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      members: group.members.sort(
        (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** Project a connected overview or exact neighbourhood without inventing service-call edges. */
export function topologyMapProjection(
  subjects: TopologySubject[],
  relations: OperationalTopology['relations'],
  {
    mode = 'resources',
    expanded = null,
    focus = null,
    limit = 20,
  }: {
    mode?: TopologyMapMode;
    expanded?: string | null;
    focus?: string | null;
    limit?: number;
  } = {},
) {
  const eligible =
    mode === 'dependencies'
      ? subjects.filter((subject) => subject.kind === 'service')
      : mode === 'traffic'
        ? subjects.filter((subject) => subject.kind === 'workload' || subject.kind === 'endpoint')
        : subjects;
  const known = new Set(eligible.map((subject) => subject.key));
  const links = relations.filter(
    (relation) =>
      known.has(relation.from) &&
      known.has(relation.to) &&
      (mode !== 'resources'
        ? isTopologyDependency(relation.kind)
        : !isTopologyDependency(relation.kind)),
  );
  const degree = new Map<string, number>();
  for (const link of links)
    for (const key of [link.from, link.to]) degree.set(key, (degree.get(key) ?? 0) + 1);
  const rank = (a: TopologyMapNode, b: TopologyMapNode) =>
    b.members.reduce((n, item) => n + (degree.get(item.key) ?? 0), 0) -
      a.members.reduce((n, item) => n + (degree.get(item.key) ?? 0), 0) ||
    a.name.localeCompare(b.name) ||
    a.key.localeCompare(b.key);
  const groups = mode === 'resources' ? topologyMapGroups(eligible) : eligible.map(nodeOf);
  const active = groups.find((group) => group.group && group.key === expanded);
  const focused = eligible.find((subject) => subject.key === focus);
  const membership = new Map(
    groups.flatMap((group) => group.members.map((member) => [member.key, group.key] as const)),
  );
  const connectedGroups = new Set(
    links
      .filter(
        (link) => mode !== 'resources' || membership.get(link.from) !== membership.get(link.to),
      )
      .flatMap((link) => [membership.get(link.from), membership.get(link.to)]),
  );
  let candidates: TopologyMapNode[];
  if (focused) {
    const neighbours = new Set(
      links
        .filter((link) => link.from === focus || link.to === focus)
        .flatMap((link) => [link.from, link.to]),
    );
    candidates = [
      nodeOf(focused),
      ...eligible
        .filter((subject) => subject.key !== focus && neighbours.has(subject.key))
        .map(nodeOf)
        .sort(rank),
    ];
  } else if (active) {
    const own = new Set(active.members.map((member) => member.key));
    const neighbours = new Set(
      links
        .filter((link) => own.has(link.from) || own.has(link.to))
        .flatMap((link) => [membership.get(link.from), membership.get(link.to)]),
    );
    candidates = [
      ...active.members.map((member) => ({ ...nodeOf(member), parent: active.key })).sort(rank),
      ...groups.filter((group) => group.key !== active.key && neighbours.has(group.key)).sort(rank),
    ];
  } else candidates = groups.filter((group) => connectedGroups.has(group.key)).sort(rank);
  const nodes = candidates.slice(0, Math.max(1, limit));
  const visible = new Set(nodes.map((node) => node.key));
  const endpoint = (key: string) => {
    if (focused || mode !== 'resources') return key;
    const group = membership.get(key);
    return group === active?.key ? key : group;
  };
  const edges = new Map<string, TopologyMapEdge>();
  let internal = 0,
    omitted = 0;
  for (const relation of links) {
    const from = endpoint(relation.from),
      to = endpoint(relation.to);
    if (!from || !to || !visible.has(from) || !visible.has(to)) {
      if (visible.has(from ?? '') || visible.has(to ?? '')) omitted++;
      continue;
    }
    if (from === to && !focused && mode === 'resources' && from !== relation.from) {
      internal++;
      continue;
    }
    const key = JSON.stringify([from, to, relation.kind, relation.evidence]);
    const edge = edges.get(key) ?? {
      key,
      from,
      to,
      kind: relation.kind,
      evidence: relation.evidence,
      relations: [],
      stale: true,
      staleCount: 0,
    };
    edge.relations.push(relation);
    edge.stale &&= relation.stale;
    if (relation.stale) edge.staleCount++;
    edges.set(key, edge);
  }
  return {
    nodes,
    edges: [...edges.values()],
    groups,
    active: focused ? undefined : active,
    focused,
    internal,
    omitted,
    more: candidates.length - nodes.length,
    disconnected: groups.filter((group) => !connectedGroups.has(group.key)),
    linkCount: links.length,
    subjectCount: eligible.length,
  };
}
