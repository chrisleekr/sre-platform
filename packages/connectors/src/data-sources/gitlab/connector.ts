import { createDataSourceConnector, defineConnector, type ConnectorConfig } from '../../registry';
import { repositoryEntityCoverage } from '../../entity-coverage';
import { dnsLookup, type HostLookup } from '../../ssrf';
import type {
  IDataSourceConnector,
  NormalizedSnapshot,
  ProbeResult,
  SourceCodeReader,
  TriageContext,
  ConnectorPollEvidence,
} from '../../types';
import { obj, str } from '../../values';
import {
  connectorToken,
  gitLabAccessToken,
  gitLabWebhookSecret,
  gitLabWebhookSigningToken,
} from './auth';
import {
  DEFAULT_PER_PAGE,
  apiBase,
  getArray,
  getBootstrapArray,
  getPaginatedArray,
  projectRef,
  type FetchLike,
} from './client';
import {
  discoverGitLabGroup,
  mapCommit,
  mapDeployment,
  mapPipeline,
  type GitLabDiscovery,
} from './discovery';
import { makeGitLabSourceCodeReader } from './source-code';
import { makeGitLabTools } from './tools';
import { pollGitLabGroup } from './polling';

const GITLAB_CONNECTOR = {
  type: 'gitlab',
  capabilities: {
    availability: 'ready',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'tools',
    polling: 'snapshots',
    events: 'authenticated',
  },
} as const;

/**
 * Creates a GitLab adapter with group-wide read-only code and change intelligence.
 *
 * @remarks The adapter supports tenant-hosted origins while keeping every request SSRF-validated.
 * @param config - Tenant-scoped GitLab settings and credential accessor.
 * @param fetchImpl - HTTP transport used for GitLab API requests.
 * @param lookup - DNS resolver used by SSRF validation.
 */
export function makeGitLabConnector(
  config: ConnectorConfig,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
): IDataSourceConnector {
  const groupScoped = config.settings.groupId != null || Boolean(str(config.settings.groupPath));
  let sourceCode: Promise<SourceCodeReader> | undefined;
  let pollEvidence: ConnectorPollEvidence | undefined;
  const getSourceCode = (): Promise<SourceCodeReader> => {
    if (!sourceCode) {
      sourceCode = makeGitLabSourceCodeReader(config, fetchImpl, lookup).catch((error) => {
        sourceCode = undefined;
        throw error;
      });
    }
    return sourceCode;
  };
  const sourceReader: SourceCodeReader = {
    resolve: (...args) => getSourceCode().then((reader) => reader.resolve(...args)),
    verifyRevision: (...args) => getSourceCode().then((reader) => reader.verifyRevision(...args)),
    search: (...args) => getSourceCode().then((reader) => reader.search(...args)),
    read: (...args) => getSourceCode().then((reader) => reader.read(...args)),
    compare: (...args) => getSourceCode().then((reader) => reader.compare(...args)),
  };
  return createDataSourceConnector(config, GITLAB_CONNECTOR, {
    entityCoverage: repositoryEntityCoverage(config.repositories),
    sourceCode: sourceReader,
    pollEvidence: () => pollEvidence,
    async snapshot(): Promise<NormalizedSnapshot[]> {
      pollEvidence = undefined;
      if (groupScoped && config.settings.eventStrategy === 'system') {
        const result = await pollGitLabGroup(config, fetchImpl, lookup);
        pollEvidence = result.evidence;
        return result.snapshots;
      }
      // A group may contain hundreds of projects. Group deployments arrive through the authenticated
      // webhook instead of multiplying the worker's short poll cadence by every project.
      if (groupScoped) return [];
      const projectId = config.settings.projectId;
      const service = str(config.settings.service);
      // Nothing to poll without a resolvable project (an explicit projectId or a service path).
      if (projectId == null && !service) return [];
      const token = await connectorToken(config);
      const base = await apiBase(config.settings, lookup);
      const ref = projectRef(config.settings, service ?? '');
      const cursor = obj(config.settings.pollCursor);
      const previousUpdatedAfter = str(cursor.updatedAfter);
      const previousTime = previousUpdatedAfter ? new Date(previousUpdatedAfter).getTime() : NaN;
      const updatedAfter = Number.isFinite(previousTime)
        ? new Date(previousTime - 60_000).toISOString()
        : undefined;
      const incremental = Number.isFinite(previousTime);
      const query = new URLSearchParams({
        per_page: '100',
        order_by: 'updated_at',
        sort: incremental ? 'asc' : 'desc',
      });
      if (updatedAfter) query.set('updated_after', updatedAfter);
      const providerProjectId =
        typeof projectId === 'number' || typeof projectId === 'string'
          ? String(projectId)
          : (service ?? '');
      const deploymentsUrl = `${base}/projects/${ref}/deployments?${query.toString()}`;
      const providerDeployments = incremental
        ? await getPaginatedArray(fetchImpl, deploymentsUrl, token, base)
        : await getBootstrapArray(fetchImpl, deploymentsUrl, token, base);
      const observedAt = new Date();
      return providerDeployments
        .map((raw) => mapDeployment(raw, providerProjectId))
        .map((d) => ({
          tenantId: config.tenantId,
          source: 'gitlab' as const,
          entityId: String(d.providerId ?? ''),
          metrics: {},
          metadata: {
            ...d,
            ...(service ? { service } : {}),
          },
          observedAt,
        }));
    },
    async fetchTriageContext(query): Promise<TriageContext> {
      const token = await connectorToken(config);
      const base = await apiBase(config.settings, lookup);
      if (groupScoped) {
        const sinceDate = new Date(Date.now() - query.windowMinutes * 60_000);
        const since = sinceDate.toISOString();
        const resolved = (await config.repositories?.resolve(query.service)) ?? [];
        const projects = [...new Set(resolved.map((entry) => entry.fullName))].slice(0, 5);
        if (projects.length === 0) {
          return {
            source: 'gitlab',
            data: {
              service: query.service,
              windowMinutes: query.windowMinutes,
              note: 'no project relationship resolved for this service',
            },
          };
        }
        const events =
          (await config.repositories?.recentEvents(
            projects,
            sinceDate,
            DEFAULT_PER_PAGE * projects.length,
          )) ?? [];
        const evidence = await Promise.all(
          projects.map(async (fullPath) => {
            const ref = encodeURIComponent(fullPath);
            const [commitsResult, pipelinesResult] = await Promise.allSettled([
              getArray(
                fetchImpl,
                `${base}/projects/${ref}/repository/commits?since=${encodeURIComponent(since)}&per_page=20`,
                token,
              ),
              getArray(
                fetchImpl,
                `${base}/projects/${ref}/pipelines?updated_after=${encodeURIComponent(since)}&per_page=20&order_by=updated_at&sort=desc`,
                token,
              ),
            ]);
            return {
              project: fullPath,
              mapping: resolved.find((entry) => entry.fullName === fullPath),
              commits:
                commitsResult.status === 'fulfilled' ? commitsResult.value.map(mapCommit) : [],
              pipelines:
                pipelinesResult.status === 'fulfilled'
                  ? pipelinesResult.value.map(mapPipeline)
                  : [],
              warnings: [
                ...(commitsResult.status === 'rejected' ? ['commit history unavailable'] : []),
                ...(pipelinesResult.status === 'rejected' ? ['pipeline history unavailable'] : []),
              ],
            };
          }),
        );
        return {
          source: 'gitlab',
          data: {
            service: query.service,
            windowMinutes: query.windowMinutes,
            projects: evidence,
            synchronizedEvents: events,
          },
        };
      }
      const ref = projectRef(config.settings, query.service);
      const since = encodeURIComponent(
        new Date(Date.now() - query.windowMinutes * 60_000).toISOString(),
      );
      const [commits, pipelines] = await Promise.all([
        getArray(
          fetchImpl,
          `${base}/projects/${ref}/repository/commits?since=${since}&per_page=20`,
          token,
        ),
        getArray(
          fetchImpl,
          `${base}/projects/${ref}/pipelines?updated_after=${since}&per_page=20&order_by=updated_at&sort=desc`,
          token,
        ),
      ]);
      return {
        source: 'gitlab',
        data: {
          service: query.service,
          windowMinutes: query.windowMinutes,
          commits: commits.map(mapCommit),
          pipelines: pipelines.map(mapPipeline),
        },
      };
    },
    tools: () => makeGitLabTools(config, fetchImpl, lookup),
    async probe(): Promise<ProbeResult> {
      const warnings: string[] = [];
      let base: string;
      try {
        base = await apiBase(config.settings, lookup);
      } catch (e) {
        warnings.push(e instanceof Error ? e.message : 'gitlab connector: configuration error');
        return { status: 'unhealthy', reachable: false, authorized: false, warnings };
      }
      let credential: string;
      let token: string;
      try {
        credential = await config.getCredential();
        const parsed = gitLabAccessToken(credential);
        if (!parsed) throw new Error('missing token');
        token = parsed;
      } catch {
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: ['gitlab connector: no access token configured'],
          failureCategory: 'permission_denied',
        };
      }
      const stat = async (path: string): Promise<number | null> => {
        try {
          const res = await fetchImpl(`${base}${path}`, {
            headers: { 'PRIVATE-TOKEN': token },
            signal: AbortSignal.timeout(8000),
            redirect: 'error',
          });
          return res.status;
        } catch {
          return null;
        }
      };
      const userStatus = await stat('/user');
      if (userStatus === null) {
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: [...warnings, 'gitlab api did not respond'],
          failureCategory: 'unreachable',
        };
      }
      const authorized = userStatus === 200;
      const categoryForStatus = (responseStatus: number | null): ProbeResult['failureCategory'] => {
        if (responseStatus === null) return 'unreachable';
        if (responseStatus === 401 || responseStatus === 403) return 'permission_denied';
        if (responseStatus === 429) return 'rate_limited';
        return 'provider_unavailable';
      };
      if (!authorized) {
        if (userStatus === 401 || userStatus === 403)
          warnings.push('gitlab reachable but the token is unauthorized');
        else warnings.push('gitlab identity verification failed');
        return {
          status: 'unhealthy',
          reachable: true,
          authorized: false,
          warnings,
          failureCategory: categoryForStatus(userStatus),
        };
      }
      if (groupScoped) {
        const checks: Record<string, boolean> = {};
        let failureCategory: ProbeResult['failureCategory'];
        let discovery: GitLabDiscovery | null = null;
        try {
          discovery = await discoverGitLabGroup(config.settings, token, fetchImpl, lookup);
          checks.canReadGroup = true;
          checks.canEnumerateProjects = true;
          checks.hasProjects = discovery.projects.length > 0;
          if (!checks.hasProjects) warnings.push('the configured group has no readable projects');
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          checks.canReadGroup = false;
          checks.canEnumerateProjects = false;
          failureCategory = /gitlab api (401|403|404)/.test(message)
            ? 'permission_denied'
            : /gitlab api 429/.test(message)
              ? 'rate_limited'
              : 'provider_unavailable';
          warnings.push('token cannot enumerate the configured group and its subgroup projects');
        }
        const sample = discovery?.projects[0];
        if (sample) {
          const ref = encodeURIComponent(sample.pathWithNamespace);
          const [projectStatus, commitsStatus, pipelinesStatus, deploymentsStatus] =
            await Promise.all([
              stat(`/projects/${ref}`),
              stat(`/projects/${ref}/repository/commits?per_page=1`),
              stat(`/projects/${ref}/pipelines?per_page=1`),
              stat(`/projects/${ref}/deployments?per_page=1`),
            ]);
          checks.canReadProject = projectStatus === 200;
          checks.canReadCode = commitsStatus === 200;
          checks.canReadPipelines = pipelinesStatus === 200;
          checks.canReadDeployments = deploymentsStatus === 200;
          if (
            !checks.canReadProject ||
            !checks.canReadCode ||
            !checks.canReadPipelines ||
            !checks.canReadDeployments
          ) {
            const failed = [projectStatus, commitsStatus, pipelinesStatus, deploymentsStatus].find(
              (status) => status !== 200,
            );
            failureCategory = categoryForStatus(failed ?? null);
            warnings.push(
              'the token must be Reporter with read_api access to code, pipelines, and deployments',
            );
          }
        }
        const eventTransport = str(config.settings.eventTransport) ?? 'none';
        checks.webhookSecretConfigured = gitLabWebhookSecret(credential) !== null;
        checks.webhookSigningTokenConfigured = gitLabWebhookSigningToken(credential) !== null;
        const healthy =
          checks.canReadGroup === true &&
          checks.canEnumerateProjects === true &&
          checks.hasProjects === true &&
          checks.canReadProject === true &&
          checks.canReadCode === true &&
          checks.canReadPipelines === true &&
          checks.canReadDeployments === true;
        if (
          eventTransport !== 'none' &&
          !checks.webhookSecretConfigured &&
          !checks.webhookSigningTokenConfigured
        )
          warnings.push(
            'event sync is selected but no GitLab webhook authentication is configured',
          );
        return {
          status: healthy ? 'healthy' : 'unhealthy',
          reachable: failureCategory !== 'unreachable',
          authorized,
          warnings,
          checks,
          details: {
            group: discovery?.group.fullPath,
            projectCount: discovery?.projects.length ?? 0,
            eventSync: eventTransport,
          },
          ...(!healthy ? { failureCategory: failureCategory ?? 'permission_denied' } : {}),
        };
      }
      const checks: Record<string, boolean> = {};
      let failureCategory: ProbeResult['failureCategory'];
      const service = str(config.settings.service) ?? '';
      const projectConfigured = config.settings.projectId != null || service.length > 0;
      if (!projectConfigured) warnings.push('a GitLab project is required');
      if (authorized && projectConfigured) {
        const projStatus = await stat(`/projects/${projectRef(config.settings, service)}`);
        if (projStatus === 200) {
          checks.canReadProject = true;
          const deploymentsStatus = await stat(
            `/projects/${projectRef(config.settings, service)}/deployments?per_page=1`,
          );
          if (deploymentsStatus === 200) checks.canReadDeployments = true;
          else if (
            deploymentsStatus === 401 ||
            deploymentsStatus === 403 ||
            deploymentsStatus === 404
          ) {
            checks.canReadDeployments = false;
            warnings.push('token cannot read deployments for the configured project');
          } else {
            failureCategory = categoryForStatus(deploymentsStatus);
            warnings.push('could not verify deployment access (transient error)');
          }
        } else if (projStatus === 401 || projStatus === 403 || projStatus === 404) {
          checks.canReadProject = false;
          warnings.push('token cannot read the configured project');
        } else {
          failureCategory = categoryForStatus(projStatus);
          warnings.push('could not verify project access (transient error)');
        }
      }
      const status =
        authorized && checks.canReadProject === true && checks.canReadDeployments === true
          ? 'healthy'
          : 'unhealthy';
      if (!failureCategory && checks.canReadProject === false)
        failureCategory = 'permission_denied';
      if (!failureCategory && checks.canReadDeployments === false)
        failureCategory = 'permission_denied';
      return {
        status,
        reachable: failureCategory !== 'unreachable',
        authorized,
        warnings,
        checks,
        ...(failureCategory ? { failureCategory } : {}),
      };
    },
  });
}

export const gitlabConnectorDefinition = defineConnector({
  ...GITLAB_CONNECTOR,
  create: makeGitLabConnector,
});
