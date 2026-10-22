import { expect, test, vi } from 'vitest';
import {
  entityCandidateKey,
  topologyRefKey,
  type TopologyEntity,
  type TopologyRef,
  type TopologyRelation,
} from '@sre/contracts';
import {
  discoveredOperationalTopology,
  discoveredSourceEvidence,
  incidentTopologyContext,
  resolveDiscoveredTopology,
} from '@sre/topology';
import { createFixture } from './code-intelligence.fixture';

const fixture = createFixture();
const gitlabId = fixture.repository().dataSourceId;
const at = new Date().toISOString();
const workload = (kind: string, name: string): TopologyEntity => ({
  ref: { authority: 'kubernetes-cluster:one', kind, id: `${name}-uid` },
  aliases: [
    { authority: 'kubernetes-object', kind, id: JSON.stringify(['edge-proxy', `${name}-uid`]) },
  ],
  kind: 'workload',
  name,
  scope: { cluster: 'kubernetes-cluster:one', namespace: 'edge-proxy' },
  attributes: { resourceKind: kind, uid: `${name}-uid` },
});
const deployment = workload('Deployment', 'edge-proxy-edge'),
  replicas = workload('ReplicaSet', 'edge-proxy-edge-7c4584b84'),
  pod = workload('Pod', 'edge-proxy-edge-7c4584b84-sp9ww');
// A sibling workload in the same Argo CD application, running another GitLab project's image.
const sibling = workload('Deployment', 'edge-proxy-admin'),
  siblingReplicas = workload('ReplicaSet', 'edge-proxy-admin-5d9f'),
  siblingPod = workload('Pod', 'edge-proxy-admin-5d9f-x2k7q');
const admin: TopologyEntity = {
  ref: { authority: 'repository:gitlab.chrislee.kr', kind: 'repository', id: 'chrisleekr/admin' },
  aliases: [{ authority: 'oci:registry.chrislee.kr', kind: 'repository', id: 'chrisleekr/admin' }],
  kind: 'repository',
  name: 'chrisleekr/admin',
  scope: {},
  attributes: { evidence: 'connector_catalog' },
};
const project: TopologyEntity = {
  ref: {
    authority: 'repository:gitlab.chrislee.kr',
    kind: 'repository',
    id: 'chrisleekr/edge-proxy',
  },
  // Shape emitted by repositoryTopology for a project with a container registry image prefix.
  aliases: [
    { authority: 'oci:registry.chrislee.kr', kind: 'repository', id: 'chrisleekr/edge-proxy' },
  ],
  kind: 'repository',
  name: 'chrisleekr/edge-proxy',
  scope: {},
  attributes: { evidence: 'connector_catalog' },
};
const app: TopologyEntity = {
  ref: { authority: 'connector:argocd', kind: 'application', id: 'app-uid' },
  kind: 'deployment',
  name: 'edge-proxy',
  scope: { project: 'default', namespace: 'argocd' },
  attributes: { resourceKind: 'Application' },
};
const relation = (
  from: TopologyRef,
  to: TopologyRef,
  kind: TopologyRelation['kind'],
  attributes?: Record<string, string>,
): TopologyRelation => ({
  from,
  to,
  kind,
  evidence: kind === 'deployed_from' ? 'declared' : 'provider_reference',
  description: kind,
  ...(attributes ? { attributes } : {}),
});
// Argo CD records images on the resource-tree pod node, keyed by its object locator.
const image = (from: TopologyEntity, id: string, host = 'registry.chrislee.kr') =>
  relation(
    from.aliases![0]!,
    { authority: `oci:${host}`, kind: 'repository', id },
    'deployed_from',
    {
      role: 'application_source',
      provenance: 'image_path',
    },
  );
const collection = (
  connectorId: string,
  type: string,
  entities: TopologyEntity[],
  relations: TopologyRelation[],
) => ({
  connectorId,
  connectorName: type,
  connectorType: type,
  key: type,
  completeness: 'complete' as const,
  issue: null,
  observedAt: at,
  attemptedAt: at,
  generation: 3,
  entities: entities.map((value) => ({ value, observedAt: at })),
  relations: relations.map((value) => ({ value, observedAt: at })),
});

function sourceEvidence() {
  const graph = resolveDiscoveredTopology([
    collection(gitlabId, 'gitlab', [project, admin], []),
    collection(
      '00000000-0000-4000-8000-000000000003',
      'kubernetes',
      [deployment, replicas, pod, sibling, siblingReplicas, siblingPod],
      [
        relation(deployment.ref, replicas.ref, 'owns'),
        relation(replicas.ref, pod.ref, 'owns'),
        relation(sibling.ref, siblingReplicas.ref, 'owns'),
        relation(siblingReplicas.ref, siblingPod.ref, 'owns'),
      ],
    ),
    collection(
      '00000000-0000-4000-8000-000000000004',
      'argocd',
      [app],
      [
        relation(app.ref, deployment.aliases![0]!, 'manages'),
        relation(app.ref, sibling.aliases![0]!, 'manages'),
        // Sub-path image: only the two-segment prefix is claimed by the GitLab project.
        image(pod, 'chrisleekr/edge-proxy'),
        image(pod, 'chrisleekr/edge-proxy/edge-proxy'),
        image(pod, 'valkey/valkey', 'docker.io'),
        image(siblingPod, 'chrisleekr/admin'),
      ],
    ),
  ]);
  const scope = { namespace: 'edge-proxy' };
  const operational = discoveredOperationalTopology(graph);
  const resolution = incidentTopologyContext(
    {
      observations: [
        {
          signalId: 'signal',
          source: null,
          candidates: [
            {
              key: entityCandidateKey('workload', pod.name, scope),
              kind: 'workload',
              stableId: pod.name,
              displayName: `Pod edge-proxy/${pod.name}`,
              scope,
              provenance: { kind: 'provider_label', source: 'alert_text' },
              confidence: 70,
              observedAt: at,
              completeness: 'partial',
              requiredCapabilities: ['runtime'],
            },
          ],
        },
      ],
      mappings: [],
      services: [],
    },
    operational,
    graph,
  ).resolutions[0]!;
  expect(resolution).toMatchObject({
    status: 'resolved',
    subjectKey: topologyRefKey(deployment.ref),
  });
  return discoveredSourceEvidence({ ...graph, operational }, { key: resolution.subjectKey });
}

test('an alert-named workload reaches its GitLab source through the running image path', async () => {
  const evidence = sourceEvidence();
  expect(
    evidence.repositories
      .filter((item) => item.role === 'application_source')
      .map((item) => item.name),
  ).toEqual(['chrisleekr/edge-proxy']);
  const reader = fixture.reader();
  // The catalog answers only the canonical source locator, never the registry alias.
  reader.resolveRepository = vi.fn(async (ref: TopologyRef) =>
    topologyRefKey(ref) === topologyRefKey(project.ref)
      ? fixture.repository({ provider: 'gitlab', fullName: 'chrisleekr/edge-proxy' })
      : null,
  );
  const testcase = fixture.setup({
    reader,
    connectors: [
      {
        ...fixture.connector(reader),
        type: 'gitlab',
        generation: { id: gitlabId, lifecycleVersion: 3 },
      },
    ],
  });
  testcase.context.sources = vi.fn(async () => evidence);
  const result = await testcase.run({ stackTrace: '/workspace/src/proxy.ts:42' });
  if (!result.available) throw new Error('Expected code result');
  expect(result.data.status).not.toBe('missing_mapping');
  expect(result.data.status).toBe('missing_revision');
  expect(reader.resolveRepository).toHaveBeenCalledWith(project.ref);
});
