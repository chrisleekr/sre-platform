import { isConnectorType } from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  connectorEventCredentialKey,
  gitLabManagementCredentialKey,
  gitlabHookAuthorizations,
  deactivateGitHubRepositories,
  deactivateGitLabProjects,
  withTenant,
} from '@sre/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { type TenantAuthVariables } from '../../auth';

import { connectorInstanceId, lockConnectorLifecycle } from '../helpers';

export type { ConnectorRoutesDeps } from '../helpers';

import type { ConnectorRouteContext } from './context';

export function registerConnectorDeleteRoutes(
  r: Hono<{ Variables: TenantAuthVariables }>,
  context: ConnectorRouteContext,
): void {
  const { deps, serializeMutation, mutationPending, legacyConnectorId } = context;
  r.delete('/:type/:id', async (c) => {
    const { tenantId } = c.get('tenant');
    const type = c.req.param('type');
    if (!isConnectorType(type)) return c.json({ error: 'unknown connector type' }, 400);
    const connectorId = connectorInstanceId(c.req.param('id'));
    if (!connectorId) return c.json({ error: 'invalid data source ID' }, 400);
    if (type === 'argocd' && mutationPending(tenantId, connectorId))
      return c.json({ error: 'an ArgoCD connector operation is already in progress' }, 409);
    return serializeMutation(tenantId, connectorId, async () => {
      try {
        const disconnected = await withTenant(deps.db, tenantId, async (tx) => {
          await lockConnectorLifecycle(tx, tenantId, connectorId);
          const rows = await tx
            .select({ lifecycleVersion: connectorConfigs.lifecycleVersion })
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
          if (!rows[0]) return null;
          await deps.secrets.delete(tenantId, connectorCredentialKey(connectorId), tx);
          if (type === 'prometheus')
            await deps.secrets.delete(tenantId, connectorEventCredentialKey(connectorId), tx);
          if (type === 'github') await deactivateGitHubRepositories(tx, tenantId, connectorId);
          if (type === 'gitlab') await deactivateGitLabProjects(tx, tenantId, connectorId);
          if (type === 'gitlab') {
            await deps.secrets.delete(tenantId, gitLabManagementCredentialKey(connectorId), tx);
            await tx
              .update(gitlabHookAuthorizations)
              .set({ revokedAt: new Date() })
              .where(
                and(
                  eq(gitlabHookAuthorizations.connectorId, connectorId),
                  isNull(gitlabHookAuthorizations.revokedAt),
                ),
              );
          }
          await tx
            .update(connectorConfigs)
            .set({
              enabled: false,
              deletedAt: new Date(),
              lifecycleVersion: sql`${connectorConfigs.lifecycleVersion} + 1`,
              updatedAt: sql`now()`,
            })
            .where(eq(connectorConfigs.id, connectorId));
          return { id: connectorId, lifecycleVersion: rows[0].lifecycleVersion };
        });
        if (disconnected === null) return c.json({ error: 'data source not found' }, 404);
        await deps.cache?.delete?.(tenantId, type, disconnected).catch(() => {});
      } catch {
        return c.json({ error: 'credential deletion failed; retry disconnect' }, 503);
      }
      if (type === 'github') {
        await deps.githubSmee?.stop(connectorId).catch((error) =>
          deps.log?.error('GitHub Smee relay stop failed', {
            tenantId,
            connectorId,
            connectorType: 'github',
            operation: 'relay_stop',
            errorType: error instanceof Error ? error.name : typeof error,
          }),
        );
      }
      if (type === 'gitlab') {
        await deps.gitlabSmee?.stop(connectorId).catch((error) =>
          deps.log?.error('GitLab Smee relay stop failed', {
            tenantId,
            connectorId,
            connectorType: 'gitlab',
            operation: 'relay_stop',
            errorType: error instanceof Error ? error.name : typeof error,
          }),
        );
      }
      if (type === 'prometheus') {
        await deps.alertmanagerSmee?.stop(connectorId).catch((error) =>
          deps.log?.error('Alertmanager Smee relay stop failed', {
            tenantId,
            connectorId,
            connectorType: 'prometheus',
            operation: 'relay_stop',
            errorType: error instanceof Error ? error.name : typeof error,
          }),
        );
      }
      return c.json({ ok: true });
    });
  });

  r.delete('/:type', async (c) => {
    const { tenantId } = c.get('tenant');
    const type = c.req.param('type');
    if (!isConnectorType(type)) return c.json({ error: 'unknown connector type' }, 400);
    const connectorId = await legacyConnectorId(tenantId, type);
    if (connectorId === 'ambiguous')
      return c.json({ error: 'data source ID is required when multiple connections exist' }, 409);
    if (!connectorId) return c.json({ ok: true });
    return r.request(`/${type}/${connectorId}`, {
      method: 'DELETE',
      headers: c.req.raw.headers,
    });
  });
}
