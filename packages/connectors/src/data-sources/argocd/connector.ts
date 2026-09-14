import { createDataSourceConnector, defineConnector, type ConnectorConfig } from '../../registry';
import { dnsLookup, type HostLookup } from '../../ssrf';
import type { IDataSourceConnector, ProbeResult } from '../../types';
import { ArgoApiError, type FetchLike } from './client';
import { ARGOCD_CONNECTOR_METADATA } from './definition';
import { argoCdEntityCoverage } from './entity-coverage';
import {
  configuredProjects,
  loadProjectConnectors,
  makeMultiProjectTools,
  type ProjectConnector,
} from './projects';
import { makeSingleArgoCdConnector } from './single-connector';
import { shouldReadTopologyCollection } from '../../topology-scan';

/**
 * Creates an Argo CD adapter for project-scoped read-only investigation.
 *
 * @param config - Tenant-scoped Argo CD settings and credential accessor.
 * @param fetchImpl - HTTP transport used for Argo CD API requests.
 * @param lookup - DNS resolver used by SSRF validation.
 */
export function makeArgoCdConnector(
  config: ConnectorConfig,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
): IDataSourceConnector {
  if (!Array.isArray(config.settings.projects))
    return makeSingleArgoCdConnector(config, fetchImpl, lookup);

  let lastPollEvidence: ReturnType<NonNullable<IDataSourceConnector['pollEvidence']>>;
  return createDataSourceConnector(config, ARGOCD_CONNECTOR_METADATA, {
    topology: {
      async discover(options) {
        const observedAt = new Date().toISOString();
        const children = await loadProjectConnectors(config, fetchImpl, lookup);
        const collections = await Promise.all(
          children.map(async (child) => {
            const key = `${child.project}/applications`;
            if (!shouldReadTopologyCollection(options, key)) return [];
            try {
              const scan = options?.scans?.[key];
              const result = await child.connector.topology!.discover({
                collections: ['applications'],
                ...(scan ? { scans: { applications: scan } } : {}),
              });
              return result.collections.map((collection) => ({
                ...collection,
                key: `${child.project}/${collection.key}`,
              }));
            } catch {
              return [
                {
                  key: `${child.project}/applications`,
                  completeness: 'unavailable' as const,
                  issue: 'unreachable' as const,
                  entities: [],
                  relations: [],
                },
              ];
            }
          }),
        );
        return { observedAt, collections: collections.flat() };
      },
    },
    entityCoverage: argoCdEntityCoverage(config.id, () =>
      configuredProjects(config.settings).flatMap((binding) =>
        binding.applications.map((application) => ({
          project: binding.project,
          ...application,
        })),
      ),
    ),
    async snapshot() {
      const startedAt = Date.now();
      const children = await loadProjectConnectors(config, fetchImpl, lookup);
      const results = await Promise.allSettled(
        children.map(async (child) => ({
          project: child.project,
          snapshots: await child.connector.snapshot(),
        })),
      );
      const statuses = results.map((result, index) => {
        const project = children[index]!.project;
        return result.status === 'fulfilled'
          ? { project, status: 'healthy' }
          : {
              project,
              status: 'unhealthy',
              failureCategory:
                result.reason instanceof ArgoApiError
                  ? result.reason.failureCategory
                  : 'provider_unavailable',
            };
      });
      const failures = results.filter((result) => result.status === 'rejected');
      lastPollEvidence = {
        durationMs: Date.now() - startedAt,
        errorCount: failures.length,
        cursor: { projects: statuses, observedAt: new Date().toISOString() },
        ...(failures.length > 0 ? { failureCategory: 'partial_project_failure' } : {}),
      };
      if (failures.length === results.length) throw failures[0]!.reason;
      const snapshots = results.flatMap((result) =>
        result.status === 'fulfilled' ? result.value.snapshots : [],
      );
      const observedAt = new Date();
      for (const status of statuses) {
        if (status.status === 'healthy') continue;
        snapshots.push({
          tenantId: config.tenantId,
          source: 'argocd',
          entityId: `project-error:${status.project}`,
          metrics: {},
          metadata: {
            kind: 'connector_error',
            project: status.project,
            failureCategory: status.failureCategory,
          },
          observedAt,
        });
      }
      return snapshots;
    },
    pollEvidence: () => lastPollEvidence,
    async fetchTriageContext(query) {
      try {
        const children = await loadProjectConnectors(config, fetchImpl, lookup);
        const contexts = await Promise.all(
          children.map(async (child) => ({
            project: child.project,
            data: (await child.connector.fetchTriageContext(query)).data,
          })),
        );
        return {
          source: 'argocd',
          data: { service: query.service, windowMinutes: query.windowMinutes, projects: contexts },
        };
      } catch {
        return {
          source: 'argocd',
          data: {
            service: query.service,
            windowMinutes: query.windowMinutes,
            note: 'argocd project credentials are unavailable',
          },
        };
      }
    },
    tools: () => makeMultiProjectTools(config, fetchImpl, lookup),
    async probe(): Promise<ProbeResult> {
      const startedAt = Date.now();
      let children: ProjectConnector[];
      try {
        children = await loadProjectConnectors(config, fetchImpl, lookup);
      } catch (error) {
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: ['ArgoCD project configuration or credentials are invalid'],
          failureCategory:
            error instanceof ArgoApiError && error.failureCategory !== 'backlog'
              ? error.failureCategory
              : 'provider_unavailable',
          durationMs: Date.now() - startedAt,
        };
      }
      const results = await Promise.all(
        children.map(async (child) => ({
          project: child.project,
          ...(await child.connector.probe()),
        })),
      );
      const unhealthy = results.filter((result) => result.status !== 'healthy');
      return {
        status: unhealthy.length === 0 ? 'healthy' : 'unhealthy',
        reachable: results.every((result) => result.reachable),
        authorized: results.every((result) => result.authorized),
        warnings: results.flatMap((result) =>
          result.warnings.map((warning) => `${result.project}: ${warning}`),
        ),
        checks: {
          allProjectIdentitiesMatch: results.every(
            (result) => result.checks?.identityMatches === true,
          ),
          allProjectReadsVerified: results.every(
            (result) => result.checks?.requiredReadsVerified === true,
          ),
          allProjectDenySamplesPassed: results.every(
            (result) => result.checks?.denySamplesPassed === true,
          ),
          allProjectsReadable: results.every(
            (result) => result.checks?.canListApplications === true,
          ),
          allProjectsHaveApplications: results.every(
            (result) => result.checks?.hasScopedApplications === true,
          ),
        },
        details: {
          projects: results.map((result) => ({
            project: result.project,
            status: result.status,
            reachable: result.reachable,
            authorized: result.authorized,
            warnings: result.warnings,
            checks: result.checks,
            failureCategory: result.failureCategory,
            durationMs: result.durationMs,
          })),
        },
        ...(unhealthy[0]?.failureCategory ? { failureCategory: unhealthy[0].failureCategory } : {}),
        durationMs: Date.now() - startedAt,
      };
    },
  });
}

export const argoCdConnectorDefinition = defineConnector({
  ...ARGOCD_CONNECTOR_METADATA,
  create: makeArgoCdConnector,
});
