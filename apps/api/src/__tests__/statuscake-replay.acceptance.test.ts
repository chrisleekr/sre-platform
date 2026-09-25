import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
import { Queue } from '@sre/queue';
import { connectorLifecycleHandlers } from '../../../triage-worker/src/connector-lifecycle';
import { makePollHandler } from '../../../triage-worker/src/poller';
import { statusCakeLifecycleWebhookRoutes } from '../statuscake-lifecycle-webhook';
import { createFixture } from './alertmanager-webhook.fixture';
const fixture = createFixture();
const start = new Date(Date.now() - 600000);
const end = new Date(start.getTime() + 300000);
let recovered = false;
const registry = new ConnectorRegistry([
  {
    ...statusCakeConnectorDefinition,
    create: (config) =>
      makeStatusCakeConnector(config, (async (input) => {
        const path = new URL(String(input)).pathname;
        return Response.json(
          path.endsWith('/periods')
            ? {
                data: recovered
                  ? [
                      {
                        status: 'down',
                        created_at: new Date(start.getTime() - 30000).toISOString(),
                        ended_at: end.toISOString(),
                      },
                    ]
                  : [],
                links: {},
              }
            : path.endsWith('/alerts')
              ? {
                  data: [
                    ...(recovered
                      ? [
                          {
                            status: 'up',
                            triggered_at: new Date(end.getTime() + 1000).toISOString(),
                          },
                        ]
                      : []),
                    {
                      status: 'down',
                      triggered_at: new Date(start.getTime() + 10000).toISOString(),
                    },
                    { status: 'down', triggered_at: start.toISOString() },
                    { status: 'up', triggered_at: new Date(start.getTime() - 60000).toISOString() },
                  ],
                  links: {},
                }
              : {
                  data: {
                    id: '73',
                    name: 'Checkout',
                    status: recovered ? 'up' : 'down',
                    paused: false,
                  },
                },
        );
      }) as typeof fetch),
  },
]);
beforeAll(() =>
  fixture.api.route('/webhooks/statuscake', statusCakeLifecycleWebhookRoutes(fixture.webhookDeps)),
);

test('original queued Down and ordinary Up finish after recovery with one immutable alert episode', async () => {
  const id = randomUUID();
  await fixture.admin.db.insert(connectorConfigs).values({
    id,
    tenantId: fixture.tenantId,
    type: 'statuscake',
    name: id,
    webhookKey: id,
    settings: { eventTransport: 'direct', alertChannel: 'C07ALERTS', uptimeMonitorIds: ['73'] },
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
  const pollQueue = new Queue(fixture.admin.db, fixture.redis, {
    stream: `lifecycle-replay:${id}`,
    group: id,
  });
  await pollQueue.ensureGroup();
  const pending: string[] = [];
  const payloads: Array<{ monitorId: string; observedAt: string; lifecycleVersion: number }> = [];
  fixture.webhookDeps.enqueueLifecycle = async (tenantId, payload) => {
    const jobId = await pollQueue.enqueue({ tenantId, type: 'poll', payload });
    pending.push(jobId);
    payloads.push(payload);
    return jobId;
  };
  const lifecycle = connectorLifecycleHandlers({
    db: fixture.app.db,
    hub: fixture.webhookDeps.hub,
    queue: fixture.webhookDeps.route.queue,
    redis: fixture.redis,
    secrets: fixture.webhookDeps.secrets,
    postAlertRoot: fixture.postRoot,
  });
  const provider = makeDbConnectorProvider({
    db: fixture.app.db,
    secrets: fixture.webhookDeps.secrets,
    registry,
  });
  const wake = () =>
    fixture.api.request(`/webhooks/statuscake/${id}/73`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Token: fixture.EVENT_TOKEN }).toString(),
    });
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date(start.getTime() + 120000));
    expect((await wake()).status).toBe(202);
    // Deliver the Down once before recovery while its durable job stays queued for replay.
    const source = (await provider(fixture.tenantId)()).find((row) => row.id === id)!;
    await lifecycle.ingestLifecycle(fixture.tenantId, source, payloads[0]!);
    const [original] = await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.dataSourceId, id));
    expect(original?.startsAt).toEqual(start);
    recovered = true;
    vi.setSystemTime(new Date(end.getTime() + 2000));
    const up = await wake();
    const handler = makePollHandler({
      connectorProvider: provider,
      ...lifecycle,
      cache: { get: async () => [], set: async () => {} },
      ttlSec: 120,
    });
    for (let n = 0; n < pending.length; n++) await pollQueue.process('replay', handler);
    const signals = await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.dataSourceId, id));
    expect(signals).toEqual([
      expect.objectContaining({ id: original!.id, startsAt: start, state: 'resolved' }),
    ]);
    expect(
      await fixture.admin.db
        .select()
        .from(alertEpisodeIntakes)
        .where(eq(alertEpisodeIntakes.dataSourceId, id)),
    ).toHaveLength(1);
    expect(fixture.postRoot).toHaveBeenCalledTimes(1);
    expect(up.status).toBe(202);
    expect(pending).toHaveLength(2);
    for (const jobId of pending)
      expect(
        (await fixture.admin.db.select().from(jobs).where(eq(jobs.id, jobId)))[0],
      ).toMatchObject({ status: 'done', attempts: 1 });
    expect(
      (await fixture.admin.db.select().from(connectorConfigs).where(eq(connectorConfigs.id, id)))[0]
        ?.eventFailureCategory,
    ).toBeNull();
  } finally {
    vi.useRealTimers();
    delete fixture.webhookDeps.enqueueLifecycle;
    recovered = false;
  }
});
