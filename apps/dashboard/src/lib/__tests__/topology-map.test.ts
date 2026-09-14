import { expect, test } from 'vitest';
import type { TopologySubject, OperationalTopology } from '@sre/contracts';
import { topologyMapGroups, topologyMapProjection } from '../topology-map';

const subject = (key: string, cluster = 'one'): TopologySubject => ({
  key,
  name: 'api',
  kind: 'workload',
  scope: { namespace: 'apps', cluster },
  resourceKeys: [key],
  sources: [],
  stale: false,
});
const relation = (
  from: string,
  to: string,
  evidence: 'observed' | 'declared' = 'observed',
): OperationalTopology['relations'][number] => ({
  from,
  to,
  kind: 'manages',
  evidence,
  evidenceKeys: [`${from}-${to}`],
  stale: false,
});
test('groups repeated namespace text without collapsing distinct resource identities or clusters', () => {
  const subjects = [subject('a'), subject('b'), subject('c', 'two')];
  const groups = topologyMapGroups(subjects);
  expect(groups).toHaveLength(2);
  expect(groups[0]!.members.map((member) => member.key)).toEqual(['a', 'b']);
  expect(topologyMapProjection(subjects, []).edges).toEqual([]);
  const expanded = topologyMapProjection(subjects, [relation('a', 'b')], {
    expanded: groups[0]!.key,
  });
  expect(expanded.nodes.map((node) => node.key)).toEqual(['a', 'b']);
  expect(expanded.edges[0]).toMatchObject({ from: 'a', to: 'b', evidence: 'observed' });
});
test('keeps direction, evidence class and individual references when aggregating between groups', () => {
  const subjects = [subject('a'), subject('b'), subject('c', 'two')];
  const edges = [
    relation('a', 'c'),
    relation('b', 'c'),
    relation('a', 'c', 'declared'),
    relation('c', 'a'),
  ];
  const before = JSON.stringify({ subjects, edges });
  const map = topologyMapProjection(subjects, edges);
  expect(map.edges).toHaveLength(3);
  expect(map.edges.find((edge) => edge.relations.length === 2)?.relations).toEqual(
    edges.slice(0, 2),
  );
  expect(JSON.stringify({ subjects, edges })).toBe(before);
  expect(topologyMapProjection(subjects.slice(0, 2), edges).edges).toEqual([]);
});
test('progressively expands large groups without replacing previously visible identities', () => {
  const subjects = Array.from({ length: 65 }, (_, index) =>
    subject(String(index).padStart(2, '0')),
  );
  const key = topologyMapGroups(subjects)[0]!.key;
  const first = topologyMapProjection(subjects, [], { expanded: key });
  const more = topologyMapProjection(subjects, [], { expanded: key, limit: 40 });
  expect(first.nodes).toHaveLength(20);
  expect(first.more).toBe(45);
  expect(more.nodes.slice(0, 20)).toEqual(first.nodes);
  expect(topologyMapProjection(subjects, []).disconnected).toHaveLength(1);
});
test('separates service calls from resource context and never promotes workloads to services', () => {
  const subjects = [
    subject('runtime'),
    ...['one', 'two'].map((key) => ({ ...subject(key), kind: 'service' as const })),
  ];
  const links = [{ ...relation('one', 'two'), kind: 'calls' as const }, relation('one', 'runtime')];
  const dependencies = topologyMapProjection(subjects, links, { mode: 'dependencies' });
  expect(dependencies.nodes.map((node) => node.key)).toEqual(['one', 'two']);
  expect(dependencies.edges.map((edge) => edge.kind)).toEqual(['calls']);
  expect(
    topologyMapProjection(subjects, links, { focus: 'one' }).edges.map((edge) => edge.kind),
  ).toEqual(['manages']);
});
test('focuses exact neighbours, reports omitted paths and keeps stale evidence independent of type', () => {
  const subjects = ['a', 'b', 'c'].map((key) => subject(key));
  const links = [
    relation('a', 'b'),
    { ...relation('a', 'b'), stale: true },
    relation('a', 'c', 'declared'),
  ];
  const first = topologyMapProjection(subjects, links, { focus: 'a', limit: 2 });
  expect(first.nodes.map((node) => node.key)).toEqual(['a', 'b']);
  expect(first.omitted).toBe(1);
  expect(first.more).toBe(1);
  expect(first.edges[0]).toMatchObject({ evidence: 'observed', stale: false, staleCount: 1 });
  expect(topologyMapProjection(subjects, links, { focus: 'a', limit: 3 }).omitted).toBe(0);
});

test('shows explicit dependencies as declarations rather than converting them to calls', () => {
  const subjects = ['one', 'two'].map((key) => ({ ...subject(key), kind: 'service' as const }));
  const declared = { ...relation('one', 'two', 'declared'), kind: 'depends_on' as const };
  const graph = topologyMapProjection(subjects, [declared], { mode: 'dependencies' });
  expect(graph.edges[0]).toMatchObject({ kind: 'depends_on', evidence: 'declared' });
  expect(topologyMapProjection(subjects, [declared], { focus: 'one' }).edges).toEqual([]);
});
