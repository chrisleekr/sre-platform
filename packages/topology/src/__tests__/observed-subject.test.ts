import { expect, test } from 'vitest';
import {
  topologyRefKey,
  type AffectedEntityCandidate,
  type TopologyEntity,
  type TopologyRelation,
} from '@sre/contracts';
import { resolveDiscoveredTopology } from '../discovery';
import { discoveredOperationalTopology } from '../operational';
import { observedTopologySubject } from '../observed-subject';

const entity = (id: string, kind: TopologyEntity['kind']): TopologyEntity => ({
  ref: { authority: 'runtime', kind, id },
  name: id,
  kind,
  scope: { namespace: 'prod' },
  attributes: {},
});
const pod = entity('pod', 'workload'),
  sibling = entity('sibling', 'workload'),
  parent = entity('deployment', 'workload');
const service = entity('api', 'service'),
  other = entity('worker', 'service');
const edge = (
  from: TopologyEntity,
  to: TopologyEntity,
  kind: TopologyRelation['kind'],
): TopologyRelation => ({
  from: from.ref,
  to: to.ref,
  kind,
  evidence: kind === 'owns' ? 'provider_reference' : 'observed',
  description: kind,
});
const candidate: AffectedEntityCandidate = {
  key: 'captured-pod',
  kind: 'workload',
  stableId: 'pod',
  displayName: 'Pod',
  scope: { dataSourceId: 'source', namespace: 'prod' },
  topologyRef: pod.ref,
  provenance: { kind: 'platform_snapshot', source: 'runtime' },
  confidence: 100,
  observedAt: new Date().toISOString(),
  completeness: 'complete',
  requiredCapabilities: ['topology'],
};
function graph(
  relations = [
    edge(parent, pod, 'owns'),
    edge(parent, sibling, 'owns'),
    edge(service, pod, 'runs_on'),
    edge(other, sibling, 'runs_on'),
  ],
) {
  const at = new Date().toISOString();
  return resolveDiscoveredTopology([
    {
      connectorId: 'source',
      connectorName: 'Runtime',
      connectorType: 'kubernetes',
      key: 'inventory',
      completeness: 'complete',
      issue: null,
      observedAt: at,
      attemptedAt: at,
      entities: [pod, sibling, parent, service, other].map((value) => ({ value, observedAt: at })),
      relations: relations.map((value) => ({ value, observedAt: at })),
    },
  ]);
}

test('an exact pod selects its service, never a sibling service sharing its controller', () => {
  const discovery = graph();
  expect(
    observedTopologySubject(candidate, discovery, discoveredOperationalTopology(discovery)),
  ).toMatchObject({ status: 'resolved', subjectKey: topologyRefKey(service.ref) });
});

test('several services on the exact resource remain ambiguous', () => {
  const discovery = graph([edge(service, pod, 'runs_on'), edge(other, pod, 'runs_on')]);
  const result = observedTopologySubject(
    candidate,
    discovery,
    discoveredOperationalTopology(discovery),
  );
  expect(result.status).toBe('ambiguous');
  expect(result.candidateSubjectKeys.sort()).toEqual(
    [topologyRefKey(service.ref), topologyRefKey(other.ref)].sort(),
  );
});

test('ownership alone selects a resource group without inventing a logical service', () => {
  const discovery = graph([edge(parent, pod, 'owns')]);
  expect(
    observedTopologySubject(candidate, discovery, discoveredOperationalTopology(discovery)),
  ).toMatchObject({ status: 'resolved', subjectKey: topologyRefKey(parent.ref) });
});

test('declared or inferred runtime edges do not promote a captured resource into a proven service', () => {
  for (const evidence of ['declared', 'inferred'] as const) {
    const discovery = graph([{ ...edge(service, pod, 'runs_on'), evidence }]);
    expect(
      observedTopologySubject(candidate, discovery, discoveredOperationalTopology(discovery)),
    ).toMatchObject({ status: 'resolved', subjectKey: topologyRefKey(pod.ref) });
  }
});

test('stale, conflicting, inferred, wrong-source and wrong-namespace evidence cannot establish identity', () => {
  const discovery = graph();
  const operational = discoveredOperationalTopology(discovery);
  const variants: AffectedEntityCandidate[] = [
    { ...candidate, scope: { namespace: 'other' } },
    { ...candidate, scope: { dataSourceId: 'foreign' } },
    { ...candidate, topologyRef: { ...pod.ref, id: 'recreated-pod' } },
    { ...candidate, provenance: { kind: 'classifier_inference' as const, source: 'classifier' } },
  ];
  for (const altered of variants)
    expect(observedTopologySubject(altered, discovery, operational).status).toBe('needs_evidence');
  discovery.conflicts.push({ ref: pod.ref, reason: 'conflicting_identity' });
  expect(observedTopologySubject(candidate, discovery, operational).status).toBe('ambiguous');
  discovery.entities.find((item) => item.key === topologyRefKey(pod.ref))!.stale = true;
  expect(observedTopologySubject(candidate, discovery, operational).status).toBe('needs_evidence');
});
