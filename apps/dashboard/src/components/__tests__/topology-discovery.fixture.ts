import type { TopologyGraph } from '../../lib/topology';
import type { TopologyDiscoveryGraph } from '../../lib/topology';
import type { TopologyFactSource, TopologySubject } from '@sre/contracts';

export function discoveryFixture(): TopologyDiscoveryGraph {
  const observedAt = '2026-09-12T00:00:00.000Z';
  const source = (name: string): TopologyFactSource => ({
    connectorId: name,
    connectorName: name,
    connectorType: name,
    collection: 'inventory',
    observedAt,
    completeness: name === 'APM' ? 'partial' : 'complete',
  });
  const entries: Array<{
    key: string;
    kind: TopologySubject['kind'];
    name: string;
    scope: Record<string, string>;
    source: string;
  }> = [
    {
      key: 'checkout-prod',
      kind: 'service' as const,
      name: 'checkout',
      scope: { environment: 'production' },
      source: 'APM',
    },
    {
      key: 'checkout-dev',
      kind: 'service' as const,
      name: 'checkout',
      scope: { environment: 'development' },
      source: 'APM',
    },
    {
      key: 'api',
      kind: 'workload' as const,
      name: 'checkout-api',
      scope: { namespace: 'production', cluster: 'cluster-one' },
      source: 'Kubernetes',
    },
    {
      key: 'repository',
      kind: 'repository' as const,
      name: 'team/platform-config',
      scope: { host: 'git.example.test' },
      source: 'GitLab',
    },
    {
      key: 'monitor',
      kind: 'monitor' as const,
      name: 'scrape-checkout',
      scope: { namespace: 'production' },
      source: 'Prometheus',
    },
  ];
  const entities: TopologyDiscoveryGraph['entities'] = entries.map((entry) => ({
    ref: { authority: entry.source, kind: entry.kind, id: entry.key },
    key: entry.key,
    kind: entry.kind,
    name: entry.name,
    scope: entry.scope,
    attributes: {},
    sources: [source(entry.source)],
    stale: entry.key === 'checkout-dev',
  }));
  const relations: TopologyDiscoveryGraph['relations'] = [
    {
      key: 'runtime',
      fromKey: 'checkout-prod',
      toKey: 'api',
      kind: 'runs_on',
      evidence: 'observed',
      description: 'Span resource attributes identify the pod UID.',
      from: entities[0]!.ref,
      to: entities[2]!.ref,
      sources: [source('APM')],
      stale: false,
    },
    {
      key: 'deployment',
      fromKey: 'api',
      toKey: 'repository',
      kind: 'deployed_from',
      evidence: 'declared',
      description: 'Deployment configuration source, not necessarily application source code.',
      from: entities[2]!.ref,
      to: entities[3]!.ref,
      sources: [source('GitLab')],
      stale: false,
      scope: { path: 'apps/checkout', revision: 'abc123' },
      attributes: { role: 'deployment_config', revision: 'a'.repeat(40) },
    },
    {
      key: 'monitoring',
      fromKey: 'monitor',
      toKey: 'api',
      kind: 'monitors',
      evidence: 'provider_reference',
      description: 'Scrape target discovery references the pod.',
      from: entities[4]!.ref,
      to: entities[2]!.ref,
      sources: [source('Prometheus')],
      stale: false,
    },
  ];
  return {
    entities,
    relations,
    conflicts: [],
    coverage: ['Kubernetes', 'APM', 'GitLab', 'Prometheus'].map((name) => ({
      ...source(name),
      attemptedAt: observedAt,
      issue: name === 'APM' ? 'sampling' : null,
    })),
    operational: {
      subjects: entities.map((entity) => ({ ...entity, resourceKeys: [entity.key] })),
      relations: relations.map((relation) => ({
        from: relation.fromKey!,
        to: relation.toKey!,
        kind: relation.kind,
        evidence: relation.evidence,
        evidenceKeys: [relation.key],
        stale: relation.stale,
      })),
    },
  };
}

export const catalogGraph: TopologyGraph = {
  nodes: [
    {
      name: 'checkout',
      team: null,
      criticality: null,
      lastDeployAt: null,
      recentDeploys: [],
    },
    {
      name: 'payments',
      team: null,
      criticality: null,
      lastDeployAt: null,
      recentDeploys: [],
    },
  ],
  edges: [
    { upstream: 'checkout', downstream: 'payments', syncType: 'sync', circuitBreaker: false },
  ],
};
