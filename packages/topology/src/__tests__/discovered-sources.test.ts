import { expect, test } from 'vitest';
import { topologyRefKey, type TopologyEntity, type TopologyRelation } from '@sre/contracts';
import { discoveredSourceEvidence } from '../discovered-sources';
import { resolveDiscoveredTopology } from '../discovery';

const entity = (
  name: string,
  kind: TopologyEntity['kind'],
  environment = 'production',
): TopologyEntity => ({
  ref: { authority: 'test-provider', kind, id: name },
  name,
  kind,
  scope: { environment },
  attributes: {},
});
const api = entity('api', 'service'),
  worker = entity('worker', 'service');
const pod = entity('api-pod', 'workload'),
  sibling = entity('worker-pod', 'workload');
const deployment = entity('api-deployment', 'workload'),
  otherDeployment = entity('worker-deployment', 'workload');
const app = entity('gitops-app', 'deployment'),
  config = entity('config-repo', 'repository'),
  code = entity('monorepo', 'repository');
const edge = (
  from: TopologyEntity,
  to: TopologyEntity,
  kind: TopologyRelation['kind'],
  extra: Partial<TopologyRelation> = {},
): TopologyRelation => ({
  from: from.ref,
  to: to.ref,
  kind,
  evidence: 'provider_reference',
  description: kind,
  ...extra,
});
const rows: TopologyRelation[] = [
  edge(api, pod, 'runs_on', { evidence: 'observed' }),
  edge(worker, sibling, 'runs_on', { evidence: 'observed' }),
  edge(deployment, pod, 'owns'),
  edge(otherDeployment, sibling, 'owns'),
  edge(app, deployment, 'manages'),
  edge(app, otherDeployment, 'manages'),
  edge(app, config, 'deployed_from', {
    evidence: 'declared',
    scope: { path: 'apps/shared' },
    attributes: { role: 'deployment_config', revision: 'c'.repeat(40) },
  }),
  edge(pod, code, 'deployed_from', {
    evidence: 'declared',
    attributes: { role: 'application_source', revision: 'a'.repeat(40) },
  }),
  edge(sibling, code, 'deployed_from', {
    evidence: 'declared',
    attributes: { role: 'application_source', revision: 'b'.repeat(40) },
  }),
];
function graph(relations = rows) {
  const at = new Date().toISOString();
  return resolveDiscoveredTopology([
    {
      connectorId: 'source',
      connectorName: 'Test',
      connectorType: 'test',
      generation: 0,
      key: 'inventory',
      completeness: 'complete',
      observedAt: at,
      attemptedAt: at,
      issue: null,
      entities: [api, worker, pod, sibling, deployment, otherDeployment, app, config, code].map(
        (value) => ({ value, observedAt: at }),
      ),
      relations: relations.map((value) => ({ value, observedAt: at })),
    },
  ]);
}

test('correlates runtime ownership and GitOps configuration without including sibling application revisions', () => {
  const result = discoveredSourceEvidence(graph(), { key: topologyRefKey(api.ref) });
  expect(result.status).toBe('partial');
  expect(
    result.repositories.map((item) => [item.name, item.role, item.path, item.revision]),
  ).toEqual([
    ['config-repo', 'deployment_config', 'apps/shared', 'c'.repeat(40)],
    ['monorepo', 'application_source', null, 'a'.repeat(40)],
  ]);
  expect(result.repositories[0]?.evidenceKeys).toHaveLength(4);
  expect(result.repositories[1]?.evidenceKeys).toHaveLength(2);
  const workerResult = discoveredSourceEvidence(graph(), { key: topologyRefKey(worker.ref) });
  expect(
    workerResult.repositories.find((item) => item.role === 'application_source')?.revision,
  ).toBe('b'.repeat(40));
});

test('workload selection can inspect owned pod declarations without asserting a logical service', () => {
  const result = discoveredSourceEvidence(graph(), { key: topologyRefKey(deployment.ref) });
  expect(result.subject?.kind).toBe('workload');
  expect(result.repositories.find((item) => item.role === 'application_source')?.revision).toBe(
    'a'.repeat(40),
  );
  expect(result.repositories.some((item) => item.revision === 'b'.repeat(40))).toBe(false);
});

test('descriptor provenance does not authorize an application-source or deployed-revision claim', () => {
  const result = discoveredSourceEvidence(
    graph([
      edge(api, code, 'declared_in', {
        evidence: 'declared',
        scope: { path: 'catalog-info.yaml' },
        attributes: { revision: 'd'.repeat(40), role: 'application_source' },
      }),
    ]),
    { key: topologyRefKey(api.ref) },
  );
  expect(result.repositories).toHaveLength(1);
  expect(result.repositories[0]).toMatchObject({
    role: 'unknown',
    path: 'catalog-info.yaml',
    revision: 'd'.repeat(40),
  });
});

test('stale runtime and inferred relationships cannot select application sources', () => {
  const stale = graph();
  for (const relation of stale.relations) if (relation.kind === 'runs_on') relation.stale = true;
  expect(discoveredSourceEvidence(stale, { key: topologyRefKey(api.ref) }).repositories).toEqual(
    [],
  );
  const inferred = graph(
    rows.map((row) => (row.kind === 'runs_on' ? { ...row, evidence: 'inferred' } : row)),
  );
  expect(discoveredSourceEvidence(inferred, { key: topologyRefKey(api.ref) }).repositories).toEqual(
    [],
  );
});

test('ambiguous owners are not traversed and shared repositories do not create service edges', () => {
  const result = discoveredSourceEvidence(graph([...rows, edge(otherDeployment, pod, 'owns')]), {
    key: topologyRefKey(api.ref),
  });
  expect(result.repositories.map((item) => item.role)).toEqual(['application_source']);
  expect(result.note).toContain('Conflicting runtime ownership');
  expect(discoveredSourceEvidence(graph(), { key: topologyRefKey(code.ref) }).repositories).toEqual(
    [],
  );
});

test('preserves multiple configuration components and requires exact subject selection', () => {
  const result = discoveredSourceEvidence(
    graph([
      ...rows,
      edge(app, config, 'deployed_from', {
        evidence: 'declared',
        scope: { path: 'apps/second' },
        attributes: { role: 'deployment_config', revision: 'd'.repeat(40) },
      }),
    ]),
    { key: topologyRefKey(app.ref) },
  );
  expect(result.repositories.map((item) => item.path).sort()).toEqual([
    'apps/second',
    'apps/shared',
  ]);
  expect(discoveredSourceEvidence(graph(), { name: 'not-a-subject' }).status).toBe('unavailable');
});
