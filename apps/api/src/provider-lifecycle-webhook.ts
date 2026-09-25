import { redactInput, scrubSecrets } from '@sre/agent-tools';
import { processAlert } from '@sre/alerts';
import { alertmanagerEventToken, defaultRegistry, type ConnectorRegistry } from '@sre/connectors';
import { connectorConfigs, connectorCredentialKey, connectorEventCredentialKey } from '@sre/db';
import { SlackApiError } from '@sre/surfaces';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AlertmanagerWebhookDeps } from './alertmanager-webhook';
import {
  MAX_WEBHOOK_BYTES,
  UUID_RE,
  hash,
  object,
  sameSecret,
  sanitizeProviderUrl,
} from './alertmanager-webhook/normalize';
import { eventHealth } from './alertmanager-webhook/health';
import { readBoundedWebhookBody, WebhookPayloadTooLargeError } from './webhook-body';

/** Authenticated native lifecycle transport using the existing durable provider intake. */
export function providerLifecycleWebhookRoutes(
  deps: AlertmanagerWebhookDeps,
  provider: 'datadog' | 'grafana',
  registry: ConnectorRegistry = defaultRegistry(),
): Hono {
  const router = new Hono();
  router.post('/:webhookKey', async (c) => {
    const key = c.req.param('webhookKey');
    if (!UUID_RE.test(key)) return c.json({ error: 'not found' }, 404);
    const [row] = await deps.adminDb
      .select()
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.webhookKey, key),
          eq(connectorConfigs.type, provider),
          isNull(connectorConfigs.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    const attemptedAt = new Date();
    const token = alertmanagerEventToken(
      await deps.secrets.get(row.tenantId, connectorEventCredentialKey(row.id)),
    );
    const supplied = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
    if (!token || !sameSecret(supplied, token)) {
      return c.json({ error: 'authentication failed' }, 401);
    }
    if (!row.enabled || object(row.settings).eventTransport !== 'direct')
      return c.json({ error: 'event delivery disabled' }, 409);
    let payload: unknown;
    try {
      payload = JSON.parse(await readBoundedWebhookBody(c.req.raw, MAX_WEBHOOK_BYTES));
    } catch (error) {
      return c.json(
        { error: 'invalid body' },
        error instanceof WebhookPayloadTooLargeError ? 413 : 400,
      );
    }
    const credential = await deps.secrets.get(row.tenantId, connectorCredentialKey(row.id));
    const connector = registry.create({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      type: provider,
      settings: object(row.settings),
      getCredential: async () => credential ?? '',
    });
    const result = await connector.alertLifecycle?.normalizeEvent?.(payload);
    // A well-formed event the platform does not act on is a healthy delivery, not a failure.
    if (result?.status === 'ignored') {
      await eventHealth(deps, row.tenantId, row.id, attemptedAt, undefined, false, true);
      return c.json({ accepted: true, ignored: true, reason: result.reason }, 200);
    }
    if (!result || result.status !== 'verified') {
      const reason = result?.reason ?? 'lifecycle_unsupported';
      await eventHealth(deps, row.tenantId, row.id, attemptedAt, reason);
      return c.json({ error: reason }, reason === 'provider_read_failed' ? 503 : 422);
    }
    try {
      const outcomes = [];
      for (const observation of result.observations) {
        const clean = (value: Record<string, string>) =>
          redactInput(
            Object.fromEntries(
              Object.entries(value).map(([name, text]) => [
                name,
                scrubSecrets(text.split(token).join('[REDACTED]')),
              ]),
            ),
          ) as Record<string, string>;
        outcomes.push(
          await processAlert(
            deps,
            row,
            `sha256:${hash(observation.monitorIdentity)}`,
            null,
            {
              ...observation,
              monitorIdentity: hash(observation.monitorIdentity),
              labels: clean(observation.labels),
              annotations: clean(observation.annotations),
              alertName: scrubSecrets(observation.alertName.split(token).join('[REDACTED]')),
              generatorUrl: observation.generatorUrl
                ? sanitizeProviderUrl(observation.generatorUrl, token)
                : null,
            },
            attemptedAt,
          ),
        );
      }
      const deferred = outcomes.some((value) => value !== 'accepted' && value !== 'acknowledged');
      const acknowledgedOnly = outcomes.every((value) => value === 'acknowledged');
      // Nothing re-drives a parked intake, so these must not read as delivered. Binding
      // conflicts stay 202 because a replay fails the same way until an operator acts.
      const redeliver = outcomes.includes('unsubscribed') || outcomes.includes('retry');
      const reason = outcomes.includes('native_cycle_association_required')
        ? 'native_cycle_association_required'
        : outcomes.includes('binding_episode_mismatch')
          ? 'binding_episode_mismatch'
          : outcomes.includes('conflicting_episode_times')
            ? 'conflicting_episode_times'
            : outcomes.includes('unsubscribed')
              ? 'alert_channel_not_subscribed'
              : deferred
                ? 'episode_processing_pending'
                : undefined;
      await eventHealth(
        deps,
        row.tenantId,
        row.id,
        attemptedAt,
        reason,
        deferred,
        acknowledgedOnly,
      );
      return c.json(
        {
          accepted: !deferred,
          alerts: outcomes.length,
          ...(reason
            ? {
                reason,
                nextStep:
                  reason === 'native_cycle_association_required'
                    ? 'Enter the cycle key from this Datadog webhook delivery in the legacy binding, preview and bind it, then replay the authenticated Triggered delivery.'
                    : reason === 'binding_episode_mismatch'
                      ? 'Inspect the exact bound cycle start and replay the corrected authenticated Triggered delivery; no new incident has been created from this conflicting trigger.'
                      : reason === 'conflicting_episode_times'
                        ? 'Inspect the provider cycle timestamps and replay a corrected authenticated recovery for this exact cycle.'
                        : reason === 'alert_channel_not_subscribed'
                          ? 'Subscribe the configured Slack alert channel, then replay the authenticated delivery.'
                          : 'Inspect retained provider intake diagnostics.',
              }
            : {}),
        },
        redeliver ? 503 : deferred ? 202 : 200,
      );
    } catch (error) {
      const failureCategory =
        error instanceof SlackApiError ? `slack_${error.code}` : 'processing_failed';
      await eventHealth(deps, row.tenantId, row.id, attemptedAt, failureCategory);
      deps.log?.error('Provider lifecycle webhook processing failed', {
        tenantId: row.tenantId,
        connectorId: row.id,
        provider,
        failureCategory,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return c.json({ error: 'provider processing failed' }, 503);
    }
  });
  return router;
}
