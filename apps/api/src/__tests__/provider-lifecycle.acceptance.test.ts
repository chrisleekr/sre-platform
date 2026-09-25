import { makeDbAuditSink, makeDbConnectorProvider } from '@sre/agent-tools';
import {
  connectorLifecycleHandlers,
  ingestStatusCakeWakeup,
} from '../../../triage-worker/src/connector-lifecycle';
import { makePollHandler } from '../../../triage-worker/src/poller';
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, test, vi } from 'vitest';
import { and, eq, desc, sql } from 'drizzle-orm';
import {
  alertmanagerEventCredential,
  ConnectorRegistry,
  makeStatusCakeConnector,
  statusCakeConnectorDefinition,
} from '@sre/connectors';
import {
  alertEpisodeIntakes,
  investigationRuns,
  connectorConfigs,
  connectorEventCredentialKey,
  connectorCredentialKey,
  incidentSignals,
  incidents,
  jobs,
} from '@sre/db';
import { providerLifecycleWebhookRoutes } from '../provider-lifecycle-webhook';
import { statusCakeLifecycleWebhookRoutes } from '../statuscake-lifecycle-webhook';
import { createFixture } from './alertmanager-webhook.fixture';
import { TriageWorker } from '../../../triage-worker/src/worker';
import { makeFakeEngine } from '../../../triage-worker/src/engine/fake';
import { makeRedisLock } from '../../../triage-worker/src/lock';
import { responderGenerator } from '../../../triage-worker/src/__tests__/responder-generator.fixture';
import type { Queue, Job } from '@sre/queue';

const fixture = createFixture();
const now = Date.now();
const start = new Date(now - 600_000).toISOString();
const end = new Date(now - 60_000).toISOString();
let recovered = false;
let unavailable = false;
const requests: string[] = [];
const statusCakeFetch = (async (url: string | URL | Request) => {
  if (unavailable) throw new Error('provider unavailable');
  const path = new URL(String(url)).pathname;
  requests.push(String(url));
  if (path.endsWith('/periods'))
    return Response.json({
      data: recovered
        ? [
            {
              created_at: new Date(Date.parse(start) - 30000).toISOString(),
              ended_at: end,
              status: 'down',
              duration: 540000,
            },
          ]
        : [],
      links: {},
    });
  if (path.endsWith('/alerts'))
    return Response.json({
      data: [
        {
          id: 'alert-74',
          status: 'down',
          status_code: 0,
          triggered_at: new Date(Date.parse(start) + 10000).toISOString(),
        },
        { id: 'alert-73', status: 'down', status_code: 0, triggered_at: start },
        {
          id: 'alert-72',
          status: 'up',
          status_code: 200,
          triggered_at: new Date(now - 700_000).toISOString(),
        },
      ],
      links: {},
    });
  return Response.json({
    data: {
      id: '73',
      name: 'Checkout timeout',
      status: recovered ? 'up' : 'down',
      paused: false,
      website_url: 'https://checkout.example',
    },
  });
}) as typeof fetch;

function statusCakeRegistry() {
  return new ConnectorRegistry([
    {
      ...statusCakeConnectorDefinition,
      create: (config) => makeStatusCakeConnector(config, statusCakeFetch),
    },
  ]);
}

beforeAll(() => {
  for (const provider of ['datadog', 'grafana'] as const)
    fixture.api.route(
      `/webhooks/${provider}`,
      providerLifecycleWebhookRoutes(fixture.webhookDeps, provider),
    );
  fixture.api.route('/webhooks/statuscake', statusCakeLifecycleWebhookRoutes(fixture.webhookDeps));
});

async function connector(type: 'datadog' | 'grafana' | 'statuscake') {
  const id = randomUUID();
  await fixture.admin.db.insert(connectorConfigs).values({
    id,
    tenantId: fixture.tenantId,
    type,
    name: `${type}-${id}`,
    enabled: true,
    webhookKey: id,
    settings: { eventTransport: 'direct', alertChannel: 'C07ALERTS', uptimeMonitorIds: ['73'] },
  });
  await fixture.webhookDeps.secrets.put(
    fixture.tenantId,
    connectorEventCredentialKey(id),
    alertmanagerEventCredential(fixture.EVENT_TOKEN),
  );
  await fixture.webhookDeps.secrets.put(
    fixture.tenantId,
    connectorCredentialKey(id),
    'fixture-read-only-bearer',
  );
  return id;
}
async function deliver(type: string, id: string, payload: unknown, token = fixture.EVENT_TOKEN) {
  return fixture.api.request(`/webhooks/${type}/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
async function signals(id: string) {
  return fixture.admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.dataSourceId, id));
}
async function resolveWithoutAi(incidentId: string) {
  const [job] = await fixture.admin.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, fixture.tenantId),
        eq(jobs.type, 'recovery.verify'),
        sql`${jobs.payload}->>'incidentId' = ${incidentId}`,
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  expect(job, 'native intake must enqueue durable recovery without classification').toBeDefined();
  const verifyRecovery = vi.fn(async () => {
    throw new Error('AI provider unavailable');
  });
  const investigate = vi.fn(async () => {
    throw new Error('AI provider unavailable');
  });
  const getAutomaticInvestigationBudget = vi.fn(async () => {
    throw new Error('AI admission unavailable');
  });
  const queue = fixture.webhookDeps.route.queue as Queue;
  const worker = new TriageWorker({
    appDb: fixture.app.db,
    hub: fixture.webhookDeps.hub,
    queue,
    engine: { ...makeFakeEngine(), verifyRecovery, investigate },
    generator: responderGenerator(),
    auditSink: makeDbAuditSink({ db: fixture.app.db }),
    connectorProvider: () => async () => [],
    tools: [],
    lock: makeRedisLock(fixture.redis),
    clearResumeGate: (id) => queue.clearResumeGate(id),
    getAutomaticInvestigationBudget,
  });
  await worker.handle(job as Job, { signal: new AbortController().signal });
  await worker.handle(job as Job, { signal: new AbortController().signal });
  expect(verifyRecovery).not.toHaveBeenCalled();
  expect(investigate).not.toHaveBeenCalled();
  expect(getAutomaticInvestigationBudget).not.toHaveBeenCalled();
  expect(
    await fixture.admin.db
      .select()
      .from(investigationRuns)
      .where(eq(investigationRuns.incidentId, incidentId)),
  ).toHaveLength(0);
  const [resolved] = await fixture.admin.db
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId));
  expect(resolved).toMatchObject({ status: 'resolved', resolutionBasis: 'provider_clear' });
  expect(
    (await fixture.webhookDeps.hub.history(fixture.tenantId, incidentId)).filter(
      (message) => message.kind === 'lifecycle' && message.lifecycleTo === 'resolved',
    ),
  ).toHaveLength(1);
}

test('authenticated Grafana per-alert state resolves without classification or AI and cannot clear a refire', async () => {
  const id = await connector('grafana');
  const fire = { ...fixture.payload('grafana-active', start), version: '1' };
  expect((await deliver('grafana', id, fire, 'wrong-secret')).status).toBe(401);
  expect(await signals(id)).toHaveLength(0);
  expect((await deliver('grafana', id, fire)).status).toBe(200);
  const clear = {
    ...fixture.payload('grafana-active', start, { status: 'resolved', endsAt: end }),
    version: '1',
  };
  expect((await deliver('grafana', id, clear)).status).toBe(200);
  const [old] = await signals(id);
  expect(old).toMatchObject({
    state: 'resolved',
    provider: 'grafana',
    clearProvenance: 'provider',
  });
  await resolveWithoutAi(old!.incidentId);
  expect(
    (
      await deliver('grafana', id, {
        ...fixture.payload('grafana-active', new Date(now - 1000).toISOString()),
        version: '1',
      })
    ).status,
  ).toBe(200);
  expect((await deliver('grafana', id, clear)).status).toBe(200);
  expect((await signals(id)).filter((row) => row.state === 'firing')).toHaveLength(1);
  const classify = await fixture.admin.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.tenantId, fixture.tenantId), eq(jobs.type, 'classify')));
  expect(classify).toHaveLength(0);
});

test('Datadog recovery-before-trigger remains durable without a fabricated start and clears only its opaque cycle', async () => {
  const id = await connector('datadog');
  const base = {
    alert_id: '127',
    alert_scope: 'host:checkout',
    alert_cycle_key: 'opaque-cycle-a',
    alert_title: 'Checkout unavailable',
  };
  const clear = { ...base, alert_transition: 'Recovered', date: String(Date.parse(end)) };
  expect((await deliver('datadog', id, clear)).status).toBe(202);
  expect((await deliver('datadog', id, clear)).status).toBe(202);
  expect(await signals(id)).toHaveLength(0);
  const pending = await fixture.admin.db
    .select()
    .from(alertEpisodeIntakes)
    .where(eq(alertEpisodeIntakes.dataSourceId, id));
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    startsAt: null,
    state: 'pending',
    observation: { status: 'resolved' },
  });
  expect(
    (
      await deliver('datadog', id, {
        ...base,
        alert_transition: 'Triggered',
        date: String(Date.parse(start)),
      })
    ).status,
  ).toBe(200);
  const [old] = await signals(id);
  expect(old).toMatchObject({ state: 'resolved', provider: 'datadog' });
  expect(old!.startsAt!.toISOString()).toBe(start);
  await resolveWithoutAi(old!.incidentId);
  expect(
    (
      await deliver('datadog', id, {
        ...base,
        alert_cycle_key: 'opaque-cycle-b',
        alert_transition: 'Triggered',
        date: String(now - 1000),
      })
    ).status,
  ).toBe(200);
  expect((await deliver('datadog', id, clear)).status).toBe(200);
  expect((await signals(id)).filter((row) => row.state === 'firing')).toHaveLength(1);
});

test('bound StatusCake code-zero outage uses documented alert history and recovers from period evidence without AI', async () => {
  recovered = false;
  const id = await connector('statuscake');
  const retained: unknown[] = [];
  fixture.webhookDeps.enqueueLifecycle = async (_tenantId, payload) => retained.push(payload);
  const handler = makePollHandler({
    connectorProvider: makeDbConnectorProvider({
      db: fixture.app.db,
      secrets: fixture.webhookDeps.secrets,
      registry: statusCakeRegistry(),
    }),
    ...connectorLifecycleHandlers({
      db: fixture.app.db,
      hub: fixture.webhookDeps.hub,
      queue: fixture.webhookDeps.route.queue,
      redis: fixture.redis,
      secrets: fixture.webhookDeps.secrets,
      postAlertRoot: fixture.postRoot,
    }),
    cache: { get: async () => [], set: async () => {} },
    ttlSec: 120,
  });
  // Each wake is persisted, then replayed by the poll worker, as in production.
  const wake = async () => {
    const response = await fixture.api.request(`/webhooks/statuscake/${id}/73`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        Token: fixture.EVENT_TOKEN,
        Status: 'Down',
        StatusCode: '0',
        Name: 'Arbitrary wording',
      }).toString(),
    });
    await handler({
      id: randomUUID(),
      tenantId: fixture.tenantId,
      type: 'poll',
      payload: retained.at(-1),
      attempts: 1,
    });
    return response;
  };
  try {
    expect((await wake()).status).toBe(202);
    const [signal] = await signals(id);
    expect(signal).toMatchObject({
      provider: 'statuscake',
      state: 'firing',
      labels: { monitor_id: '73' },
    });
    expect(signal!.startsAt!.toISOString()).toBe(start);
    expect((await wake()).status).toBe(202);
    expect(await signals(id)).toHaveLength(1);
    recovered = true;
    expect((await wake()).status).toBe(202);
    // A wakeup reads only its own monitor's firing state; recovery is applied by the scheduled
    // whole-connector reconcile.
    expect((await signals(id))[0]).toMatchObject({ state: 'firing' });
    await handler({
      id: randomUUID(),
      tenantId: fixture.tenantId,
      type: 'poll',
      payload: { connectorId: id },
      attempts: 1,
    });
    expect((await signals(id))[0]).toMatchObject({
      state: 'resolved',
      clearProvenance: 'provider',
    });
    await resolveWithoutAi(signal!.incidentId);
    expect(
      requests
        .filter((url) => url.includes('/periods'))
        .every((url) => url.includes('limit=100') && !url.includes('per_page=')),
    ).toBe(true);
  } finally {
    delete fixture.webhookDeps.enqueueLifecycle;
  }
});

test('StatusCake verification outage retains a secret-free wakeup that the poll worker can replay without AI', async () => {
  recovered = false;
  unavailable = true;
  const id = await connector('statuscake');
  fixture.webhookDeps.enqueueLifecycle = async (tenantId, payload) =>
    fixture.webhookDeps.route.queue.enqueue({ tenantId, type: 'poll', payload });
  try {
    const response = await fixture.api.request(
      `/webhooks/statuscake/${id}/73?Token=${fixture.EVENT_TOKEN}`,
    );
    expect(response.status).toBe(202);
    expect(await signals(id)).toHaveLength(0);
    const pending = (
      await fixture.admin.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.tenantId, fixture.tenantId), eq(jobs.type, 'poll')))
    ).find((job) => (job.payload as { connectorId?: string }).connectorId === id);
    expect(pending).toBeDefined();
    expect(JSON.stringify(pending!.payload)).not.toContain(fixture.EVENT_TOKEN);
    expect(pending!.payload).toMatchObject({
      connectorId: id,
      monitorId: '73',
      lifecycleVersion: 0,
    });
    unavailable = false;
    const source = (
      await makeDbConnectorProvider({
        db: fixture.app.db,
        secrets: fixture.webhookDeps.secrets,
        registry: statusCakeRegistry(),
      })(fixture.tenantId)()
    ).find((row) => row.id === id)!;
    await ingestStatusCakeWakeup(
      {
        db: fixture.app.db,
        hub: fixture.webhookDeps.hub,
        queue: fixture.webhookDeps.route.queue,
        redis: fixture.redis,
        secrets: fixture.webhookDeps.secrets,
        postAlertRoot: fixture.postRoot,
      },
      fixture.tenantId,
      source,
      pending!.payload as { monitorId: string; observedAt: string; lifecycleVersion: number },
    );
    expect(await signals(id)).toEqual([
      expect.objectContaining({ provider: 'statuscake', state: 'firing' }),
    ]);
    const count = fixture.postRoot.mock.calls.length;
    await ingestStatusCakeWakeup(
      {
        db: fixture.app.db,
        hub: fixture.webhookDeps.hub,
        queue: fixture.webhookDeps.route.queue,
        redis: fixture.redis,
        secrets: fixture.webhookDeps.secrets,
        postAlertRoot: fixture.postRoot,
      },
      fixture.tenantId,
      source,
      pending!.payload as { monitorId: string; observedAt: string; lifecycleVersion: number },
    );
    expect(await signals(id)).toHaveLength(1);
    expect(fixture.postRoot).toHaveBeenCalledTimes(count);
  } finally {
    unavailable = false;
    delete fixture.webhookDeps.enqueueLifecycle;
  }
});

test('Datadog scopes reused cycle strings by monitor and group, and a late clear cannot resolve a newer firing', async () => {
  const id = await connector('datadog');
  const event = {
    alert_id: '127',
    alert_scope: '',
    alert_cycle_key: 'shared-cycle',
    alert_title: 'Simple monitor',
    alert_transition: 'Triggered',
    date: String(now - 600000),
  };
  expect((await deliver('datadog', id, event)).status).toBe(200);
  expect((await deliver('datadog', id, { ...event, alert_id: '128' })).status).toBe(200);
  expect((await deliver('datadog', id, { ...event, alert_scope: 'host:other' })).status).toBe(200);
  expect(
    (
      await deliver('datadog', id, {
        ...event,
        alert_cycle_key: 'new-cycle',
        date: String(now - 50000),
      })
    ).status,
  ).toBe(200);
  expect(await signals(id)).toHaveLength(4);
  expect(
    (
      await deliver('datadog', id, {
        ...event,
        alert_transition: 'Recovered',
        date: String(now - 60000),
      })
    ).status,
  ).toBe(200);
  const rows = await signals(id);
  expect(rows.filter((row) => row.state === 'resolved')).toHaveLength(1);
  expect(rows.filter((row) => row.state === 'firing')).toHaveLength(3);
  expect(rows.find((row) => row.startsAt?.getTime() === now - 50000)?.state).toBe('firing');
  expect(
    new Set(
      (
        await fixture.admin.db
          .select()
          .from(alertEpisodeIntakes)
          .where(eq(alertEpisodeIntakes.dataSourceId, id))
      ).map((row) => row.opaqueEpisodeKey),
    ).size,
  ).toBe(4);
});

test('a retained Datadog clear keeps its original generation across rotation until a fresh same-cycle clear arrives', async () => {
  const id = await connector('datadog');
  const base = {
    alert_id: '811',
    alert_scope: 'host:rotation',
    alert_cycle_key: 'rotation-cycle',
    alert_title: 'Pending cycle',
  };
  const clear = { ...base, alert_transition: 'Recovered', date: String(now - 60000) };
  expect((await deliver('datadog', id, clear)).status).toBe(202);
  await fixture.admin.db
    .update(connectorConfigs)
    .set({ lifecycleVersion: 1 })
    .where(eq(connectorConfigs.id, id));
  expect(
    (
      await deliver('datadog', id, {
        ...base,
        alert_transition: 'Triggered',
        date: String(now - 600000),
      })
    ).status,
  ).toBe(200);
  const [old] = await signals(id);
  expect(old?.signalSource?.lifecycleVersion).toBe(0);
  const [pending] = await fixture.admin.db
    .select()
    .from(alertEpisodeIntakes)
    .where(eq(alertEpisodeIntakes.dataSourceId, id));
  expect(pending?.observation.lifecycleVersion).toBe(0);
  const { listResponseGroupSignalsTx, serializeSignalFence, withTenant } = await import('@sre/db');
  const rows = await withTenant(fixture.app.db, fixture.tenantId, (tx) =>
    listResponseGroupSignalsTx(tx, fixture.tenantId, old!.incidentId),
  );
  await fixture.webhookDeps.hub.resolveProviderClear(
    fixture.tenantId,
    old!.incidentId,
    { lifecycleVersion: 0, signalFence: serializeSignalFence(rows) },
    randomUUID(),
  );
  expect(
    (await fixture.admin.db.select().from(incidents).where(eq(incidents.id, old!.incidentId)))[0]
      ?.status,
  ).toBe('open');
  expect((await deliver('datadog', id, clear)).status).toBe(200);
  expect((await signals(id))[0]?.signalSource?.lifecycleVersion).toBe(1);
  await resolveWithoutAi(old!.incidentId);
});

test.each(['datadog', 'grafana'] as const)(
  '%s authentication failures leave tenant connector health unchanged',
  async (provider) => {
    const id = await connector(provider);
    const [before] = await fixture.admin.db
      .select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, id));
    for (const token of ['wrong-secret', ''])
      expect((await deliver(provider, id, {}, token)).status).toBe(401);
    const [after] = await fixture.admin.db
      .select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, id));
    expect(after).toEqual(before);
  },
);
