import { createDataSourceConnector, type ConnectorConfig } from '../../registry';
import { dnsLookup, type HostLookup } from '../../ssrf';
import type {
  IDataSourceConnector,
  NormalizedSnapshot,
  ProbeResult,
  TriageContext,
} from '../../types';
import { obj, str } from '../../values';
import {
  ArgoApiError,
  ArgoPermissionError,
  MAX_HISTORY_PER_APPLICATION,
  PROBE_JSON_BYTES,
  PROBE_TIMEOUT_MS,
  aInit,
  abortAsUnavailable,
  boundedJson,
  buildGetUrl,
  connect,
  configuredScopes,
  isTlsFailure,
  isValidName,
  type ArgoClient,
  type FetchLike,
} from './client';
import { ARGOCD_CONNECTOR_METADATA } from './definition';
import { argoCdEntityCoverage } from './entity-coverage';
import {
  applicationIdentity,
  effectiveProject,
  projectedConditions,
  projectedSources,
  revisions,
  safeHttpUrl,
  safeProviderMessage,
  summarizeApp,
} from './projection';
import { makeArgoCdTools } from './tools';
import { argoTopology } from './topology';
import {
  readApplications,
  verifyDedicatedAccount,
  verifyEffectivePermissions,
} from './verification';

export function makeSingleArgoCdConnector(
  config: ConnectorConfig,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
): IDataSourceConnector {
  let lastPollEvidence: ReturnType<NonNullable<IDataSourceConnector['pollEvidence']>>;
  const connector = createDataSourceConnector(config, ARGOCD_CONNECTOR_METADATA, {
    topology: argoTopology(config, fetchImpl, lookup),
    entityCoverage: argoCdEntityCoverage(config.id, () => configuredScopes(config.settings)),
    async snapshot(): Promise<NormalizedSnapshot[]> {
      const startedAt = Date.now();
      lastPollEvidence = undefined;
      try {
        const client = await connect(config, lookup);
        const applications = await readApplications(config, fetchImpl, client);
        const observedAt = new Date();
        const snapshots: NormalizedSnapshot[] = [];
        for (const application of applications) {
          const applicationId = applicationIdentity(application);
          if (!applicationId) continue;
          const raw = obj(application);
          const metadata = obj(raw.metadata);
          const applicationUid = str(metadata.uid);
          if (!applicationUid)
            throw new ArgoApiError(
              'argocd Application is missing metadata.uid',
              'provider_unavailable',
            );
          const spec = obj(raw.spec);
          const status = obj(raw.status);
          const sync = obj(status.sync);
          const health = obj(status.health);
          const operation = obj(status.operationState);
          const destination = obj(spec.destination);
          const currentRevisions = revisions(sync);
          const conditions = projectedConditions(status.conditions);
          const sources = projectedSources(spec);
          const name = str(metadata.name)!;
          const namespace = str(metadata.namespace)!;
          const project = effectiveProject(application);
          const destinationServer = str(destination.server);
          const destinationNamespace = str(destination.namespace);
          const displayBase = new URL(client.base);
          if (client.hostHeader) displayBase.host = client.hostHeader;
          const externalUrl =
            safeHttpUrl(obj(metadata.annotations)['link.argocd.argoproj.io/external-link']) ??
            `${displayBase.toString().replace(/\/+$/, '')}/applications/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
          snapshots.push({
            tenantId: config.tenantId,
            source: 'argocd',
            entityId: `application:${applicationId}`,
            metrics: {},
            metadata: {
              kind: 'application',
              applicationId,
              applicationName: name,
              applicationNamespace: namespace,
              project,
              syncStatus: str(sync.status),
              healthStatus: str(health.status),
              healthMessage: safeProviderMessage(health.message),
              operationPhase: str(operation.phase),
              operationMessage: safeProviderMessage(operation.message),
              revisions: currentRevisions,
              sources,
              conditions,
              destinationServer,
              destinationNamespace,
              url: externalUrl,
            },
            observedAt,
          });

          const history = Array.isArray(status.history) ? status.history : [];
          if (history.length > MAX_HISTORY_PER_APPLICATION)
            throw new ArgoApiError('argocd history count exceeds bound', 'backlog');
          for (const entryValue of history) {
            const entry = obj(entryValue);
            const historyId =
              typeof entry.id === 'number' || typeof entry.id === 'string' ? String(entry.id) : '';
            const completedAt = str(entry.deployedAt);
            const entryRevisions = revisions(entry);
            if (!historyId || !completedAt || entryRevisions.length === 0) continue;
            const providerId = `${applicationUid}:${historyId}`;
            const entrySources = projectedSources(entry);
            const sourceRefs = (entrySources.length > 0 ? entrySources : sources).flatMap(
              (source) => (source.targetRevision ? [source.targetRevision] : []),
            );
            const initiatedBy = obj(entry.initiatedBy);
            snapshots.push({
              tenantId: config.tenantId,
              source: 'argocd',
              entityId: `deployment:${providerId}`,
              metrics: {},
              metadata: {
                kind: 'deployment',
                providerId,
                applicationId,
                applicationName: name,
                applicationNamespace: namespace,
                historyId,
                repo: applicationId,
                service: name,
                sha: entryRevisions[0],
                revisions: entryRevisions,
                sources: entrySources,
                ref: sourceRefs.length > 0 ? sourceRefs.join(', ') : undefined,
                operationPhase: 'Succeeded',
                status: 'success',
                actor:
                  str(initiatedBy.username) ??
                  (initiatedBy.automated === true ? 'automated sync' : undefined),
                deployStartedAt: str(entry.deployStartedAt),
                deployedAt: completedAt,
                providerCreatedAt: str(entry.deployStartedAt),
                providerUpdatedAt: completedAt,
                url: externalUrl,
              },
              observedAt,
            });
          }
        }
        lastPollEvidence = { durationMs: Date.now() - startedAt };
        return snapshots;
      } catch (error) {
        lastPollEvidence = {
          durationMs: Date.now() - startedAt,
          failureCategory:
            error instanceof ArgoApiError ? error.failureCategory : 'provider_unavailable',
        };
        throw error;
      }
    },
    pollEvidence: () => lastPollEvidence,
    async fetchTriageContext(query): Promise<TriageContext> {
      // Map the incident service to scoped applications. ArgoCD state is current, not windowed, but
      // the requested window is echoed for transparency. Failure degrades to a note.
      const noApplication = (): TriageContext => ({
        source: 'argocd',
        data: {
          service: query.service,
          windowMinutes: query.windowMinutes,
          note: `no argocd application named '${query.service}'`,
        },
      });
      if (!isValidName(query.service)) return noApplication();
      try {
        const c = await connect(config, lookup);
        const matches = (await readApplications(config, fetchImpl, c)).filter(
          (application) => str(obj(obj(application).metadata).name) === query.service,
        );
        if (matches.length === 0) return noApplication();
        if (matches.length > 1)
          return {
            source: 'argocd',
            data: {
              service: query.service,
              windowMinutes: query.windowMinutes,
              note: `multiple scoped argocd applications are named '${query.service}'`,
              applications: matches.map(summarizeApp),
            },
          };
        const app = matches[0]!;
        const conditions = obj(obj(app).status).conditions;
        return {
          source: 'argocd',
          data: {
            service: query.service,
            windowMinutes: query.windowMinutes,
            application: summarizeApp(app),
            conditions: projectedConditions(conditions),
          },
        };
      } catch {
        return noApplication();
      }
    },
    tools: () => makeArgoCdTools(config, fetchImpl, lookup),
    async probe(): Promise<ProbeResult> {
      const startedAt = Date.now();
      const warnings: string[] = [];
      const usesHttp = /^http:/i.test(String(config.settings.baseUrl).trim());
      if (usesHttp) warnings.push('HTTP sends project tokens and API responses unencrypted.');
      let client: ArgoClient;
      const probeSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      try {
        client = {
          ...(await Promise.race([connect(config, lookup), abortAsUnavailable(probeSignal)])),
          signal: probeSignal,
        };
      } catch (error) {
        const category =
          error instanceof ArgoApiError ? error.failureCategory : 'provider_unavailable';
        warnings.push(
          category === 'permission_denied'
            ? 'ArgoCD application scope is missing or invalid'
            : 'ArgoCD connector configuration is invalid',
        );
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings,
          failureCategory: category === 'backlog' ? 'provider_unavailable' : category,
          durationMs: Date.now() - startedAt,
        };
      }
      let userinfoResponse: Response;
      try {
        userinfoResponse = await fetchImpl(
          buildGetUrl(client.base, '/api/v1/session/userinfo'),
          aInit(client),
        );
      } catch (error) {
        const tls = isTlsFailure(error);
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: [
            ...warnings,
            tls ? 'ArgoCD TLS certificate verification failed' : 'ArgoCD did not respond',
          ],
          checks: {
            ...(tls ? { tlsTrusted: false } : {}),
            ...(config.settings.insecureSkipTLSVerify === true
              ? { tlsVerificationDisabled: true }
              : {}),
          },
          failureCategory: tls ? 'tls' : 'unreachable',
          durationMs: Date.now() - startedAt,
        };
      }
      if (userinfoResponse.status === 401 || userinfoResponse.status === 403) {
        warnings.push('argocd reachable but the credential was rejected');
        return {
          status: 'unhealthy',
          reachable: true,
          authorized: false,
          warnings,
          failureCategory: 'permission_denied',
          durationMs: Date.now() - startedAt,
        };
      }
      if (!userinfoResponse.ok) {
        warnings.push(`argocd returned ${userinfoResponse.status}`);
        return {
          status: 'unhealthy',
          reachable: true,
          authorized: false,
          warnings,
          failureCategory: 'provider_unavailable',
          durationMs: Date.now() - startedAt,
        };
      }
      let userinfo: unknown;
      try {
        userinfo = await boundedJson(userinfoResponse, PROBE_JSON_BYTES);
      } catch (error) {
        const category =
          error instanceof ArgoApiError ? error.failureCategory : 'provider_unavailable';
        return {
          status: 'unhealthy',
          reachable: true,
          authorized: false,
          warnings: [...warnings, 'argocd returned invalid identity evidence'],
          failureCategory: category === 'backlog' ? 'provider_unavailable' : category,
          durationMs: Date.now() - startedAt,
        };
      }
      const identity = obj(userinfo);
      const expectedAccount = str(config.settings.identity) ?? str(config.settings.account);
      const username = str(identity.username);
      if (
        identity.loggedIn !== true ||
        !expectedAccount ||
        username !== expectedAccount ||
        username === 'admin'
      ) {
        warnings.push('ArgoCD token identity does not match the configured project role');
        return {
          status: 'unhealthy',
          reachable: true,
          authorized: false,
          warnings,
          checks: { identityMatches: false },
          failureCategory: 'permission_denied',
          durationMs: Date.now() - startedAt,
        };
      }
      let requiredReadsVerified = false;
      let denySamplesPassed = false;
      let canListApplications: boolean | undefined;
      try {
        if (!expectedAccount.startsWith('proj:'))
          await verifyDedicatedAccount(expectedAccount, fetchImpl, client);
        try {
          await verifyEffectivePermissions(config, fetchImpl, client);
          requiredReadsVerified = true;
          denySamplesPassed = true;
        } catch (error) {
          if (error instanceof ArgoPermissionError && error.check === 'deny_samples')
            requiredReadsVerified = true;
          throw error;
        }
        canListApplications = false;
        const applications = await readApplications(config, fetchImpl, client);
        canListApplications = true;
        if (applications.length === 0) {
          return {
            status: 'unhealthy',
            reachable: true,
            authorized: true,
            warnings: [...warnings, 'no Applications match the configured ArgoCD scope'],
            checks: {
              identityMatches: true,
              requiredReadsVerified: true,
              denySamplesPassed: true,
              canListApplications: true,
              hasScopedApplications: false,
            },
            failureCategory: 'permission_denied',
            durationMs: Date.now() - startedAt,
          };
        }
      } catch (error) {
        const failureCategory =
          error instanceof ArgoApiError ? error.failureCategory : 'provider_unavailable';
        warnings.push(
          failureCategory === 'permission_denied'
            ? 'token permissions failed the configured read-only scope checks'
            : failureCategory === 'tls'
              ? 'ArgoCD TLS certificate verification failed'
              : failureCategory === 'unreachable'
                ? 'argocd Applications discovery did not respond'
                : 'argocd Applications discovery failed',
        );
        return {
          status: 'unhealthy',
          reachable: failureCategory !== 'unreachable' && failureCategory !== 'tls',
          authorized: true,
          warnings,
          checks: {
            identityMatches: true,
            requiredReadsVerified,
            denySamplesPassed,
            ...(canListApplications !== undefined ? { canListApplications } : {}),
            ...(failureCategory === 'tls' ? { tlsTrusted: false } : {}),
          },
          failureCategory: failureCategory === 'backlog' ? 'provider_unavailable' : failureCategory,
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        status: 'healthy',
        reachable: true,
        authorized: true,
        warnings,
        checks: {
          identityMatches: true,
          requiredReadsVerified: true,
          denySamplesPassed: true,
          ...(!usesHttp
            ? {
                tlsTrusted: config.settings.insecureSkipTLSVerify !== true,
                tlsVerificationDisabled: config.settings.insecureSkipTLSVerify === true,
              }
            : {}),
          canListApplications: true,
          hasScopedApplications: true,
        },
        durationMs: Date.now() - startedAt,
      };
    },
  });
  return connector;
}
