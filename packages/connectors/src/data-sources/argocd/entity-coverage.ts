import type { AffectedEntityCandidate } from '@sre/contracts';
import type { EntityCoverageReader } from '../../types';

export interface ArgoCdEntityScope {
  project: string;
  name: string;
  namespace?: string;
}

/**
 * Reports evidence coverage only when the saved Argo CD application boundary proves access.
 *
 * @param dataSourceId - Immutable connector identity.
 * @param resolveScopes - Validates and returns configured application scopes.
 */
export function argoCdEntityCoverage(
  dataSourceId: string,
  resolveScopes: () => ArgoCdEntityScope[],
): EntityCoverageReader {
  let applications: ArgoCdEntityScope[] | null;
  try {
    applications = resolveScopes();
  } catch {
    applications = null;
  }
  const supported = new Set<AffectedEntityCandidate['kind']>([
    'service',
    'workload',
    'deployment',
    'repository',
  ]);
  const visibleScopes = applications
    ? applications
        .slice(0, 10)
        .map((application) => `${application.project}/${application.name}`)
        .join(', ')
    : 'configuration invalid';
  return {
    capabilities: ['deployments', 'topology'],
    entityKinds: ['service', 'workload', 'deployment', 'repository'],
    scope: {
      dataSourceId,
      applications: applications
        ? `${applications.length}: ${visibleScopes}${applications.length > 10 ? ', …' : ''}`
        : visibleScopes,
    },
    assess(candidate) {
      if (!supported.has(candidate.kind)) return 'unsupported';
      if (!applications) return 'unavailable';
      if (candidate.scope.dataSourceId === dataSourceId) return 'covered';
      const applicationName =
        candidate.scope.application ?? (candidate.kind === 'service' ? candidate.stableId : null);
      if (!applicationName) return 'out_of_scope';
      const project = candidate.scope.project;
      const applicationNamespace = candidate.scope.applicationNamespace;
      return applications.some(
        (application) =>
          (application.name === '*' || application.name === applicationName) &&
          (!project || application.project === '*' || application.project === project) &&
          (!applicationNamespace ||
            application.namespace === '*' ||
            application.namespace === applicationNamespace),
      )
        ? 'covered'
        : 'out_of_scope';
    },
  };
}
