import {
  connectorCapabilities,
  discoverGitHubRepositories,
  discoverGitLabGroup,
  gitLabAccessToken,
  isConnectorType,
  type GitHubRepositorySummary,
  type GitLabDiscovery,
} from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  connectorEventCredentialKey,
  gitlabHookAuthorizations,
  syncGitHubRepositories,
  syncGitLabProjects,
  withTenant,
} from '@sre/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { type TenantAuthVariables } from '../../auth';
import { recordAlertmanagerRelayHealth } from '../../smee-restore';

import {
  connectorInstanceId,
  failureCategory,
  lockConnectorLifecycle,
  parseGitLabSettings,
  parsePrometheusSettings,
  readStoredArgoCdState,
  readStoredGitHubState,
  storedGitHubStateMatches,
} from '../helpers';

export type { ConnectorRoutesDeps } from '../helpers';

import type { ConnectorRouteContext } from './context';

export function registerConnectorTestRoutes(
  r: Hono<{ Variables: TenantAuthVariables }>,
  context: ConnectorRouteContext,
): void {
  const { deps, serializeMutation, mutationPending, reconcileAlertmanagerSmee, legacyConnectorId } =
    context;
  r.post('/:type/:id/test', async (c) => {
    const { tenantId } = c.get('tenant');
    const type = c.req.param('type');
    const connectorId = connectorInstanceId(c.req.param('id'));
    if (!connectorId) return c.json({ error: 'invalid data source ID' }, 400);
    if (!isConnectorType(type) || !deps.registry.has(type))
      return c.json({ error: 'connection test not available for this connector type' }, 400);

    if (type === 'argocd') {
      if (
        deps.cache?.acquireLease &&
        !(await deps.cache.acquireLease(`argocd-test:${tenantId}:${connectorId}`, 10))
      )
        return c.json({ error: 'ArgoCD verification is rate limited; retry shortly' }, 429);
      if (mutationPending(tenantId, connectorId))
        return c.json({ error: 'an ArgoCD connector operation is already in progress' }, 409);
      return serializeMutation(tenantId, connectorId, async () => {
        const captured = await withTenant(deps.db, tenantId, async (tx) => {
          await lockConnectorLifecycle(tx, tenantId, connectorId);
          return readStoredArgoCdState(tx, tenantId, connectorId, deps.secrets);
        });
        if (!captured) return c.json({ error: 'save the connector first' }, 400);
        const connector = deps.registry.create({
          id: captured.id,
          name: captured.name,
          tenantId,
          type,
          settings: captured.settings as unknown as Record<string, unknown>,
          getCredential: async () => captured.credential,
        });
        const attemptedAt = new Date();
        const result = await connector.probe();
        if (result.status === 'not_applicable') return c.json(result);
        const enabled = result.status === 'healthy';
        const updated = await withTenant(deps.db, tenantId, async (tx) => {
          await lockConnectorLifecycle(tx, tenantId, connectorId);
          const current = await readStoredArgoCdState(tx, tenantId, connectorId, deps.secrets);
          if (
            !current ||
            current.id !== captured.id ||
            current.lifecycleVersion !== captured.lifecycleVersion
          )
            return false;
          await tx
            .update(connectorConfigs)
            .set({
              enabled,
              lifecycleVersion: sql`${connectorConfigs.lifecycleVersion} + 1`,
              verificationAttemptedAt: attemptedAt,
              ...(enabled ? { verificationSucceededAt: attemptedAt } : {}),
              verificationFailureCategory: enabled ? null : failureCategory(result),
              verificationDurationMs: result.durationMs ?? null,
              updatedAt: sql`now()`,
            })
            .where(eq(connectorConfigs.id, connectorId));
          return true;
        });
        if (!updated) return c.json({ error: 'connector changed during verification; retry' }, 409);
        await deps.cache
          ?.delete?.(tenantId, type, {
            id: captured.id,
            lifecycleVersion: captured.lifecycleVersion,
          })
          .catch(() => {});
        return c.json({ ...result, enabled });
      });
    }

    if (type === 'gitlab') {
      return serializeMutation(tenantId, connectorId, async () => {
        const captured = await withTenant(deps.db, tenantId, async (tx) => {
          await lockConnectorLifecycle(tx, tenantId, connectorId);
          const rows = await tx
            .select({
              id: connectorConfigs.id,
              name: connectorConfigs.name,
              enabled: connectorConfigs.enabled,
              lifecycleVersion: connectorConfigs.lifecycleVersion,
              settings: connectorConfigs.settings,
            })
            .from(connectorConfigs)
            .where(
              and(
                eq(connectorConfigs.id, connectorId),
                eq(connectorConfigs.type, type),
                isNull(connectorConfigs.deletedAt),
              ),
            )
            .limit(1);
          const row = rows[0];
          if (!row) return null;
          const settings = parseGitLabSettings(row.settings);
          const credential = await deps.secrets.get(
            tenantId,
            connectorCredentialKey(connectorId),
            tx,
          );
          return settings && credential ? { ...row, settings, credential } : null;
        });
        if (!captured) return c.json({ error: 'save the connector first' }, 400);

        const connector = deps.registry.create({
          id: captured.id,
          name: captured.name,
          tenantId,
          type,
          settings: captured.settings as unknown as Record<string, unknown>,
          getCredential: async () => captured.credential,
        });
        const attemptedAt = new Date();
        let result = await connector.probe();
        if (result.status === 'not_applicable') return c.json(result);
        let discovery: GitLabDiscovery | null = null;
        if (result.status === 'healthy' && captured.settings.groupId != null) {
          const token = gitLabAccessToken(captured.credential);
          try {
            if (!token) throw new Error('missing token');
            const discover = deps.discoverGitLabGroup ?? discoverGitLabGroup;
            discovery = await discover(
              captured.settings as unknown as Record<string, unknown>,
              token,
            );
          } catch {
            result = {
              ...result,
              status: 'unhealthy',
              warnings: [...result.warnings, 'GitLab project catalog synchronization failed'],
              failureCategory: 'provider_unavailable',
            };
          }
        }
        const enabled = result.status === 'healthy';
        const updated = await withTenant(deps.db, tenantId, async (tx) => {
          await lockConnectorLifecycle(tx, tenantId, connectorId);
          const rows = await tx
            .select({
              id: connectorConfigs.id,
              lifecycleVersion: connectorConfigs.lifecycleVersion,
            })
            .from(connectorConfigs)
            .where(
              and(
                eq(connectorConfigs.id, connectorId),
                eq(connectorConfigs.type, type),
                isNull(connectorConfigs.deletedAt),
              ),
            )
            .limit(1)
            .for('update');
          const current = rows[0];
          if (
            !current ||
            current.id !== captured.id ||
            current.lifecycleVersion !== captured.lifecycleVersion
          )
            return false;
          if (enabled && discovery) {
            await syncGitLabProjects(
              tx,
              tenantId,
              connectorId,
              String(discovery.group.id),
              discovery.projects.map((project) => ({
                groupId: String(discovery!.group.id),
                projectId: String(project.id),
                name: project.name,
                fullPath: project.pathWithNamespace,
                defaultBranch: project.defaultBranch,
                visibility: project.visibility,
                archived: project.archived,
                webUrl: project.webUrl,
                lastActivityAt: project.lastActivityAt
                  ? new Date(project.lastActivityAt)
                  : undefined,
              })),
            );
          }
          if (enabled && captured.enabled) {
            // A successful read-only Retest preserves approval for this unchanged generation.
            await tx
              .update(gitlabHookAuthorizations)
              .set({ lifecycleVersion: captured.lifecycleVersion + 1 })
              .where(
                and(
                  eq(gitlabHookAuthorizations.connectorId, connectorId),
                  eq(gitlabHookAuthorizations.lifecycleVersion, captured.lifecycleVersion),
                  isNull(gitlabHookAuthorizations.revokedAt),
                ),
              );
          }
          await tx
            .update(connectorConfigs)
            .set({
              enabled,
              lifecycleVersion: sql`${connectorConfigs.lifecycleVersion} + 1`,
              verificationAttemptedAt: attemptedAt,
              ...(enabled ? { verificationSucceededAt: attemptedAt } : {}),
              verificationFailureCategory: enabled ? null : failureCategory(result),
              verificationDurationMs: result.durationMs ?? null,
              updatedAt: sql`now()`,
            })
            .where(eq(connectorConfigs.id, connectorId));
          return true;
        });
        if (!updated) return c.json({ error: 'connector changed during verification; retry' }, 409);
        await deps.cache
          ?.delete?.(tenantId, type, {
            id: captured.id,
            lifecycleVersion: captured.lifecycleVersion,
          })
          .catch(() => {});
        return c.json({
          ...result,
          details: {
            ...result.details,
            ...(discovery ? { projectCount: discovery.projects.length } : {}),
          },
          enabled,
        });
      });
    }

    if (type === 'github') {
      return serializeMutation(tenantId, connectorId, async () => {
        const captured = await withTenant(deps.db, tenantId, async (tx) => {
          await lockConnectorLifecycle(tx, tenantId, connectorId);
          return readStoredGitHubState(tx, tenantId, connectorId, deps.secrets);
        });
        if (!captured) return c.json({ error: 'save the connector first' }, 400);

        const connector = deps.registry.create({
          id: captured.id,
          name: captured.name,
          tenantId,
          type,
          settings: captured.settings as unknown as Record<string, unknown>,
          getCredential: async () => captured.credential,
        });
        const attemptedAt = new Date();
        let result = await connector.probe();
        if (result.status === 'not_applicable') return c.json(result);
        let repositories: GitHubRepositorySummary[] = [];
        if (result.status === 'healthy') {
          try {
            const discover = deps.discoverGitHubRepositories ?? discoverGitHubRepositories;
            repositories = await discover(
              captured.settings as unknown as Record<string, unknown>,
              captured.privateKey,
            );
          } catch {
            result = {
              ...result,
              status: 'unhealthy',
              warnings: [...result.warnings, 'repository catalog synchronization failed'],
              failureCategory: 'provider_unavailable',
            };
          }
        }
        const enabled = result.status === 'healthy';

        const updated = await withTenant(deps.db, tenantId, async (tx) => {
          await lockConnectorLifecycle(tx, tenantId, connectorId);
          const current = await readStoredGitHubState(tx, tenantId, connectorId, deps.secrets);
          if (!current || !storedGitHubStateMatches(captured, current)) return false;
          if (enabled) {
            await syncGitHubRepositories(
              tx,
              tenantId,
              connectorId,
              captured.settings.installationId,
              repositories.map((repository) => ({
                installationId: captured.settings.installationId,
                repositoryId: String(repository.id),
                owner: repository.owner,
                name: repository.name,
                fullName: repository.fullName,
                defaultBranch: repository.defaultBranch,
                private: repository.private,
                archived: repository.archived,
                htmlUrl: repository.webUrl,
                pushedAt: repository.pushedAt ? new Date(repository.pushedAt) : undefined,
              })),
            );
          }
          await tx
            .update(connectorConfigs)
            .set({
              enabled,
              lifecycleVersion: sql`${connectorConfigs.lifecycleVersion} + 1`,
              verificationAttemptedAt: attemptedAt,
              ...(enabled ? { verificationSucceededAt: attemptedAt } : {}),
              verificationFailureCategory: enabled ? null : failureCategory(result),
              verificationDurationMs: result.durationMs ?? null,
              verificationRateLimitRemaining: result.rateLimitRemaining ?? null,
              verificationRateLimitResetAt: result.rateLimitResetAt
                ? new Date(result.rateLimitResetAt)
                : null,
              updatedAt: sql`now()`,
            })
            .where(eq(connectorConfigs.id, connectorId));
          return true;
        });
        if (!updated) return c.json({ error: 'connector changed during verification; retry' }, 409);
        await deps.cache
          ?.delete?.(tenantId, type, {
            id: captured.id,
            lifecycleVersion: captured.lifecycleVersion,
          })
          .catch(() => {});
        return c.json({
          ...result,
          details: { ...result.details, repositoryCount: repositories.length },
          enabled,
        });
      });
    }

    return serializeMutation(tenantId, connectorId, async () => {
      const outcome = await withTenant(deps.db, tenantId, async (tx) => {
        await lockConnectorLifecycle(tx, tenantId, connectorId);
        const rows = await tx
          .select({
            id: connectorConfigs.id,
            name: connectorConfigs.name,
            settings: connectorConfigs.settings,
            webhookKey: connectorConfigs.webhookKey,
            lifecycleVersion: connectorConfigs.lifecycleVersion,
          })
          .from(connectorConfigs)
          .where(
            and(
              eq(connectorConfigs.id, connectorId),
              eq(connectorConfigs.type, type),
              isNull(connectorConfigs.deletedAt),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) return { missing: true as const };

        const credential = await deps.secrets.get(
          tenantId,
          connectorCredentialKey(connectorId),
          tx,
        );
        const connector = deps.registry.create({
          id: row.id,
          name: row.name,
          tenantId,
          type,
          settings: row.settings as Record<string, unknown>,
          getCredential: async () => credential ?? '',
        });
        const attemptedAt = new Date();
        const result = await connector.probe();

        if (result.status === 'not_applicable') return { result };

        const enabled = result.status === 'healthy';
        const eventCredential =
          type === 'prometheus'
            ? await deps.secrets.get(tenantId, connectorEventCredentialKey(connectorId), tx)
            : null;
        await tx
          .update(connectorConfigs)
          .set({
            enabled,
            verificationAttemptedAt: attemptedAt,
            ...(enabled ? { verificationSucceededAt: attemptedAt } : {}),
            verificationFailureCategory: enabled ? null : failureCategory(result),
            updatedAt: sql`now()`,
          })
          .where(eq(connectorConfigs.id, connectorId));
        return {
          result: { ...result, enabled },
          generation: { id: row.id, lifecycleVersion: row.lifecycleVersion },
          ...(type === 'prometheus'
            ? {
                relay: {
                  enabled,
                  settings: parsePrometheusSettings(row.settings)!,
                  credential: eventCredential,
                  webhookKey: row.webhookKey ?? row.id,
                },
              }
            : {}),
        };
      });
      if ('missing' in outcome) return c.json({ error: 'save the connector first' }, 400);
      if ('generation' in outcome && connectorCapabilities(type).polling === 'snapshots')
        await deps.cache?.delete?.(tenantId, type, outcome.generation).catch(() => {});
      const relayStatus =
        'relay' in outcome && outcome.relay
          ? await reconcileAlertmanagerSmee(
              tenantId,
              connectorId,
              outcome.relay.enabled ? outcome.relay.settings : { eventTransport: 'none' },
              outcome.relay.enabled ? outcome.relay.credential : null,
              outcome.relay.webhookKey,
            )
          : undefined;
      if (relayStatus === 'failed' || relayStatus === 'connected') {
        await recordAlertmanagerRelayHealth({
          db: deps.db,
          tenantId,
          connectorId,
          status: relayStatus,
        });
      }
      return c.json({ ...outcome.result, ...(relayStatus ? { relayStatus } : {}) });
    });
  });

  r.post('/:type/test', async (c) => {
    const { tenantId } = c.get('tenant');
    const type = c.req.param('type');
    if (!isConnectorType(type)) return c.json({ error: 'unknown connector type' }, 400);
    const connectorId = await legacyConnectorId(tenantId, type);
    if (connectorId === 'ambiguous')
      return c.json({ error: 'data source ID is required when multiple connections exist' }, 409);
    if (!connectorId) return c.json({ error: 'save the connector first' }, 400);
    return r.request(`/${type}/${connectorId}/test`, {
      method: 'POST',
      headers: c.req.raw.headers,
    });
  });
}
