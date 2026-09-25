import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeAll, expect, test, vi } from 'vitest';
import {
  ConnectorRegistry,
  alertmanagerEventCredential,
  makeStatusCakeConnector,
  statusCakeConnectorDefinition,
} from '@sre/connectors';
import { makeDbConnectorProvider } from '@sre/agent-tools';
import {
  alertEpisodeIntakes,
  connectorConfigs,
  connectorCredentialKey,
  connectorEventCredentialKey,
  incidentSignals,
  jobs,
} from '@sre/db';
import { NonRetryableError, Queue, RetryableError } from '@sre/queue';
import { SlackApiError } from '@sre/surfaces';
import { ingestStatusCakeWakeup } from '../../../triage-worker/src/connector-lifecycle';
import { statusCakeLifecycleWebhookRoutes } from '../statuscake-lifecycle-webhook';
import { createFixture } from './alertmanager-webhook.fixture';
const fixture = createFixture();
const start = new Date(Date.now() - 60000).toISOString();
let testName = 'Checkout';
const registry = new ConnectorRegistry([
  {
    ...statusCakeConnectorDefinition,
    create: (config) =>
      makeStatusCakeConnector(config, (async (input) => {
        const path = new URL(String(input)).pathname;
        return Response.json(
          path.endsWith('/periods')
            ? { data: [], links: {} }
            : path.endsWith('/alerts')
              ? { data: [{ status: 'down', triggered_at: start, status_code: 0 }], links: {} }
              : { data: { id: '73', name: testName, status: 'down', paused: false } },
        );
      }) as typeof fetch),
  },
]);
const enqueueWakeup: NonNullable<typeof fixture.webhookDeps.enqueueLifecycle> = (
  tenantId,
  payload,
) => fixture.webhookDeps.route.queue.enqueue({ tenantId, type: 'poll', payload });
beforeAll(() => {
  fixture.webhookDeps.enqueueLifecycle = enqueueWakeup;
  fixture.api.route('/webhooks/statuscake', statusCakeLifecycleWebhookRoutes(fixture.webhookDeps));
});
async function seed(
  channel = 'C07ALERTS',
  binding: Record<string, unknown> = { uptimeMonitorIds: ['73'] },
) {
  const id = randomUUID();
  await fixture.admin.db.insert(connectorConfigs).values({
    id,
    tenantId: fixture.tenantId,
    type: 'statuscake',
    name: id,
    webhookKey: id,
    settings: { eventTransport: 'direct', alertChannel: channel, ...binding },
    enabled: true,
  });
  await fixture.webhookDeps.secrets.put(
    fixture.tenantId,
    connectorCredentialKey(id),
    'read-bearer',
  );
  await fixture.webhookDeps.secrets.put(
    fixture.tenantId,
    connectorEventCredentialKey(id),
    alertmanagerEventCredential(fixture.EVENT_TOKEN),
  );
  const connector = (
    await makeDbConnectorProvider({
      db: fixture.app.db,
      secrets: fixture.webhookDeps.secrets,
      registry,
    })(fixture.tenantId)()
  ).find((source) => source.id === id)!;
  const wakeup = {
    connectorId: id,
    monitorId: '73',
    observedAt: new Date().toISOString(),
    lifecycleVersion: 0,
  };
  const ingest = () =>
    ingestStatusCakeWakeup(
      {
        db: fixture.app.db,
        hub: fixture.webhookDeps.hub,
        queue: fixture.webhookDeps.route.queue,
        redis: fixture.redis,
        secrets: fixture.webhookDeps.secrets,
        postAlertRoot: fixture.postRoot,
      },
      fixture.tenantId,
      connector,
      wakeup,
    );
  const deliver = (monitorId = '73') =>
    fixture.api.request(`/webhooks/statuscake/${id}/${monitorId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Token: fixture.EVENT_TOKEN }).toString(),
    });
  const health = async () =>
    (await fixture.admin.db.select().from(connectorConfigs).where(eq(connectorConfigs.id, id)))[0]!;
  const wakeups = async () =>
    (
      await fixture.admin.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.tenantId, fixture.tenantId), eq(jobs.type, 'poll')))
    ).filter((job) => (job.payload as { connectorId?: string }).connectorId === id);
  const signals = () =>
    fixture.admin.db.select().from(incidentSignals).where(eq(incidentSignals.dataSourceId, id));
  return { id, wakeup, ingest, deliver, health, wakeups, signals };
}
test('each authenticated wakeup persists its own poll job and reads no provider inline', async () => {
  const source = await seed();
  // The webhook has no path to the test registry, so a provider read would have to go through fetch.
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  try {
    const responses = await Promise.all(Array.from({ length: 5 }, () => source.deliver()));
    expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202, 202]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies).toEqual(Array.from({ length: 5 }, () => ({ accepted: true })));
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
  // One job per notification: each keeps its own lookup time, so no later transition is hidden.
  expect(await source.wakeups()).toHaveLength(5);
  expect(await source.signals()).toHaveLength(0);
});
test('a wakeup retained before a binding is read under the current generation', async () => {
  const source = await seed();
  // A binding between receipt and processing bumps the generation and keeps the connector enabled.
  await fixture.admin.db
    .update(connectorConfigs)
    .set({ lifecycleVersion: 1 })
    .where(eq(connectorConfigs.id, source.id));
  const current = (
    await makeDbConnectorProvider({
      db: fixture.app.db,
      secrets: fixture.webhookDeps.secrets,
      registry,
    })(fixture.tenantId)()
  ).find((connector) => connector.id === source.id)!;
  expect(current.generation?.lifecycleVersion).toBe(1);
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
    current,
    source.wakeup,
  );
  // The wakeup is the only copy of this outage; dropping it would never open the incident.
  expect(await source.signals()).toEqual([
    expect.objectContaining({ provider: 'statuscake', state: 'firing' }),
  ]);
});
test('a bump committed after the job resolved its connector makes the wakeup retryable', async () => {
  const source = await seed();
  await fixture.admin.db
    .update(connectorConfigs)
    .set({ lifecycleVersion: 1 })
    .where(eq(connectorConfigs.id, source.id));
  // source.ingest still holds the generation-0 connector the poll handler resolved.
  await expect(source.ingest()).rejects.toBeInstanceOf(RetryableError);
  expect(await source.signals()).toHaveLength(0);
});
test('a failed durable enqueue answers 503 and a redelivery persists the wakeup', async () => {
  const source = await seed();
  fixture.webhookDeps.enqueueLifecycle = async () => {
    throw new Error('postgres unavailable');
  };
  try {
    expect((await source.deliver()).status).toBe(503);
  } finally {
    fixture.webhookDeps.enqueueLifecycle = enqueueWakeup;
  }
  expect(await source.wakeups()).toHaveLength(0);
  const retry = await source.deliver();
  expect(retry.status).toBe(202);
  expect(await retry.json()).toEqual({ accepted: true });
  expect(await source.wakeups()).toHaveLength(1);
});
test('a missing lifecycle queue answers 503 and persists no wakeup', async () => {
  const source = await seed();
  delete fixture.webhookDeps.enqueueLifecycle;
  try {
    const response = await source.deliver();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'lifecycle queue unavailable' });
  } finally {
    fixture.webhookDeps.enqueueLifecycle = enqueueWakeup;
  }
  expect(await source.wakeups()).toHaveLength(0);
});
test('a secret-shaped StatusCake test name is scrubbed before the intake, signal and Slack root', async () => {
  const source = await seed();
  const credential = `ghp_${'b'.repeat(36)}`;
  testName = `Checkout ${credential}`;
  const posts = fixture.postRoot.mock.calls.length;
  try {
    await source.ingest();
  } finally {
    testName = 'Checkout';
  }
  const signals = await source.signals();
  expect(signals).toHaveLength(1);
  const intakes = await fixture.admin.db
    .select()
    .from(alertEpisodeIntakes)
    .where(eq(alertEpisodeIntakes.dataSourceId, source.id));
  const roots = fixture.postRoot.mock.calls.slice(posts);
  expect(roots).toHaveLength(1);
  const durable = JSON.stringify({ signals, intakes, roots });
  expect(durable).toContain('Checkout');
  expect(durable).not.toContain(credential);
  expect(await source.health()).toMatchObject({
    eventFailureCategory: null,
    eventCount: 1,
    eventSucceededAt: expect.any(Date),
  });
});
test('an unsubscribed destination is action-required once the queued wakeup is verified', async () => {
  const source = await seed('C_UNSUBSCRIBED');
  const response = await source.deliver();
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: true });
  expect(await source.wakeups()).toHaveLength(1);
  await expect(source.ingest()).rejects.toBeInstanceOf(NonRetryableError);
  expect((await source.health()).eventFailureCategory).toBe('alert_channel_not_subscribed');
  expect(
    await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.dataSourceId, source.id)),
  ).toHaveLength(0);
});
test('a concurrent root delivery keeps its wakeup queued for retry, then creates no duplicate root', async () => {
  const source = await seed();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const posts = fixture.postRoot.mock.calls.length;
  fixture.postRoot.mockImplementationOnce(async () => {
    await gate;
    return '1900000000.000001';
  });
  const initial = source.ingest();
  try {
    await vi.waitFor(async () => {
      const [intake] = await fixture.admin.db
        .select()
        .from(alertEpisodeIntakes)
        .where(eq(alertEpisodeIntakes.dataSourceId, source.id));
      expect(intake?.state).toBe('posting');
    });
    await expect(source.ingest()).rejects.toBeInstanceOf(RetryableError);
    const queueId = randomUUID();
    const pollQueue = new Queue(fixture.admin.db, fixture.redis, {
      stream: `lifecycle-retry:${queueId}`,
      group: queueId,
    });
    await pollQueue.ensureGroup();
    const jobId = await pollQueue.enqueue({
      tenantId: fixture.tenantId,
      type: 'poll',
      payload: source.wakeup,
    });
    // Without the handled count and the bumped attempts, an empty process() would pass as a retry.
    expect(await pollQueue.process('delivery-retry', async () => source.ingest())).toBe(1);
    const [requeued] = await fixture.admin.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(requeued).toMatchObject({ status: 'queued', attempts: 1 });
    expect(requeued?.lastError).toEqual(expect.stringMatching(/\S/));
    expect((await source.health()).eventFailureCategory).toBe('delivery_retry_pending');
  } finally {
    release();
  }
  await initial;
  await source.ingest();
  expect(fixture.postRoot.mock.calls.length - posts).toBe(1);
  expect(
    await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.dataSourceId, source.id)),
  ).toHaveLength(1);
});
test('uncertain Slack delivery remains action-required and replay never posts a second root', async () => {
  const source = await seed();
  const posts = fixture.postRoot.mock.calls.length;
  fixture.postRoot.mockRejectedValueOnce(
    new SlackApiError('uncertain', 'timeout', 'Provider timed out'),
  );
  await expect(source.ingest()).rejects.toBeInstanceOf(NonRetryableError);
  await expect(source.ingest()).rejects.toBeInstanceOf(NonRetryableError);
  await expect(source.ingest()).rejects.toBeInstanceOf(NonRetryableError);
  expect(fixture.postRoot.mock.calls.length - posts).toBe(1);
  expect((await source.health()).eventFailureCategory).toBe('delivery_uncertain');
  const [intake] = await fixture.admin.db
    .select()
    .from(alertEpisodeIntakes)
    .where(eq(alertEpisodeIntakes.dataSourceId, source.id));
  expect(intake?.state).toBe('uncertain');
  expect(
    await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.dataSourceId, source.id)),
  ).toHaveLength(0);
});

test('all-tests mode accepts any test the operator did not exclude, with the platform secret as GET Token', async () => {
  const source = await seed('C07ALERTS', { setupMode: 'auto', excludedMonitorIds: ['74'] });
  expect((await source.deliver('73')).status).toBe(202);
  expect((await source.deliver('75')).status).toBe(202);
  expect((await source.deliver('74')).status).toBe(409);
  // Contact-group ping URLs are GET-only, so the secret arrives as the Token query parameter.
  const get = await fixture.api.request(
    `/webhooks/statuscake/${source.id}/73?Token=${fixture.EVENT_TOKEN}`,
  );
  expect(get.status).toBe(202);
  const wrong = await fixture.api.request(`/webhooks/statuscake/${source.id}/73?Token=nope`);
  expect(wrong.status).toBe(401);
});
