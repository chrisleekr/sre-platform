import { connectorCapabilities, githubSmeeUrl, isConnectorType } from '@sre/connectors';
import {
  connectorConfigs,
  alertEpisodeIntakes,
  connectorCredentialKey,
  connectorEventCredentialKey,
  countGitHubRepositories,
  countGitLabProjects,
  gitLabPollingCoverage,
  withTenant,
} from '@sre/db';
import { isNull, count, or, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { type TenantAuthVariables } from '../../auth';

import {
  parseArgoCdCredentialBundle,
  parseArgoCdSettings,
  parseLegacyGitHubCredential,
  publicArgoCdSettings,
  publicGitHubSettings,
  publicGitLabSettings,
  publicGrafanaSettings,
  publicKubernetesSettings,
  publicPrometheusSettings,
  requestObject,
} from '../helpers';

export type { ConnectorRoutesDeps } from '../helpers';

import type { ConnectorRouteContext } from './context';

export function registerConnectorListRoutes(
  r: Hono<{ Variables: TenantAuthVariables }>,
  context: ConnectorRouteContext,
): void {
  const { deps } = context;
  r.get('/', async (c) => {
    const { tenantId } = c.get('tenant');
    const rows = await withTenant(deps.db, tenantId, (tx) =>
      tx
        .select({
          id: connectorConfigs.id,
          name: connectorConfigs.name,
          type: connectorConfigs.type,
          webhookKey: connectorConfigs.webhookKey,
          settings: connectorConfigs.settings,
          enabled: connectorConfigs.enabled,
          verificationAttemptedAt: connectorConfigs.verificationAttemptedAt,
          verificationSucceededAt: connectorConfigs.verificationSucceededAt,
          verificationFailureCategory: connectorConfigs.verificationFailureCategory,
          verificationDurationMs: connectorConfigs.verificationDurationMs,
          verificationRateLimitRemaining: connectorConfigs.verificationRateLimitRemaining,
          verificationRateLimitResetAt: connectorConfigs.verificationRateLimitResetAt,
          pollAttemptedAt: connectorConfigs.pollAttemptedAt,
          pollSucceededAt: connectorConfigs.pollSucceededAt,
          pollSnapshotCount: connectorConfigs.pollSnapshotCount,
          pollErrorCount: connectorConfigs.pollErrorCount,
          pollFailureCategory: connectorConfigs.pollFailureCategory,
          pollDurationMs: connectorConfigs.pollDurationMs,
          pollRateLimitRemaining: connectorConfigs.pollRateLimitRemaining,
          pollRateLimitResetAt: connectorConfigs.pollRateLimitResetAt,
          pollCursor: connectorConfigs.pollCursor,
          eventAttemptedAt: connectorConfigs.eventAttemptedAt,
          eventSucceededAt: connectorConfigs.eventSucceededAt,
          eventCount: connectorConfigs.eventCount,
          eventFailureCategory: connectorConfigs.eventFailureCategory,
        })
        .from(connectorConfigs)
        .where(isNull(connectorConfigs.deletedAt)),
    );
    const pendingCycles = await withTenant(deps.db, tenantId, (tx) =>
      tx
        .select({ connectorId: alertEpisodeIntakes.dataSourceId, count: count() })
        .from(alertEpisodeIntakes)
        .where(
          or(
            isNull(alertEpisodeIntakes.startsAt),
            inArray(alertEpisodeIntakes.failureCategory, [
              'binding_episode_mismatch',
              'native_cycle_association_required',
              'conflicting_episode_times',
            ]),
          ),
        )
        .groupBy(alertEpisodeIntakes.dataSourceId),
    );
    const connectors = await Promise.all(
      rows.map(async (row) => {
        const credential = await deps.secrets.get(tenantId, connectorCredentialKey(row.id));
        const eventCredential = ['prometheus', 'datadog', 'grafana', 'statuscake'].includes(
          row.type,
        )
          ? await deps.secrets.get(tenantId, connectorEventCredentialKey(row.id))
          : null;
        const legacy = parseLegacyGitHubCredential(credential);
        const settings = (
          row.type === 'gitlab'
            ? publicGitLabSettings(row.settings, credential)
            : row.type === 'kubernetes'
              ? publicKubernetesSettings(row.settings)
              : row.type === 'github'
                ? publicGitHubSettings(
                    row.settings,
                    legacy,
                    Boolean(credential && githubSmeeUrl(credential)),
                  )
                : row.type === 'argocd'
                  ? publicArgoCdSettings(
                      parseArgoCdSettings(row.settings) ?? {
                        baseUrl: '',
                        applicationsInAnyNamespace: false,
                        projects: [],
                      },
                      parseArgoCdCredentialBundle(credential),
                    )
                  : row.type === 'prometheus'
                    ? publicPrometheusSettings(row.settings, eventCredential)
                    : row.type === 'grafana'
                      ? publicGrafanaSettings(row.settings)
                      : (row.settings ?? {})
        ) as Record<string, unknown>;
        if (row.type === 'grafana' || row.type === 'datadog')
          settings.eventCredentialConfigured = Boolean(eventCredential);
        const capabilities = isConnectorType(row.type)
          ? connectorCapabilities(row.type)
          : {
              availability: 'incomplete' as const,
              alertLifecycle: 'none' as const,
              configuration: 'tenant' as const,
              instances: 'multiple' as const,
              investigation: 'none' as const,
              polling: 'none' as const,
              events: 'none' as const,
            };
        const verificationEvidence =
          row.type === 'github' || row.type === 'argocd'
            ? {
                durationMs: row.verificationDurationMs,
                ...(row.type === 'github'
                  ? {
                      rateLimit: {
                        remaining: row.verificationRateLimitRemaining,
                        resetAt: row.verificationRateLimitResetAt,
                      },
                    }
                  : {}),
              }
            : {};
        const pollingEvidence =
          row.type === 'github' || row.type === 'argocd'
            ? {
                durationMs: row.pollDurationMs,
                ...(row.type === 'github'
                  ? {
                      rateLimit: {
                        remaining: row.pollRateLimitRemaining,
                        resetAt: row.pollRateLimitResetAt,
                      },
                    }
                  : {}),
              }
            : {};
        const repositoryCount =
          row.type === 'github'
            ? await countGitHubRepositories(deps.db, tenantId, row.id)
            : row.type === 'gitlab' && 'groupId' in settings
              ? await countGitLabProjects(deps.db, tenantId, row.id)
              : undefined;
        return {
          id: row.id,
          name: row.name,
          type: row.type,
          capabilities,
          lifecycle: {
            pendingEpisodes:
              pendingCycles.find((pending) => pending.connectorId === row.id)?.count ?? 0,
            mode: capabilities.alertLifecycle ?? 'none',
            lastReconciledAt:
              (row.pollCursor as { lifecycle?: { lastAttemptAt?: string } } | null)?.lifecycle
                ?.lastAttemptAt ?? null,
            failureCategory:
              (row.pollCursor as { lifecycle?: { failureCategory?: string } } | null)?.lifecycle
                ?.failureCategory ?? null,
            boundEpisodes: Array.isArray(settings.lifecycleBindings)
              ? settings.lifecycleBindings.length
              : 0,
          },
          settings,
          enabled: row.enabled,
          credentialConfigured:
            (row.type === 'argocd'
              ? parseArgoCdCredentialBundle(credential) !== null
              : credential !== null) ||
            (row.type !== 'github' &&
              row.type !== 'argocd' &&
              (await deps.secrets.has(tenantId, connectorCredentialKey(row.id)))),
          verification: {
            lastAttemptAt: row.verificationAttemptedAt,
            lastSuccessAt: row.verificationSucceededAt,
            failureCategory: row.verificationFailureCategory,
            ...verificationEvidence,
          },
          ...(capabilities.polling === 'snapshots'
            ? {
                polling: {
                  lastAttemptAt: row.pollAttemptedAt,
                  lastSuccessAt: row.pollSucceededAt,
                  snapshotCount: row.pollSnapshotCount,
                  errorCount: row.pollErrorCount,
                  ...(row.type === 'gitlab' && settings.eventStrategy === 'system'
                    ? {
                        gitlabCoverage: await gitLabPollingCoverage(deps.db, tenantId, row.id),
                      }
                    : {}),
                  failureCategory: row.pollFailureCategory,
                  ...(row.type === 'github'
                    ? {
                        baselineTruncated:
                          requestObject(row.pollCursor)?.baselineTruncated === true,
                      }
                    : row.type === 'argocd'
                      ? { projects: requestObject(row.pollCursor)?.projects ?? [] }
                      : {}),
                  ...pollingEvidence,
                },
              }
            : {}),
          ...(row.type === 'github' || (row.type === 'gitlab' && 'groupId' in settings)
            ? { repositoryCount }
            : {}),
          ...(row.type === 'github' ||
          ['prometheus', 'datadog', 'grafana', 'statuscake'].includes(row.type) ||
          (row.type === 'gitlab' && 'groupId' in settings)
            ? {
                webhookPath: `/webhooks/${row.type === 'prometheus' ? 'alertmanager' : row.type}/${row.webhookKey ?? row.id}`,
                events: {
                  lastAttemptAt: row.eventAttemptedAt,
                  lastSuccessAt: row.eventSucceededAt,
                  count: row.eventCount,
                  failureCategory: row.eventFailureCategory,
                },
              }
            : {}),
        };
      }),
    );
    return c.json({ connectors });
  });
}
