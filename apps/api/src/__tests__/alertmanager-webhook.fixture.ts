import { alertmanagerEventCredential } from '@sre/connectors';
import {
  alertCohortMembers,
  alertCohorts,
  alertEpisodeIntakes,
  connectorConfigs,
  connectorEventCredentialKey,
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  jobs,
  signalDispositions,
  tenantSignalPolicies,
  makeDb,
  makeSecretStore,
  surfaceBindings,
  surfaceConfigs,
  surfaceDeliveries,
  tenantSecrets,
  tenants,
  upsertSurfaceConfig,
  withTenant,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import { SlackApiError } from '@sre/surfaces';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { alertmanagerWebhookRoutes } from '../alertmanager-webhook';

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL!;

  const APP_URL = process.env.APP_DATABASE_URL!;

  const VALKEY_URL = process.env.VALKEY_URL!;

  const KEY = Buffer.alloc(32, 11).toString('base64');

  const EVENT_TOKEN = 'alertmanager-webhook-test-token-32-bytes';

  let admin: DbHandle;

  let app: DbHandle;

  let redis: Redis;

  let tenantId: string;

  let connectorId: string;

  let webhookKey: string;

  let api: Hono;

  let concurrentRootGate: { started: () => void; waitForRelease: Promise<void> } | undefined;

  const postRoot = vi.fn(async (_tenantId: string, _channel: string, text: string) => {
    if (text.includes('UncertainRoot'))
      throw new SlackApiError('uncertain', 'transport_failure', 'request outcome unknown');
    if (text.includes('ConcurrentRoot') && concurrentRootGate) {
      concurrentRootGate.started();
      await concurrentRootGate.waitForRelease;
    }
    return `1788000000.${String(postRoot.mock.calls.length).padStart(6, '0')}`;
  });

  const providerFingerprint = (label: string): string =>
    createHash('sha256').update(label).digest('hex').slice(0, 16);

  function payload(
    fingerprint: string,
    startsAt: string,
    over: {
      status?: 'firing' | 'resolved';
      alertName?: string;
      description?: string;
      severity?: string;
      instance?: string;
      deploymentRevision?: string;
      endsAt?: string;
      generatorUrl?: string;
      monitorId?: string;
    } = {},
  ) {
    const status = over.status ?? 'firing';
    return {
      version: '4',
      groupKey: '{}:{alertname="CheckoutHighErrors"}',
      truncatedAlerts: 0,
      status,
      receiver: 'sre-platform',
      groupLabels: {},
      commonLabels: {},
      commonAnnotations: {},
      externalURL: 'https://alertmanager.example',
      alerts: [
        {
          status,
          labels: {
            alertname: over.alertName ?? 'CheckoutHighErrors',
            service: 'checkout',
            severity: over.severity ?? 'warning',
            ...(over.monitorId ? { sre_monitor_id: over.monitorId } : {}),
            ...(over.instance ? { instance: over.instance } : {}),
          },
          annotations: {
            summary: over.alertName ?? 'Checkout error rate is high',
            description: over.description ?? 'Five percent of requests are failing.',
            ...(over.deploymentRevision ? { deployment_revision: over.deploymentRevision } : {}),
          },
          startsAt,
          endsAt: over.endsAt ?? '0001-01-01T00:00:00Z',
          generatorURL:
            over.generatorUrl ?? 'https://prometheus.example/graph?g0.expr=checkout_errors',
          fingerprint: providerFingerprint(fingerprint),
        },
      ],
    };
  }

  function deliver(body: Record<string, unknown>, token = EVENT_TOKEN) {
    return api.request(`/webhooks/alertmanager/${webhookKey}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
    tenantId = randomUUID();
    connectorId = randomUUID();
    webhookKey = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'Alertmanager webhook tenant' });
    await withTenant(app.db, tenantId, (tx) =>
      tx.insert(connectorConfigs).values({
        id: connectorId,
        tenantId,
        name: 'Production Prometheus',
        type: 'prometheus',
        webhookKey,
        settings: {
          baseUrl: 'https://prometheus.example',
          authType: 'none',
          eventTransport: 'direct',
          alertChannel: 'C07ALERTS',
          cohortWindowSec: 120,
        },
        enabled: true,
      }),
    );
    await upsertSurfaceConfig(app.db, tenantId, { surface: 'slack' });
    const secrets = makeSecretStore(app.db, KEY);
    await secrets.put(
      tenantId,
      connectorEventCredentialKey(connectorId),
      alertmanagerEventCredential(EVENT_TOKEN),
    );
    const queue = new Queue(admin.db, redis);
    const hub = new ConversationHub(app.db, redis);
    api = new Hono();
    api.route(
      '/webhooks/alertmanager',
      alertmanagerWebhookRoutes({
        adminDb: admin.db,
        appDb: app.db,
        secrets,
        route: {
          appDb: app.db,
          redis,
          queue,
          appendOpenerTx: async (tx, scopedTenantId, incidentId, opener, observed) => {
            const opened = await hub.appendTxOnce(tx, scopedTenantId, incidentId, {
              ...opener,
              ...(observed
                ? {
                    kind: 'signal' as const,
                    signalId: observed.id,
                    signalState: observed.state,
                    signalEventType: observed.eventType,
                  }
                : {}),
            });
            const lifecycle = await hub.appendTxOnce(tx, scopedTenantId, incidentId, {
              author: 'system',
              kind: 'lifecycle',
              content: 'Incident open: alert accepted for investigation.',
              lifecycleFrom: null,
              lifecycleTo: 'open',
              lifecycleVersion: 0,
              transitionKey: `incident-open:${incidentId}:0`,
            });
            return {
              incidentId,
              afterCommit: async () => {
                await hub.publishAppended(opened.message);
                await hub.publishAppended(lifecycle.message);
              },
            };
          },
        },
        hub,
        postAlertRoot: postRoot,
      }),
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(surfaceDeliveries).where(eq(surfaceDeliveries.tenantId, tenantId));
      await admin.db.delete(alertCohortMembers).where(eq(alertCohortMembers.tenantId, tenantId));
      await admin.db.delete(incidentRelations).where(eq(incidentRelations.tenantId, tenantId));
      await admin.db.delete(alertEpisodeIntakes).where(eq(alertEpisodeIntakes.tenantId, tenantId));
      await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
      await admin.db.delete(alertCohorts).where(eq(alertCohorts.tenantId, tenantId));
      await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
      await admin.db.delete(surfaceBindings).where(eq(surfaceBindings.tenantId, tenantId));
      await admin.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
      await admin.db.delete(signalDispositions).where(eq(signalDispositions.tenantId, tenantId));
      await admin.db
        .delete(tenantSignalPolicies)
        .where(eq(tenantSignalPolicies.tenantId, tenantId));
      await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
      await admin.db.delete(surfaceConfigs).where(eq(surfaceConfigs.tenantId, tenantId));
      await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
      await admin.db.delete(tenantSecrets).where(eq(tenantSecrets.tenantId, tenantId));
      await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
      await admin.close();
    }
    if (app) await app.close();
    if (redis) await redis.quit();
  });

  test.each([
    {
      name: 'oversized body',
      status: 413,
      request: () =>
        api.request(`/webhooks/alertmanager/${webhookKey}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${EVENT_TOKEN}`,
            'content-type': 'application/json',
          },
          body: 'x'.repeat(2 * 1024 * 1024 + 1),
        }),
    },
    {
      name: 'invalid JSON',
      status: 400,
      request: () =>
        api.request(`/webhooks/alertmanager/${webhookKey}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${EVENT_TOKEN}`,
            'content-type': 'application/json',
          },
          body: '{',
        }),
    },
    {
      name: 'non-v4 payload',
      status: 400,
      request: () =>
        deliver({ ...payload('fingerprint-version', '2026-08-26T02:13:00Z'), version: '3' }),
    },
    {
      name: 'truncated notification',
      status: 422,
      request: () =>
        deliver({
          ...payload('fingerprint-truncated', '2026-08-26T02:14:00Z'),
          truncatedAlerts: 1,
        }),
    },
    {
      name: 'empty alert list',
      status: 400,
      request: () =>
        deliver({ ...payload('fingerprint-empty', '2026-08-26T02:15:00Z'), alerts: [] }),
    },
    {
      name: 'excessive alert list',
      status: 400,
      request: () => {
        const body = payload('fingerprint-many', '2026-08-26T02:16:00Z');
        body.alerts = Array.from({ length: 501 }, () => ({ ...body.alerts[0]! }));
        return deliver(body);
      },
    },
  ])('rejects $name without creating incident work', async ({ status, request }) => {
    const snapshot = async () =>
      withTenant(app.db, tenantId, async (tx) => ({
        intakes: (await tx.select({ id: alertEpisodeIntakes.id }).from(alertEpisodeIntakes)).length,
        signals: (await tx.select({ id: incidentSignals.id }).from(incidentSignals)).length,
        incidents: (await tx.select({ id: incidents.id }).from(incidents)).length,
        bindings: (await tx.select({ id: surfaceBindings.id }).from(surfaceBindings)).length,
        messages: (await tx.select({ id: incidentMessages.id }).from(incidentMessages)).length,
        jobs: (await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.tenantId, tenantId)))
          .length,
      }));
    const before = await snapshot();
    const postsBefore = postRoot.mock.calls.length;

    expect((await request()).status).toBe(status);
    expect(await snapshot()).toEqual(before);
    expect(postRoot).toHaveBeenCalledTimes(postsBefore);
  });

  return {
    ADMIN_URL,
    APP_URL,
    VALKEY_URL,
    KEY,
    EVENT_TOKEN,
    get admin() {
      return admin;
    },
    set admin(value: typeof admin) {
      admin = value;
    },
    get app() {
      return app;
    },
    set app(value: typeof app) {
      app = value;
    },
    get redis() {
      return redis;
    },
    set redis(value: typeof redis) {
      redis = value;
    },
    get tenantId() {
      return tenantId;
    },
    set tenantId(value: typeof tenantId) {
      tenantId = value;
    },
    get connectorId() {
      return connectorId;
    },
    set connectorId(value: typeof connectorId) {
      connectorId = value;
    },
    get webhookKey() {
      return webhookKey;
    },
    set webhookKey(value: typeof webhookKey) {
      webhookKey = value;
    },
    get api() {
      return api;
    },
    set api(value: typeof api) {
      api = value;
    },
    get concurrentRootGate() {
      return concurrentRootGate;
    },
    set concurrentRootGate(value: typeof concurrentRootGate) {
      concurrentRootGate = value;
    },
    postRoot,
    providerFingerprint,
    payload,
    deliver,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
