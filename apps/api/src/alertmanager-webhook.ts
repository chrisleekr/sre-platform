import { processAlert, type RouteDeps } from '@sre/alerts';
import { alertmanagerEventToken } from '@sre/connectors';
import { connectorConfigs, connectorEventCredentialKey, type Db, type SecretStore } from '@sre/db';
import { type ConversationHub } from '@sre/hub';
import { SlackApiError } from '@sre/surfaces';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Logger } from './logger';
import { WebhookPayloadTooLargeError, readBoundedWebhookBody } from './webhook-body';

export interface AlertmanagerWebhookDeps {
  enqueueLifecycle?: (
    tenantId: string,
    payload: {
      connectorId: string;
      monitorId: string;
      observedAt: string;
      lifecycleVersion: number;
    },
  ) => Promise<unknown>;
  adminDb: Db;
  appDb: Db;
  secrets: SecretStore;
  route: RouteDeps;
  hub: ConversationHub;
  postAlertRoot: (
    tenantId: string,
    channel: string,
    text: string,
    intakeId: string,
  ) => Promise<string>;
  dashboardBaseUrl?: string;
  log?: Logger;
}

import {
  MAX_ALERTS,
  MAX_WEBHOOK_BYTES,
  UUID_RE,
  hash,
  normalizeAlert,
  object,
  parseWebhookPrometheusSettings,
  sameSecret,
  sanitizeProviderUrl,
  string,
  type NormalizedAlert,
} from './alertmanager-webhook/normalize';
import { eventHealth } from './alertmanager-webhook/health';

export function alertmanagerWebhookRoutes(deps: AlertmanagerWebhookDeps): Hono {
  const router = new Hono();
  router.post('/:webhookKey', async (c) => {
    const webhookKey = c.req.param('webhookKey');
    if (!UUID_RE.test(webhookKey)) return c.json({ error: 'not found' }, 404);
    const rows = await deps.adminDb
      .select({
        id: connectorConfigs.id,
        tenantId: connectorConfigs.tenantId,
        settings: connectorConfigs.settings,
        enabled: connectorConfigs.enabled,
        lifecycleVersion: connectorConfigs.lifecycleVersion,
      })
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.webhookKey, webhookKey),
          eq(connectorConfigs.type, 'prometheus'),
          isNull(connectorConfigs.deletedAt),
        ),
      )
      .limit(1);
    const connector = rows[0];
    if (!connector) return c.json({ error: 'not found' }, 404);
    const attemptedAt = new Date();
    const eventCredential = await deps.secrets.get(
      connector.tenantId,
      connectorEventCredentialKey(connector.id),
    );
    const expectedToken = alertmanagerEventToken(eventCredential);
    const supplied = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    if (!expectedToken || !sameSecret(supplied, expectedToken)) {
      await eventHealth(
        deps,
        connector.tenantId,
        connector.id,
        attemptedAt,
        'authentication_failed',
      );
      return c.json({ error: 'authentication failed' }, 401);
    }
    const connectorSettings = parseWebhookPrometheusSettings(connector.settings);
    if (!connectorSettings || connectorSettings.eventTransport === 'none') {
      await eventHealth(
        deps,
        connector.tenantId,
        connector.id,
        attemptedAt,
        'event_delivery_disabled',
      );
      return c.json({ error: 'Alertmanager event delivery is disabled' }, 409);
    }
    if (!connector.enabled) {
      await eventHealth(deps, connector.tenantId, connector.id, attemptedAt, 'connector_disabled');
      return c.json({ error: 'data source is disabled' }, 409);
    }

    let raw: string;
    try {
      raw = await readBoundedWebhookBody(c.req.raw, MAX_WEBHOOK_BYTES);
    } catch (error) {
      if (!(error instanceof WebhookPayloadTooLargeError)) throw error;
      await eventHealth(deps, connector.tenantId, connector.id, attemptedAt, 'payload_too_large');
      return c.json({ error: 'payload too large' }, 413);
    }
    let payload: Record<string, unknown>;
    try {
      payload = object(JSON.parse(raw));
    } catch {
      await eventHealth(deps, connector.tenantId, connector.id, attemptedAt, 'invalid_json');
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (payload.version !== '4' || !Array.isArray(payload.alerts)) {
      await eventHealth(deps, connector.tenantId, connector.id, attemptedAt, 'invalid_payload');
      return c.json({ error: 'Alertmanager webhook version 4 is required' }, 400);
    }
    if (Number(payload.truncatedAlerts ?? 0) > 0) {
      await eventHealth(deps, connector.tenantId, connector.id, attemptedAt, 'truncated_payload');
      return c.json({ error: 'truncated Alertmanager notifications are not accepted' }, 422);
    }
    if (payload.alerts.length === 0 || payload.alerts.length > MAX_ALERTS) {
      await eventHealth(deps, connector.tenantId, connector.id, attemptedAt, 'invalid_alert_count');
      return c.json({ error: 'invalid alert count' }, 400);
    }
    const rawGroupKey = string(payload.groupKey);
    const rawExternalUrl = string(payload.externalURL);
    // The provider group key duplicates arbitrary label values. Its digest preserves stable provenance
    // without persisting a second unsanitized copy of alert metadata.
    const groupKey = rawGroupKey ? `sha256:${hash(rawGroupKey)}` : null;
    const externalUrl = rawExternalUrl ? sanitizeProviderUrl(rawExternalUrl, expectedToken) : null;
    if (
      !rawGroupKey ||
      rawGroupKey.length > 16_384 ||
      !groupKey ||
      (externalUrl?.length ?? 0) > 8_192
    ) {
      await eventHealth(
        deps,
        connector.tenantId,
        connector.id,
        attemptedAt,
        'invalid_group_metadata',
      );
      return c.json({ error: 'invalid Alertmanager group metadata' }, 400);
    }
    const alerts = payload.alerts.map((alert) => normalizeAlert(alert, expectedToken));
    if (alerts.some((alert) => alert === null)) {
      await eventHealth(deps, connector.tenantId, connector.id, attemptedAt, 'invalid_alert');
      return c.json({ error: 'invalid Alertmanager alert' }, 400);
    }

    try {
      const outcomes = [];
      for (const alert of alerts as NormalizedAlert[]) {
        outcomes.push(
          await processAlert(deps, connector, groupKey, externalUrl, alert, attemptedAt),
        );
      }
      if (outcomes.includes('unsubscribed')) {
        await eventHealth(
          deps,
          connector.tenantId,
          connector.id,
          attemptedAt,
          'channel_unsubscribed',
        );
        return c.json({ error: 'Alertmanager destination channel is not subscribed' }, 503);
      }
      const retry = outcomes.filter((outcome) => outcome === 'retry').length;
      if (retry > 0) {
        await eventHealth(
          deps,
          connector.tenantId,
          connector.id,
          attemptedAt,
          'processing_in_progress',
        );
        deps.log?.info('Alertmanager webhook requires retry', {
          tenantId: connector.tenantId,
          connectorId: connector.id,
          alerts: outcomes.length,
          retry,
        });
        return c.json({ accepted: false, alerts: outcomes.length, retry }, 503);
      }
      const deferred = outcomes.includes('deferred');
      await eventHealth(deps, connector.tenantId, connector.id, attemptedAt, undefined, deferred);
      const deferredCount = outcomes.filter((outcome) => outcome === 'deferred').length;
      deps.log?.info(deferred ? 'Alertmanager webhook deferred' : 'Alertmanager webhook accepted', {
        tenantId: connector.tenantId,
        connectorId: connector.id,
        alerts: outcomes.length,
        deferred: deferredCount,
      });
      return c.json(
        {
          accepted: !deferred,
          alerts: outcomes.length,
          deferred: deferredCount,
        },
        deferred ? 202 : 200,
      );
    } catch (error) {
      const failureCategory =
        error instanceof SlackApiError ? `slack_${error.code}` : 'processing_failed';
      await eventHealth(deps, connector.tenantId, connector.id, attemptedAt, failureCategory);
      deps.log?.error('Alertmanager webhook processing failed', {
        tenantId: connector.tenantId,
        connectorId: connector.id,
        failureCategory,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return c.json({ error: 'Alertmanager notification processing failed' }, 503);
    }
  });
  return router;
}
