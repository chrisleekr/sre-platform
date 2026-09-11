import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  connectorConfigs,
  connectorCredentialKey,
  connectorEventCredentialKey,
  withTenant,
  type Db,
  type SecretStore,
} from '@sre/db';
import {
  githubCredentialBundle,
  githubPrivateKey,
  githubSmeeUrl,
  githubWebhookSecret,
  gitLabAccessToken,
  gitLabCredentialBundle,
  gitLabSmeeUrl,
  gitLabWebhookSecret,
  gitLabWebhookSigningToken,
  alertmanagerSmeeUrl,
} from '@sre/connectors';
import type { Logger } from './logger';
import type { SmeeManager } from './smee';

type Provider = 'github' | 'gitlab';

export async function recordAlertmanagerRelayHealth(options: {
  db: Db;
  tenantId: string;
  connectorId: string;
  status: 'connected' | 'failed';
}): Promise<void> {
  const failureFilter =
    options.status === 'connected'
      ? and(
          eq(connectorConfigs.id, options.connectorId),
          eq(connectorConfigs.eventFailureCategory, 'relay_unreachable'),
        )
      : eq(connectorConfigs.id, options.connectorId);
  await withTenant(options.db, options.tenantId, (tx) =>
    tx
      .update(connectorConfigs)
      .set({
        eventFailureCategory: options.status === 'failed' ? 'relay_unreachable' : null,
        updatedAt: sql`now()`,
      })
      .where(failureFilter),
  );
}

function storedSource(provider: Provider, credential: string): string | null {
  return provider === 'github' ? githubSmeeUrl(credential) : gitLabSmeeUrl(credential);
}

/** Restore local Alertmanager relays from the connector's independent inbound credential. */
export async function restoreAlertmanagerSmeeRelays(options: {
  db: Db;
  secrets: SecretStore;
  manager: Pick<SmeeManager, 'replace'>;
  log: Logger;
}): Promise<void> {
  const rows = await options.db
    .select({
      tenantId: connectorConfigs.tenantId,
      connectorId: connectorConfigs.id,
      webhookKey: connectorConfigs.webhookKey,
      settings: connectorConfigs.settings,
      enabled: connectorConfigs.enabled,
    })
    .from(connectorConfigs)
    .where(
      and(
        eq(connectorConfigs.type, 'prometheus'),
        eq(connectorConfigs.enabled, true),
        isNull(connectorConfigs.deletedAt),
      ),
    );
  for (const row of rows) {
    let status: 'connected' | 'failed';
    try {
      if (!row.enabled) continue;
      const settings =
        row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
          ? (row.settings as Record<string, unknown>)
          : {};
      if (settings.eventTransport !== 'smee' || !row.webhookKey) continue;
      const credential = await options.secrets.get(
        row.tenantId,
        connectorEventCredentialKey(row.connectorId),
      );
      const source = alertmanagerSmeeUrl(credential);
      if (!source) throw new Error('Alertmanager Smee credential is missing');
      await options.manager.replace(row.tenantId, row.connectorId, source, row.webhookKey);
      status = 'connected';
    } catch (error) {
      status = 'failed';
      options.log.error('Alertmanager Smee relay restore failed', {
        tenantId: row.tenantId,
        operation: 'relay_restore',
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
    await recordAlertmanagerRelayHealth({
      db: options.db,
      tenantId: row.tenantId,
      connectorId: row.connectorId,
      status,
    }).catch((error) =>
      options.log.error('Alertmanager Smee relay health update failed', {
        tenantId: row.tenantId,
        operation: 'relay_health_update',
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

function migrateCredential(
  provider: Provider,
  credential: string,
  legacySource: string,
): string | null {
  if (provider === 'github') {
    const webhookSecret = githubWebhookSecret(credential);
    return webhookSecret
      ? githubCredentialBundle(githubPrivateKey(credential), webhookSecret, legacySource)
      : null;
  }
  const token = gitLabAccessToken(credential);
  if (!token) return null;
  const webhookSecret = gitLabWebhookSecret(credential);
  const webhookSigningToken = gitLabWebhookSigningToken(credential);
  return gitLabCredentialBundle(token, {
    ...(webhookSecret ? { webhookSecret } : {}),
    ...(webhookSigningToken ? { webhookSigningToken } : {}),
    smeeUrl: legacySource,
  });
}

/** Restore every saved local relay; a legacy global channel is safe only for a single tenant row. */
export async function restoreSmeeRelays(options: {
  provider: Provider;
  db: Db;
  secrets: SecretStore;
  manager: Pick<SmeeManager, 'replace'>;
  legacySource?: string;
  log: Logger;
}): Promise<void> {
  const rows = await options.db
    .select({
      tenantId: connectorConfigs.tenantId,
      connectorId: connectorConfigs.id,
      webhookKey: connectorConfigs.webhookKey,
      settings: connectorConfigs.settings,
    })
    .from(connectorConfigs)
    .where(and(eq(connectorConfigs.type, options.provider), isNull(connectorConfigs.deletedAt)));
  const legacySource = rows.length === 1 ? options.legacySource : undefined;
  const providerName = options.provider === 'github' ? 'GitHub' : 'GitLab';

  for (const row of rows) {
    try {
      const settings =
        row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings)
          ? (row.settings as Record<string, unknown>)
          : {};
      if (settings.eventTransport !== 'smee' || !row.webhookKey) continue;
      const key = connectorCredentialKey(row.connectorId);
      const credential = await options.secrets.get(row.tenantId, key);
      if (!credential) continue;
      let source = storedSource(options.provider, credential);
      if (!source && legacySource) {
        const migrated = migrateCredential(options.provider, credential, legacySource);
        if (migrated) {
          await options.secrets.put(row.tenantId, key, migrated);
          source = storedSource(options.provider, migrated);
          options.log.info(`${providerName} Smee channel migrated into connector credential`, {
            tenantId: row.tenantId,
          });
        }
      }
      if (source)
        await options.manager.replace(row.tenantId, row.connectorId, source, row.webhookKey);
    } catch (error) {
      options.log.error(`${providerName} Smee relay restore failed`, {
        tenantId: row.tenantId,
        operation: 'relay_restore',
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}
