import { createDataSourceConnector, defineConnector, type ConnectorConfig } from '../../registry';
import { repositoryEntityCoverage } from '../../entity-coverage';
import { repositoryTopology } from '../../repository-topology';
import { sourceTopologyFetch } from '../../topology-transport';
import { dnsLookup, type HostLookup } from '../../ssrf';
import type {
  ConnectorPollEvidence,
  IDataSourceConnector,
  NormalizedSnapshot,
  ProbeResult,
  TriageContext,
} from '../../types';
import { obj, str } from '../../values';
import {
  githubWebhookSecret,
  makeInstallationTokenProvider,
  probeMint,
  type GitHubRateLimitEvidence,
} from './auth';
import {
  GITHUB_API,
  GitHubApiError,
  MAX_ACTIVE_DEPLOYMENTS,
  MAX_DEPLOYMENTS_PER_POLL,
  TRIAGE_PER_PAGE,
  boundedCollection,
  boundedPage,
  ghHeaders,
  parseRepo,
  resolveRepo,
  type FetchLike,
} from './client';
import { ghGet, makeGitHubSourceCodeReader } from './source-code';
import { makeGitHubTools, mapCommit, mapRun } from './tools';
import { makeGitHubIssues } from './issues';
import { issueManagement } from '../../issues';
import { issueReadTools } from '../../issue-read-tools';

const GITHUB_CONNECTOR = {
  type: 'github',
  capabilities: {
    topology: 'inventory',
    availability: 'ready',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'tools',
    polling: 'snapshots',
    events: 'authenticated',
  },
} as const;

/**
 * Creates a GitHub App adapter with installation-wide read-only code and change intelligence.
 *
 * @remarks Installation tokens are minted lazily and requests stay pinned to GitHub's API origin.
 * @param config - Tenant-scoped GitHub App settings and credential accessor.
 * @param fetchImpl - HTTP transport used for GitHub API requests.
 * @param lookup - DNS resolver used by SSRF validation.
 */
export function makeGitHubConnector(
  config: ConnectorConfig,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
): IDataSourceConnector {
  const auth = makeInstallationTokenProvider(config, fetchImpl, GITHUB_API);
  let lastPollEvidence: ConnectorPollEvidence | undefined;
  return createDataSourceConnector(config, GITHUB_CONNECTOR, {
    issues: makeGitHubIssues(config, fetchImpl),
    entityCoverage: repositoryEntityCoverage(config.repositories),
    sourceCode: makeGitHubSourceCodeReader(config, fetchImpl, auth),
    topology: repositoryTopology(config, () => {
      const bounded = sourceTopologyFetch(
        fetchImpl,
        (response) =>
          response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0',
      );
      return makeGitHubSourceCodeReader(
        config,
        bounded,
        makeInstallationTokenProvider(config, bounded, GITHUB_API),
      );
    }),
    async snapshot(): Promise<NormalizedSnapshot[]> {
      const startedAt = Date.now();
      let rateLimit: GitHubRateLimitEvidence = {};
      let attemptFailure: ConnectorPollEvidence | undefined;
      lastPollEvidence = undefined;
      try {
        if (!str(config.settings.repo)) {
          lastPollEvidence = { durationMs: Date.now() - startedAt, errorCount: 0 };
          return [];
        }
        const { owner, repo } = resolveRepo(undefined, config.settings);
        const repository = `${owner}/${repo}`;
        const token = await auth.token([repository]);
        rateLimit = { ...rateLimit, ...auth.evidence() };
        const cursor = obj(config.settings.pollCursor);
        const previousHead = str(cursor.recentHeadProviderId);
        const activeIds = Array.isArray(cursor.activeProviderIds)
          ? cursor.activeProviderIds.filter((value): value is string => typeof value === 'string')
          : [];
        if (activeIds.length > MAX_ACTIVE_DEPLOYMENTS) {
          attemptFailure = {
            cursor: config.settings.pollCursor as Record<string, unknown>,
            durationMs: Date.now() - startedAt,
            rateLimitRemaining: rateLimit.remaining,
            rateLimitResetAt: rateLimit.resetAt,
            failureCategory: 'backlog',
          };
          throw new Error('github active deployment backlog exceeds cursor bound');
        }
        const listed = await boundedCollection(
          fetchImpl,
          `${GITHUB_API}/repos/${owner}/${repo}/deployments?per_page=100`,
          ghHeaders(token),
          (body) => (Array.isArray(body) ? body : []),
          MAX_DEPLOYMENTS_PER_POLL,
        );
        rateLimit = { ...rateLimit, ...listed.rateLimit };
        const deployments = [...listed.values];
        const listedIds = new Set(
          deployments.map((raw) => String(obj(raw).id ?? '')).filter((id) => id.length > 0),
        );
        if (listed.truncated && previousHead && !listedIds.has(previousHead)) {
          attemptFailure = {
            cursor: config.settings.pollCursor as Record<string, unknown> | undefined,
            durationMs: Date.now() - startedAt,
            rateLimitRemaining: rateLimit.remaining,
            rateLimitResetAt: rateLimit.resetAt,
            failureCategory: 'backlog',
          };
          throw new Error('github deployment backlog exceeds poll bound');
        }
        const baselineTruncated =
          cursor.baselineTruncated === true || (!previousHead && listed.truncated);
        for (const id of activeIds) {
          if (listedIds.has(id)) continue;
          const detail = await boundedPage(
            fetchImpl,
            `${GITHUB_API}/repos/${owner}/${repo}/deployments/${encodeURIComponent(id)}`,
            ghHeaders(token),
          );
          rateLimit = { ...rateLimit, ...detail.rateLimit };
          deployments.push(detail.body);
          listedIds.add(id);
        }
        const snapshots: NormalizedSnapshot[] = [];
        const nextActive: string[] = [];
        const observedAt = new Date();
        for (const raw of deployments) {
          const deployment = obj(raw);
          const providerId = String(deployment.id ?? '');
          if (!providerId) continue;
          const statusPage = await boundedPage(
            fetchImpl,
            `${GITHUB_API}/repos/${owner}/${repo}/deployments/${encodeURIComponent(providerId)}/statuses?per_page=1`,
            ghHeaders(token),
          );
          rateLimit = { ...rateLimit, ...statusPage.rateLimit };
          const statusRaw = Array.isArray(statusPage.body) ? statusPage.body[0] : undefined;
          const status = obj(statusRaw);
          const state = str(status.state) ?? 'pending';
          if (['pending', 'queued', 'in_progress'].includes(state)) nextActive.push(providerId);
          const deploymentCreator = obj(deployment.creator);
          const statusCreator = obj(status.creator);
          const createdAt = str(deployment.created_at);
          const updatedAt = str(status.updated_at) ?? str(deployment.updated_at) ?? createdAt;
          snapshots.push({
            tenantId: config.tenantId,
            source: 'github',
            entityId: providerId,
            metrics: {},
            metadata: {
              providerId,
              repo: `${owner}/${repo}`,
              ref: str(deployment.ref),
              environment: str(deployment.environment),
              transientEnvironment: deployment.transient_environment === true,
              actor: str(statusCreator.login) ?? str(deploymentCreator.login),
              sha: str(deployment.sha),
              service: str(config.settings.service),
              status: state,
              url: str(status.log_url) ?? str(status.environment_url),
              deployedAt: updatedAt,
              providerCreatedAt: createdAt,
              providerUpdatedAt: updatedAt,
            },
            observedAt,
          });
        }
        const uniqueActive = [...new Set(nextActive)];
        if (uniqueActive.length > MAX_ACTIVE_DEPLOYMENTS) {
          attemptFailure = {
            cursor: config.settings.pollCursor as Record<string, unknown> | undefined,
            durationMs: Date.now() - startedAt,
            rateLimitRemaining: rateLimit.remaining,
            rateLimitResetAt: rateLimit.resetAt,
            failureCategory: 'backlog',
          };
          throw new Error('github active deployment backlog exceeds cursor bound');
        }
        const recentHeadProviderId = String(obj(deployments[0]).id ?? previousHead ?? '');
        lastPollEvidence = {
          cursor: {
            ...(recentHeadProviderId ? { recentHeadProviderId } : {}),
            activeProviderIds: uniqueActive,
            ...(baselineTruncated ? { baselineTruncated: true } : {}),
          },
          durationMs: Date.now() - startedAt,
          rateLimitRemaining: rateLimit.remaining,
          rateLimitResetAt: rateLimit.resetAt,
        };
        return snapshots;
      } catch (error) {
        const apiError = error instanceof GitHubApiError ? error : null;
        const currentRate = apiError ? { ...rateLimit, ...apiError.rateLimit } : rateLimit;
        lastPollEvidence =
          attemptFailure ??
          ({
            cursor: config.settings.pollCursor as Record<string, unknown> | undefined,
            durationMs: Date.now() - startedAt,
            rateLimitRemaining: currentRate.remaining,
            rateLimitResetAt: currentRate.resetAt,
            failureCategory: apiError?.failureCategory ?? 'provider',
          } satisfies ConnectorPollEvidence);
        throw error;
      }
    },
    pollEvidence: () => lastPollEvidence,
    async fetchTriageContext(query): Promise<TriageContext> {
      const since = new Date(Date.now() - query.windowMinutes * 60_000).toISOString();
      const resolved = (await config.repositories?.resolve(query.service)) ?? [];
      const legacyRepo = str(config.settings.repo);
      const repositories = [
        ...new Set([
          ...resolved.map((entry) => entry.fullName),
          ...(resolved.length === 0 && legacyRepo ? [legacyRepo] : []),
        ]),
      ].slice(0, 5);
      if (repositories.length === 0) {
        return {
          source: 'github',
          data: {
            service: query.service,
            windowMinutes: query.windowMinutes,
            note: 'no repository relationship resolved for this service',
          },
        };
      }
      const events =
        (await config.repositories?.recentEvents(
          repositories,
          new Date(since),
          TRIAGE_PER_PAGE * repositories.length,
        )) ?? [];
      const evidence = await Promise.all(
        repositories.map(async (fullName) => {
          let parsed: { owner: string; repo: string };
          try {
            parsed = parseRepo(fullName);
          } catch {
            return { repo: fullName, error: 'invalid repository mapping' };
          }
          const token = await auth.token([fullName]);
          const [commitsResult, runsResult] = await Promise.allSettled([
            ghGet(fetchImpl, token, `repos/${parsed.owner}/${parsed.repo}/commits`, {
              since,
              per_page: TRIAGE_PER_PAGE,
            }),
            ghGet(fetchImpl, token, `repos/${parsed.owner}/${parsed.repo}/actions/runs`, {
              per_page: TRIAGE_PER_PAGE,
            }),
          ]);
          const commits =
            commitsResult.status === 'fulfilled' && Array.isArray(commitsResult.value)
              ? commitsResult.value.map(mapCommit)
              : [];
          const rawRuns =
            runsResult.status === 'fulfilled' ? obj(runsResult.value).workflow_runs : undefined;
          const workflowRuns = Array.isArray(rawRuns) ? rawRuns.map(mapRun) : [];
          return {
            repo: fullName,
            mapping: resolved.find((entry) => entry.fullName === fullName),
            commits,
            workflowRuns,
            warnings: [
              ...(commitsResult.status === 'rejected' ? ['commit history unavailable'] : []),
              ...(runsResult.status === 'rejected' ? ['Actions history unavailable'] : []),
            ],
          };
        }),
      );
      return {
        source: 'github',
        data: {
          service: query.service,
          windowMinutes: query.windowMinutes,
          repositories: evidence,
          synchronizedEvents: events,
        },
      };
    },
    tools: () => [
      ...makeGitHubTools(config, fetchImpl, auth, lookup),
      ...issueReadTools(makeGitHubIssues(config, fetchImpl)),
    ],
    async probe(): Promise<ProbeResult> {
      const startedAt = Date.now();
      const warnings: string[] = [];
      let credential: string;
      try {
        credential = await config.getCredential();
      } catch {
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: ['github connector: no credential configured'],
          failureCategory: 'permission_denied',
          durationMs: Date.now() - startedAt,
        };
      }
      let minted: Awaited<ReturnType<typeof probeMint>>;
      try {
        minted = await probeMint(fetchImpl, GITHUB_API, credential, Date.now(), config.settings);
      } catch (e) {
        // Malformed creds/PEM: a configuration error, conclusively unhealthy.
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: [e instanceof Error ? e.message : 'github connector: configuration error'],
          failureCategory: 'permission_denied',
          durationMs: Date.now() - startedAt,
        };
      }
      if ('status' in minted) {
        const s = minted.status;
        if (s === null) {
          return {
            status: 'unhealthy',
            reachable: false,
            authorized: false,
            warnings: [...warnings, 'github api did not respond'],
            failureCategory: 'unreachable',
            durationMs: Date.now() - startedAt,
          };
        }
        // 401 (bad JWT/key) and 404 (installation not found / app not installed) are conclusive.
        return {
          status: 'unhealthy',
          reachable: true,
          authorized: false,
          warnings: [...warnings, `github reachable but the app could not authenticate (${s})`],
          failureCategory:
            s === 429 ? 'rate_limited' : s >= 500 ? 'provider_unavailable' : 'permission_denied',
          durationMs: Date.now() - startedAt,
        };
      }
      let rateLimit = 'rateLimit' in minted ? minted.rateLimit : {};
      const checks: Record<string, boolean> = {};
      checks.webhookSecretConfigured = githubWebhookSecret(credential) !== null;
      let repositoryCount = 0;
      try {
        const repositoryPage = await boundedCollection(
          fetchImpl,
          `${GITHUB_API}/installation/repositories?per_page=100`,
          ghHeaders(minted.token),
          (body) => {
            const repositories = obj(body).repositories;
            return Array.isArray(repositories) ? repositories : [];
          },
        );
        rateLimit = { ...rateLimit, ...repositoryPage.rateLimit };
        checks.canEnumerateRepositories = !repositoryPage.truncated;
        checks.canReadRepository = checks.canEnumerateRepositories;
        checks.canRead = checks.canEnumerateRepositories;
        repositoryCount = repositoryPage.values.length;
        checks.hasRepositories = repositoryCount > 0;
      } catch (error) {
        const apiError = error instanceof GitHubApiError ? error : null;
        rateLimit = { ...rateLimit, ...apiError?.rateLimit };
        checks.canEnumerateRepositories = false;
        checks.canReadRepository = false;
        checks.canRead = false;
        const failureCategory = apiError?.failureCategory ?? 'provider_unavailable';
        return {
          status: 'unhealthy',
          reachable: failureCategory !== 'unreachable',
          authorized: true,
          warnings: ['token cannot enumerate repositories granted to this installation'],
          checks,
          failureCategory:
            failureCategory === 'provider' ? 'provider_unavailable' : failureCategory,
          durationMs: Date.now() - startedAt,
          rateLimitRemaining: rateLimit.remaining,
          rateLimitResetAt: rateLimit.resetAt,
        };
      }
      const granted = minted.grantedPermissions;
      checks.readOnlyApp = minted.writePermissions.length === 0;
      checks.allowedPermissions = minted.writePermissions.every(
        (name) => name === 'issues' && issueManagement(config.settings).enabled,
      );
      checks.canReadContents = granted.contents === 'read' || granted.contents === 'write';
      checks.canReadPullRequests =
        granted.pull_requests === 'read' || granted.pull_requests === 'write';
      checks.canReadActions = granted.actions === 'read' || granted.actions === 'write';
      checks.canReadDeployments = granted.deployments === 'read' || granted.deployments === 'write';
      if (!checks.hasRepositories) warnings.push('the installation exposes no repositories');
      if (!checks.canReadContents)
        warnings.push(
          'GitHub App requires Contents repository permission (read) for code diagnosis',
        );
      if (!checks.webhookSecretConfigured)
        warnings.push('a dedicated webhook secret is required for event synchronization');
      if (!checks.canReadPullRequests)
        warnings.push('optional Pull requests read permission is missing');
      if (!checks.canReadActions) warnings.push('optional Actions read permission is missing');
      if (!checks.canReadDeployments)
        warnings.push('optional Deployments read permission is missing');
      if (!checks.allowedPermissions)
        warnings.push(
          `GitHub App has write permissions that SRE Platform does not require: ${minted.writePermissions.join(', ')}`,
        );
      const enabled =
        checks.canEnumerateRepositories &&
        checks.hasRepositories &&
        checks.canReadContents &&
        checks.webhookSecretConfigured &&
        checks.allowedPermissions;
      return {
        status: enabled ? 'healthy' : 'unhealthy',
        reachable: true,
        authorized: true,
        warnings,
        checks,
        details: { repositoryCount },
        ...(!enabled ? { failureCategory: 'permission_denied' as const } : {}),
        durationMs: Date.now() - startedAt,
        rateLimitRemaining: rateLimit.remaining,
        rateLimitResetAt: rateLimit.resetAt,
      };
    },
  });
}

export const githubConnectorDefinition = defineConnector({
  ...GITHUB_CONNECTOR,
  create: makeGitHubConnector,
});
