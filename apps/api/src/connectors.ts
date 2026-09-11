import { alertmanagerSmeeUrl, gitLabSmeeUrl, githubSmeeUrl } from '@sre/connectors';
import { connectorConfigs, withTenant } from '@sre/db';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { authMiddleware, type TenantAuthVariables } from './auth';

import {
  type ConnectorRoutesDeps,
  type GitHubSettings,
  type GitLabSettings,
  type PrometheusSettings,
} from './connectors/helpers';

export type { ConnectorRoutesDeps } from './connectors/helpers';

import type { ConnectorRouteContext } from './connectors/routes/context';
import { registerConnectorDeleteRoutes } from './connectors/routes/delete';
import { registerConnectorDiscoveryRoutes } from './connectors/routes/discovery';
import { registerGitHubManifestRoutes } from './connectors/routes/github-manifest';
import { registerConnectorListRoutes } from './connectors/routes/list';
import { registerConnectorSaveRoutes } from './connectors/routes/save';
import { registerConnectorTestRoutes } from './connectors/routes/test';
import { registerPrepareDeliveryRoutes } from './connectors/routes/prepare-delivery';
import { registerGitLabManagementRoutes } from './connectors/routes/gitlab-management';

export function connectorRoutes(
  deps: ConnectorRoutesDeps,
): Hono<{ Variables: TenantAuthVariables }> {
  const r = new Hono<{ Variables: TenantAuthVariables }>();
  r.use('*', authMiddleware(deps.auth));
  const mutations = new Map<string, Promise<void>>();
  const serializeMutation = <T>(
    tenantId: string,
    type: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const key = `${tenantId}:${type}`;
    const previous = mutations.get(key) ?? Promise.resolve();
    const run = previous.then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    mutations.set(key, settled);
    void settled.then(() => {
      if (mutations.get(key) === settled) mutations.delete(key);
    });
    return run;
  };
  const reconcileGitHubSmee = async (
    tenantId: string,
    connectorId: string,
    settings: Pick<GitHubSettings, 'eventTransport'>,
    credential: string | null,
    webhookKey: string,
  ): Promise<'connected' | 'stopped' | 'failed' | undefined> => {
    if (!deps.githubSmee) return undefined;
    try {
      const source = credential ? githubSmeeUrl(credential) : null;
      if (settings.eventTransport === 'smee' && source) {
        await deps.githubSmee.replace(tenantId, connectorId, source, webhookKey);
        return 'connected';
      }
      await deps.githubSmee.stop(connectorId);
      return 'stopped';
    } catch (error) {
      deps.log?.error('GitHub Smee relay reconciliation failed', {
        tenantId,
        connectorType: 'github',
        operation: 'relay_reconcile',
        failureCategory: 'unreachable',
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return 'failed';
    }
  };
  const reconcileGitLabSmee = async (
    tenantId: string,
    connectorId: string,
    settings: Pick<GitLabSettings, 'eventTransport'>,
    credential: string | null,
    webhookKey: string,
  ): Promise<'connected' | 'stopped' | 'failed' | undefined> => {
    if (!deps.gitlabSmee) return undefined;
    try {
      const source = credential ? gitLabSmeeUrl(credential) : null;
      if (settings.eventTransport === 'smee' && source) {
        await deps.gitlabSmee.replace(tenantId, connectorId, source, webhookKey);
        return 'connected';
      }
      await deps.gitlabSmee.stop(connectorId);
      return 'stopped';
    } catch (error) {
      deps.log?.error('GitLab Smee relay reconciliation failed', {
        tenantId,
        connectorType: 'gitlab',
        operation: 'relay_reconcile',
        failureCategory: 'unreachable',
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return 'failed';
    }
  };
  const reconcileAlertmanagerSmee = async (
    tenantId: string,
    connectorId: string,
    settings: Pick<PrometheusSettings, 'eventTransport'>,
    credential: string | null,
    webhookKey: string,
  ): Promise<'connected' | 'stopped' | 'failed' | undefined> => {
    if (!deps.alertmanagerSmee) return undefined;
    try {
      const source = alertmanagerSmeeUrl(credential);
      if (settings.eventTransport === 'smee' && source) {
        await deps.alertmanagerSmee.replace(tenantId, connectorId, source, webhookKey);
        return 'connected';
      }
      await deps.alertmanagerSmee.stop(connectorId);
      return 'stopped';
    } catch (error) {
      deps.log?.error('Alertmanager Smee relay reconciliation failed', {
        tenantId,
        connectorType: 'prometheus',
        operation: 'relay_reconcile',
        failureCategory: 'unreachable',
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return 'failed';
    }
  };
  const legacyConnectorId = async (
    tenantId: string,
    type: string,
  ): Promise<string | null | 'ambiguous'> => {
    const rows = await withTenant(deps.db, tenantId, (tx) =>
      tx
        .select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(and(eq(connectorConfigs.type, type), isNull(connectorConfigs.deletedAt)))
        .limit(2),
    );
    return rows.length > 1 ? 'ambiguous' : (rows[0]?.id ?? null);
  };

  const context: ConnectorRouteContext = {
    deps,
    serializeMutation,
    mutationPending: (tenantId, operationId) => mutations.has(`${tenantId}:${operationId}`),
    reconcileGitHubSmee,
    reconcileGitLabSmee,
    reconcileAlertmanagerSmee,
    legacyConnectorId,
  };
  registerConnectorListRoutes(r, context);
  registerGitLabManagementRoutes(r, context);
  registerPrepareDeliveryRoutes(r);
  registerGitHubManifestRoutes(r, context);
  registerConnectorSaveRoutes(r, context);
  registerConnectorDiscoveryRoutes(r, context);
  registerConnectorTestRoutes(r, context);
  registerConnectorDeleteRoutes(r, context);
  return r;
}
