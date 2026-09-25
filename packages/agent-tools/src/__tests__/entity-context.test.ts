import { describe, expect, test } from 'vitest';
import { entityCandidateKey, type AffectedEntityCandidate } from '@sre/contracts';
import {
  createDataSourceConnector,
  dataSourceEntityCoverage,
  kubernetesEntityCoverage,
  repositoryEntityCoverage,
  staticEntityCoverage,
  type IDataSourceConnector,
} from '@sre/connectors';
import { entityCapabilityGaps } from '../entity-context';

const candidate = (namespace: string, cluster = 'production'): AffectedEntityCandidate => ({
  key: entityCandidateKey('workload', 'worker-7d9f', { cluster, namespace }),
  kind: 'workload',
  stableId: 'worker-7d9f',
  displayName: 'worker-7d9f',
  scope: { cluster, namespace },
  provenance: { kind: 'provider_label', source: 'pod' },
  confidence: 90,
  observedAt: '2026-08-31T00:00:00.000Z',
  completeness: 'complete',
  requiredCapabilities: ['runtime', 'logs'],
});

const connector = (
  id: string,
  entityCoverage: NonNullable<IDataSourceConnector['entityCoverage']>,
): IDataSourceConnector =>
  ({ id, name: id, type: 'kubernetes', entityCoverage }) as IDataSourceConnector;

describe('entity capability gaps', () => {
  test('distinguishes a wrong connector scope from a missing capability', async () => {
    const gaps = await entityCapabilityGaps(
      [candidate('team-b')],
      [connector('team-a-cluster', kubernetesEntityCoverage('team-a', 'production', 'team-a'))],
    );

    expect(gaps).toEqual([
      expect.objectContaining({ capability: 'runtime', reason: 'scope_mismatch' }),
      expect.objectContaining({ capability: 'logs', reason: 'scope_mismatch' }),
    ]);
  });

  test('reports no gap when any enabled instance covers the entity', async () => {
    const gaps = await entityCapabilityGaps(
      [candidate('team-b')],
      [
        connector('team-a-cluster', kubernetesEntityCoverage('team-a', 'production', 'team-a')),
        connector('cluster-wide', kubernetesEntityCoverage(null, 'production', 'all')),
      ],
    );
    expect(gaps).toEqual([]);
  });

  test('reports another configured cluster as a scope mismatch', async () => {
    const gaps = await entityCapabilityGaps(
      [candidate('team-a', 'production')],
      [connector('staging', kubernetesEntityCoverage(null, 'staging', 'staging'))],
    );

    expect(gaps).toEqual([
      expect.objectContaining({ capability: 'runtime', reason: 'scope_mismatch' }),
      expect.objectContaining({ capability: 'logs', reason: 'scope_mismatch' }),
    ]);
  });

  test('does not mistake a capability for coverage of an unsupported entity kind', async () => {
    const service: AffectedEntityCandidate = {
      ...candidate('team-b'),
      key: entityCandidateKey('service', 'billing-api'),
      kind: 'service',
      stableId: 'billing-api',
      displayName: 'billing-api',
      scope: {},
      requiredCapabilities: ['source_code'],
    };
    const gaps = await entityCapabilityGaps(
      [service],
      [connector('network', staticEntityCoverage(['source_code'], ['repository']))],
    );
    expect(gaps[0]).toMatchObject({ capability: 'source_code', reason: 'connector_missing' });
  });

  test('fails closed when a namespaced connector cannot identify the candidate namespace', async () => {
    const unknownNamespace = candidate('', 'production');
    unknownNamespace.scope = { cluster: 'production' };
    unknownNamespace.key = entityCandidateKey('workload', unknownNamespace.stableId, {
      cluster: 'production',
    });
    const gaps = await entityCapabilityGaps(
      [unknownNamespace],
      [connector('team-a', kubernetesEntityCoverage('team-a', 'production', 'team-a'))],
    );
    expect(gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'scope_mismatch',
          requiredScope: expect.objectContaining({ cluster: 'production' }),
          connectors: [
            expect.objectContaining({
              id: 'team-a',
              currentScope: expect.objectContaining({ namespace: 'team-a' }),
            }),
          ],
        }),
      ]),
    );
  });

  test('checks source-control coverage against the connector repository catalog', async () => {
    const repositories = {
      resolve: async (service: string) =>
        service === 'checkout'
          ? [
              {
                repositoryId: '42',
                fullName: 'acme/checkout',
                defaultBranch: 'main',
                private: true,
                archived: false,
                htmlUrl: 'https://github.com/acme/checkout',
              },
            ]
          : [],
      search: async (query: string) =>
        query === 'acme/checkout'
          ? [
              {
                repositoryId: '42',
                fullName: 'acme/checkout',
                defaultBranch: 'main',
                private: true,
                archived: false,
                htmlUrl: 'https://github.com/acme/checkout',
              },
            ]
          : [],
      recentEvents: async () => [],
    };
    const coverage = repositoryEntityCoverage(repositories);
    const service = {
      ...candidate(''),
      kind: 'service' as const,
      key: entityCandidateKey('service', 'checkout'),
      stableId: 'checkout',
      displayName: 'checkout',
      scope: {},
      requiredCapabilities: ['source_code' as const],
    };
    const repository = {
      ...service,
      kind: 'repository' as const,
      key: entityCandidateKey('repository', 'acme/checkout'),
      stableId: 'acme/checkout',
      displayName: 'acme/checkout',
    };
    expect(await coverage.assess(service)).toBe('covered');
    expect(await coverage.assess(repository)).toBe('covered');
    expect(await coverage.assess({ ...repository, stableId: 'acme/unknown' })).toBe('out_of_scope');
  });

  test('reports a repository catalog failure and captured credential outage as unavailable', async () => {
    const failingCoverage = repositoryEntityCoverage({
      resolve: async () => {
        throw new Error('catalog unavailable');
      },
      search: async () => {
        throw new Error('catalog unavailable');
      },
      recentEvents: async () => [],
    });
    const service = {
      ...candidate(''),
      kind: 'service' as const,
      key: entityCandidateKey('service', 'checkout'),
      stableId: 'checkout',
      displayName: 'checkout',
      scope: {},
      requiredCapabilities: ['source_code' as const],
    };
    expect(await failingCoverage.assess(service)).toBe('unavailable');

    const unavailable = createDataSourceConnector(
      {
        id: 'github-1',
        name: 'GitHub production',
        tenantId: 'tenant-1',
        type: 'github',
        settings: {},
        credentialStatus: 'unavailable',
        getCredential: async () => {
          throw new Error('credential unavailable');
        },
      },
      {
        type: 'github',
        capabilities: {
          alertLifecycle: 'none',
          availability: 'ready',
          configuration: 'tenant',
          instances: 'multiple',
          investigation: 'tools',
          polling: 'snapshots',
          events: 'authenticated',
        },
      },
      {
        entityCoverage: staticEntityCoverage(['source_code'], ['service']),
        probe: async () => ({
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: [],
        }),
      },
    );
    const gaps = await entityCapabilityGaps([service], [unavailable]);
    expect(gaps).toEqual([
      expect.objectContaining({
        reason: 'connector_unavailable',
        connectors: [expect.objectContaining({ id: 'github-1', status: 'unavailable' })],
      }),
    ]);

    const deployment = {
      ...service,
      key: entityCandidateKey('deployment', 'deploy-42'),
      kind: 'deployment' as const,
      stableId: 'deploy-42',
      displayName: 'deploy-42',
      requiredCapabilities: ['source_code' as const],
    };
    const unsupported = await entityCapabilityGaps([deployment], [unavailable]);
    expect(unsupported).toEqual([
      expect.objectContaining({ capability: 'source_code', reason: 'connector_missing' }),
    ]);
  });

  test('does not let an unrelated data-source instance satisfy an explicitly scoped candidate', async () => {
    const service = {
      ...candidate('production', 'production'),
      kind: 'service' as const,
      key: entityCandidateKey('service', 'checkout', { dataSourceId: 'prometheus-production' }),
      stableId: 'checkout',
      displayName: 'checkout',
      scope: { dataSourceId: 'prometheus-production' },
      requiredCapabilities: ['metrics' as const],
    };
    const gaps = await entityCapabilityGaps(
      [service],
      [
        connector(
          'prometheus-staging',
          dataSourceEntityCoverage('prometheus-staging', ['metrics'], ['service']),
        ),
      ],
    );
    expect(gaps).toEqual([
      expect.objectContaining({
        reason: 'scope_mismatch',
        connectors: [
          expect.objectContaining({
            id: 'prometheus-staging',
            currentScope: { dataSourceId: 'prometheus-staging' },
          }),
        ],
      }),
    ]);
  });
});
