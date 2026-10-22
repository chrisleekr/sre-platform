import { expect, test } from 'vitest';
import {
  entityCandidateKey,
  topologyRefKey,
  type AffectedEntityCandidate,
  type TopologyEntity,
  type TopologyRelation,
} from '@sre/contracts';
import { resolveDiscoveredTopology } from '../discovery';
import { discoveredOperationalTopology } from '../operational';
import { incidentTopologyContext } from '../incident-context';

const workload = (kind: string, name: string, namespace = 'edge'): TopologyEntity => ({
  ref: { authority: 'kubernetes-cluster:one', kind, id: `${kind}-${name}-${namespace}` },
  kind: 'workload',
  name,
  scope: { cluster: 'kubernetes-cluster:one', namespace },
  attributes: { resourceKind: kind },
});
const deployment = workload('Deployment', 'edge-proxy'),
  replicas = workload('ReplicaSet', 'edge-proxy-7c4584b84'),
  pod = workload('Pod', 'edge-proxy-7c4584b84-sp9ww');
const owns = (from: TopologyEntity, to: TopologyEntity): TopologyRelation => ({
  from: from.ref,
  to: to.ref,
  kind: 'owns',
  evidence: 'provider_reference',
  description: 'owner',
});
function resolve(
  entities: TopologyEntity[],
  name: string,
  kind: 'workload' | 'node' = 'workload',
  { source = 'alert_text', scope: extra = {} as Record<string, string> } = {},
) {
  const at = new Date().toISOString();
  const discovery = resolveDiscoveredTopology([
    {
      connectorId: 'runtime',
      connectorName: 'Runtime',
      connectorType: 'kubernetes',
      key: 'inventory',
      completeness: 'complete',
      issue: null,
      observedAt: at,
      attemptedAt: at,
      entities: entities.map((value) => ({ value, observedAt: at })),
      relations: [owns(deployment, replicas), owns(replicas, pod)].map((value) => ({
        value,
        observedAt: at,
      })),
    },
  ]);
  const scope: Record<string, string> = kind === 'node' ? {} : { namespace: 'edge', ...extra };
  const candidate: AffectedEntityCandidate = {
    key: entityCandidateKey(kind, name, scope),
    kind,
    stableId: name,
    displayName: name,
    scope,
    provenance: { kind: 'provider_label', source },
    confidence: 70,
    observedAt: at,
    completeness: 'partial',
    requiredCapabilities: ['runtime'],
  };
  return incidentTopologyContext(
    {
      observations: [{ signalId: 'signal', source: null, candidates: [candidate] }],
      mappings: [],
      services: [],
    },
    discoveredOperationalTopology(discovery),
    discovery,
  ).resolutions[0];
}

test('an alert-named pod resolves to its owning Deployment subject', () => {
  expect(resolve([deployment, replicas, pod], 'edge-proxy-7c4584b84-sp9ww')).toMatchObject({
    status: 'resolved',
    subjectKey: topologyRefKey(deployment.ref),
  });
});

test('the same name in another namespace or under two resource kinds is never chosen', () => {
  expect(resolve([deployment, workload('Deployment', 'other', 'ops')], 'other')).toMatchObject({
    status: 'unmapped',
  });
  expect(resolve([deployment, workload('StatefulSet', 'edge-proxy')], 'edge-proxy')).toMatchObject({
    status: 'ambiguous',
    candidateSubjectKeys: [],
  });
});

test('a node address stays unmapped without node inventory', () => {
  expect(resolve([deployment], '192.168.1.203', 'node')).toMatchObject({ status: 'unmapped' });
});

test('webhook labels keep name selection and an alert-text scope pin is honoured', () => {
  const all = [deployment, replicas, pod];
  expect(
    resolve(all, 'edge-proxy-7c4584b84-sp9ww', 'workload', { source: 'alertmanager' }),
  ).toMatchObject({ status: 'unmapped' });
  expect(
    resolve(all, 'edge-proxy-7c4584b84-sp9ww', 'workload', {
      scope: { cluster: 'kubernetes-cluster:two' },
    }),
  ).toMatchObject({ status: 'unmapped' });
  expect(
    resolve(all, 'edge-proxy-7c4584b84-sp9ww', 'workload', { scope: { dataSourceId: 'other' } }),
  ).toMatchObject({ status: 'unmapped' });
  expect(
    resolve(all, 'edge-proxy-7c4584b84-sp9ww', 'workload', {
      scope: { cluster: 'kubernetes-cluster:one', dataSourceId: 'runtime' },
    }),
  ).toMatchObject({ status: 'resolved', subjectKey: topologyRefKey(deployment.ref) });
});
