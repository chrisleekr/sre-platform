import { alertmanagerEventToken, statusCakeMonitorBound } from '@sre/connectors';
import { connectorConfigs, connectorEventCredentialKey } from '@sre/db';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AlertmanagerWebhookDeps } from './alertmanager-webhook';
import { UUID_RE, sameSecret } from './alertmanager-webhook/normalize';
import { readBoundedWebhookBody } from './webhook-body';

/** StatusCake notifications wake exact API verification; their text and diagnostic codes are advisory. */
export function statusCakeLifecycleWebhookRoutes(deps: AlertmanagerWebhookDeps): Hono {
  const router = new Hono();
  router.on(['GET', 'POST'], '/:webhookKey/:monitorId', async (c) => {
    const key = c.req.param('webhookKey');
    const monitorId = c.req.param('monitorId');
    if (!UUID_RE.test(key) || !/^[A-Za-z0-9_-]+$/.test(monitorId))
      return c.json({ error: 'not found' }, 404);
    const [row] = await deps.adminDb
      .select()
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.webhookKey, key),
          eq(connectorConfigs.type, 'statuscake'),
          isNull(connectorConfigs.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: 'not found' }, 404);
    let token: string;
    try {
      token =
        c.req.method === 'GET'
          ? (c.req.query('Token') ?? '')
          : (new URLSearchParams(await readBoundedWebhookBody(c.req.raw, 16_384)).get('Token') ??
            '');
    } catch {
      return c.json({ error: 'invalid body' }, 400);
    }
    const expected = alertmanagerEventToken(
      await deps.secrets.get(row.tenantId, connectorEventCredentialKey(row.id)),
    );
    if (!expected || !sameSecret(token, expected))
      return c.json({ error: 'authentication failed' }, 401);
    if (!row.enabled || !statusCakeMonitorBound(row.settings, monitorId))
      return c.json({ error: 'monitor binding disabled' }, 409);
    const enqueue = deps.enqueueLifecycle;
    if (!enqueue) return c.json({ error: 'lifecycle queue unavailable' }, 503);
    // Every wakeup keeps its own job: the provider read is bounded by observedAt, so folding a later
    // notification into an earlier job would hide the transition it reports.
    try {
      await enqueue(row.tenantId, {
        connectorId: row.id,
        monitorId,
        observedAt: new Date().toISOString(),
        lifecycleVersion: row.lifecycleVersion,
      });
    } catch {
      // Answer non-2xx so a retrying sender can redeliver; nothing was persisted.
      return c.json({ error: 'wakeup not persisted' }, 503);
    }
    return c.json({ accepted: true }, 202);
  });
  return router;
}
