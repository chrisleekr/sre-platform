import type { AffectedEntityCandidate, EntityCapability, EntityKind } from '@sre/contracts';
import type { EntityCoverageReader } from './types';
import type { ConnectorConfig } from './registry';

/**
 * Builds coverage for a connector whose saved configuration does not narrow entity scope.
 *
 * @param capabilities - Evidence capabilities supplied by the connector.
 * @param entityKinds - Entity kinds accepted by the connector.
 */
export function staticEntityCoverage(
  capabilities: readonly EntityCapability[],
  entityKinds: readonly EntityKind[],
): EntityCoverageReader {
  const supported = new Set<EntityKind>(entityKinds);
  return {
    capabilities,
    entityKinds,
    assess(candidate: AffectedEntityCandidate) {
      return supported.has(candidate.kind) ? 'covered' : 'unsupported';
    },
  };
}

/**
 * Builds coverage for one connector instance and rejects explicit incompatible entity scope.
 *
 * @param dataSourceId - Immutable connector identity.
 * @param capabilities - Evidence capabilities supplied by the connector.
 * @param entityKinds - Entity kinds accepted by the connector.
 * @param savedScope - Optional provider scope that can prove cross-source coverage.
 */
export function dataSourceEntityCoverage(
  dataSourceId: string,
  capabilities: readonly EntityCapability[],
  entityKinds: readonly EntityKind[],
  savedScope: Readonly<Record<string, string>> = {},
): EntityCoverageReader {
  const supported = new Set<EntityKind>(entityKinds);
  const scope = { dataSourceId, ...savedScope };
  return {
    capabilities,
    entityKinds,
    scope,
    assess(candidate) {
      if (!supported.has(candidate.kind)) return 'unsupported';
      if (candidate.scope.dataSourceId === dataSourceId) return 'covered';
      const requestedScope = Object.fromEntries(
        Object.entries(candidate.scope).filter(([key]) => key !== 'dataSourceId'),
      );
      if (Object.keys(requestedScope).length === 0)
        return candidate.scope.dataSourceId ? 'out_of_scope' : 'covered';
      return Object.entries(requestedScope).every(([key, value]) => savedScope[key] === value)
        ? 'covered'
        : 'out_of_scope';
    },
  };
}

/**
 * Builds Kubernetes coverage while retaining the instance's configured namespace boundary.
 *
 * @param namespace - Saved namespace, or null for cluster-wide access.
 * @param clusterName - Saved cluster identity, or null when a legacy config has none.
 * @param dataSourceId - Immutable connector identity used by platform-originated candidates.
 */
export function kubernetesEntityCoverage(
  namespace: string | null,
  clusterName: string | null,
  dataSourceId: string,
): EntityCoverageReader {
  const entityKinds = ['service', 'workload', 'namespace', 'node', 'cluster', 'host'] as const;
  const capabilities = ['runtime', 'metrics', 'logs'] as const;
  const supported = new Set<EntityKind>(entityKinds);
  return {
    capabilities,
    entityKinds,
    scope: {
      dataSourceId,
      ...(clusterName ? { cluster: clusterName } : {}),
      ...(namespace ? { namespace } : {}),
    },
    assess(candidate) {
      if (!supported.has(candidate.kind)) return 'unsupported';
      const candidateCluster =
        candidate.kind === 'cluster' ? candidate.stableId : candidate.scope.cluster;
      const sameDataSource = candidate.scope.dataSourceId === dataSourceId;
      if (!sameDataSource) {
        if (!candidateCluster || !clusterName || candidateCluster !== clusterName)
          return 'out_of_scope';
      } else if (candidateCluster && clusterName && candidateCluster !== clusterName) {
        return 'out_of_scope';
      }
      if (!namespace || candidate.kind === 'node' || candidate.kind === 'cluster') return 'covered';
      const candidateNamespace =
        candidate.kind === 'namespace' ? candidate.stableId : candidate.scope.namespace;
      return candidateNamespace === namespace ? 'covered' : 'out_of_scope';
    },
  };
}

/**
 * Builds source-control coverage from the repositories catalogued for one connector instance.
 *
 * @param repositories - Tenant and connector-scoped repository catalog operations.
 */
export function repositoryEntityCoverage(
  repositories: ConnectorConfig['repositories'],
): EntityCoverageReader {
  const capabilities = ['source_code', 'deployments'] as const;
  const entityKinds = ['service', 'repository'] as const;
  return {
    capabilities,
    entityKinds,
    scope: { catalog: 'registered repositories' },
    async assess(candidate) {
      if (candidate.kind !== 'service' && candidate.kind !== 'repository') return 'unsupported';
      if (!repositories) return 'unavailable';
      try {
        if (candidate.kind === 'service') {
          return (await repositories.resolve(candidate.stableId)).length > 0
            ? 'covered'
            : 'out_of_scope';
        }
        const matches = await repositories.search(candidate.stableId, 20);
        return matches.some((entry) => entry.fullName === candidate.stableId)
          ? 'covered'
          : 'out_of_scope';
      } catch {
        return 'unavailable';
      }
    },
  };
}
