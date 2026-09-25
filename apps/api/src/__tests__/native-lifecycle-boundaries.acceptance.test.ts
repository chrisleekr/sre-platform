import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { beforeAll, expect, test } from 'vitest';
import { alertmanagerEventCredential } from '@sre/connectors';
import {
  alertEpisodeIntakes,
  connectorConfigs,
  connectorEventCredentialKey,
  incidentSignals,
  incidents,
  jobs,
} from '@sre/db';
import { providerLifecycleWebhookRoutes } from '../provider-lifecycle-webhook';
import { createFixture } from './alertmanager-webhook.fixture';
const fixture = createFixture();
const start = new Date(Date.now() - 600000).toISOString();
const end = new Date(Date.now() - 60000).toISOString();
beforeAll(() => {
  for (const provider of ['datadog', 'grafana'] as const)
    fixture.api.route(
      `/webhooks/${provider}`,
      providerLifecycleWebhookRoutes(fixture.webhookDeps, provider),
    );
});
async function seed(type: 'datadog' | 'grafana', alertChannel = 'C07ALERTS') {
  const id = randomUUID();
  await fixture.admin.db.insert(connectorConfigs).values({
    id,
    tenantId: fixture.tenantId,
    type,
    name: id,
    enabled: true,
    webhookKey: id,
    settings: { eventTransport: 'direct', alertChannel },
  });
  await fixture.webhookDeps.secrets.put(
    fixture.tenantId,
    connectorEventCredentialKey(id),
    alertmanagerEventCredential(fixture.EVENT_TOKEN),
  );
  return id;
}
const dd = (changes: Record<string, unknown> = {}) => ({
  alert_id: '127',
  alert_scope: 'host:checkout',
  alert_cycle_key: 'cycle-a',
  alert_title: 'Checkout',
  alert_transition: 'Triggered',
  date: String(Date.parse(start)),
  ...changes,
});
const send = (provider: string, id: string, body: unknown) =>
  fixture.api.request(`/webhooks/${provider}/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fixture.EVENT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
async function state() {
  return {
    signals: await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.tenantId, fixture.tenantId)),
    intakes: await fixture.admin.db
      .select()
      .from(alertEpisodeIntakes)
      .where(eq(alertEpisodeIntakes.tenantId, fixture.tenantId)),
    incidents: await fixture.admin.db
      .select()
      .from(incidents)
      .where(eq(incidents.tenantId, fixture.tenantId)),
    jobs: await fixture.admin.db.select().from(jobs).where(eq(jobs.tenantId, fixture.tenantId)),
    posts: fixture.postRoot.mock.calls,
  };
}
test('Datadog scope secrets never reach the whole durable intake or triage payload, and duplicate identity stays stable', async () => {
  const id = await seed('datadog');
  const credential = `ghp_${'a'.repeat(36)}`;
  const payload = dd({
    alert_scope: `host:checkout,token:${fixture.EVENT_TOKEN},credential:${credential}`,
  });
  expect((await send('datadog', id, payload)).status).toBe(200);
  expect((await send('datadog', id, payload)).status).toBe(200);
  const intakes = await fixture.admin.db
    .select()
    .from(alertEpisodeIntakes)
    .where(eq(alertEpisodeIntakes.dataSourceId, id));
  expect(intakes).toHaveLength(1);
  const triage = await fixture.admin.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.tenantId, fixture.tenantId), eq(jobs.type, 'triage')));
  expect(triage.length).toBeGreaterThan(0);
  const durable = JSON.stringify({ intakes, triage });
  expect(durable).not.toContain(fixture.EVENT_TOKEN);
  expect(durable).not.toContain(credential);
  expect(intakes[0]?.observation.monitorIdentity).toMatch(/^[a-f0-9]{64}$/);
});
test.each(['recovery-first', 'trigger-first'])(
  'contradictory Datadog paired timestamps cannot clear in %s order and retain a repair diagnostic',
  async (order) => {
    const id = await seed('datadog');
    const trigger = dd();
    const invalidClear = dd({
      alert_transition: 'Recovered',
      date: String(Date.parse(start) - 1000),
    });
    const events = order === 'recovery-first' ? [invalidClear, trigger] : [trigger, invalidClear];
    await send('datadog', id, events[0]);
    const response = await send('datadog', id, events[1]);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: false,
      reason: 'conflicting_episode_times',
    });
    const [intake] = await fixture.admin.db
      .select()
      .from(alertEpisodeIntakes)
      .where(eq(alertEpisodeIntakes.dataSourceId, id));
    expect(intake).toMatchObject({ failureCategory: 'conflicting_episode_times' });
    const signals = await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.dataSourceId, id));
    expect(
      signals.every(
        (signal) => signal.state === 'firing' && signal.providerClearGeneration === null,
      ),
    ).toBe(true);
    if (order === 'recovery-first') expect(signals).toHaveLength(0);
    expect(
      (
        await send(
          'datadog',
          id,
          dd({ alert_transition: 'Recovered', date: String(Date.parse(end)) }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.admin.db
          .select()
          .from(incidentSignals)
          .where(eq(incidentSignals.dataSourceId, id))
      )[0],
    ).toMatchObject({ state: 'resolved', providerClearGeneration: 0 });
    expect(
      (
        await fixture.admin.db
          .select()
          .from(alertEpisodeIntakes)
          .where(eq(alertEpisodeIntakes.dataSourceId, id))
      )[0]?.failureCategory,
    ).toBeNull();
  },
);
test.each([
  ['datadog', () => dd({ alert_cycle_key: undefined })],
  ['datadog', () => dd({ alert_scope: undefined })],
  ['grafana', () => ({ ...fixture.payload('bad-version', start), version: '4' })],
  ['grafana', () => ({ ...fixture.payload('truncated', start), version: '1', truncatedAlerts: 1 })],
  [
    'grafana',
    () => ({
      ...fixture.payload('bad-time', start, { status: 'resolved', endsAt: 'invalid' }),
      version: '1',
    }),
  ],
] as const)(
  '%s malformed authenticated input rejects without durable lifecycle or delivery changes (%#)',
  async (provider, payload) => {
    const id = await seed(provider);
    const before = await state();
    const response = await send(provider, id, payload());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/^unsupported_(event|alert)_schema$/),
    });
    expect(await state()).toEqual(before);
  },
);
test('Grafana resolved envelope preserves a firing member and its open incident', async () => {
  const id = await seed('grafana');
  const first = fixture.payload('member-a', start);
  const second = fixture.payload('member-b', start);
  const payload = { ...first, version: '1', alerts: [...first.alerts, ...second.alerts] };
  expect((await send('grafana', id, payload)).status).toBe(200);
  expect(
    (
      await send('grafana', id, {
        ...payload,
        status: 'resolved',
        alerts: [
          ...fixture.payload('member-a', start, { status: 'resolved', endsAt: end }).alerts,
          ...second.alerts,
        ],
      })
    ).status,
  ).toBe(200);
  const signals = await fixture.admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.dataSourceId, id));
  expect(signals.filter((signal) => signal.state === 'firing')).toHaveLength(1);
  expect(signals.filter((signal) => signal.state === 'resolved')).toHaveLength(1);
  const active = signals.find((signal) => signal.state === 'firing')!;
  expect(
    (await fixture.admin.db.select().from(incidents).where(eq(incidents.id, active.incidentId)))[0]
      ?.status,
  ).toBe('open');
  expect(active.providerClearGeneration).toBeNull();
});
test.each([
  ['datadog', () => dd()],
  ['grafana', () => ({ ...fixture.payload('unsubscribed', start), version: '1' })],
] as const)(
  '%s delivery to an unsubscribed alert channel reports that exact action-required reason',
  async (provider, payload) => {
    const id = await seed(provider, 'C_UNSUBSCRIBED');
    const posts = fixture.postRoot.mock.calls.length;
    const response = await send(provider, id, payload());
    // 503 so the provider redelivers once the channel is subscribed; nothing else re-drives it.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      accepted: false,
      reason: 'alert_channel_not_subscribed',
    });
    const [row] = await fixture.admin.db
      .select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, id));
    expect(row?.eventFailureCategory).toBe('alert_channel_not_subscribed');
    expect(
      await fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(eq(incidentSignals.dataSourceId, id)),
    ).toHaveLength(0);
    expect(fixture.postRoot.mock.calls.length).toBe(posts);
  },
);
test.each([
  ['datadog', () => dd({ alert_cycle_key: 'posting-fence' })],
  ['grafana', () => ({ ...fixture.payload('posting-fence', start), version: '1' })],
] as const)(
  '%s redelivery while another attempt owns the root posting fence asks the provider to retry',
  async (provider, payload) => {
    const id = await seed(provider);
    let posting!: () => void;
    const firstIsPosting = new Promise<void>((resolve) => (posting = resolve));
    let releaseFirst!: () => void;
    const firstMayPost = new Promise<void>((resolve) => (releaseFirst = resolve));
    fixture.postRoot.mockImplementationOnce(async () => {
      posting();
      await firstMayPost;
      return `1788999999.${String(Date.now()).slice(-6)}`;
    });
    const first = send(provider, id, payload());
    await firstIsPosting;
    const posts = fixture.postRoot.mock.calls.length;
    try {
      // A 202 here would park the episode: nothing re-drives it if the first attempt then dies.
      expect((await send(provider, id, payload())).status).toBe(503);
      expect(fixture.postRoot.mock.calls.length).toBe(posts);
    } finally {
      releaseFirst();
    }
    expect((await first).status).toBe(200);
  },
);
test.each([
  ['datadog', 'disabled', { enabled: false }],
  ['grafana', 'disabled', { enabled: false }],
  ['datadog', 'non-direct', { settings: { eventTransport: 'none', alertChannel: 'C07ALERTS' } }],
  ['grafana', 'non-direct', { settings: { eventTransport: 'none', alertChannel: 'C07ALERTS' } }],
] as const)(
  '%s %s connector refuses an authenticated delivery and writes nothing',
  async (provider, _case, change) => {
    const id = await seed(provider);
    await fixture.admin.db.update(connectorConfigs).set(change).where(eq(connectorConfigs.id, id));
    const before = await state();
    const payload =
      provider === 'datadog' ? dd() : { ...fixture.payload('refused', start), version: '1' };
    expect((await send(provider, id, payload)).status).toBe(409);
    expect(await state()).toEqual(before);
  },
);
test.each(['datadog', 'grafana'] as const)(
  '%s delivery with a non-JSON body is rejected before processing',
  async (provider) => {
    const id = await seed(provider);
    const before = await state();
    const response = await fixture.api.request(`/webhooks/${provider}/${id}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fixture.EVENT_TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    expect(await state()).toEqual(before);
  },
);
test.each(['Warn', 'No Data', 'Re-No Data'])(
  'a Datadog %s delivery is acknowledged as healthy and changes nothing',
  async (transition) => {
    const id = await seed('datadog');
    const before = await state();
    const response = await send('datadog', id, dd({ alert_transition: transition }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: true,
      ignored: true,
      reason: 'transition_not_handled',
    });
    expect(await state()).toEqual(before);
    const [row] = await fixture.admin.db
      .select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, id));
    // A routine notice must not mark the connector as receiving malformed payloads.
    expect(row).toMatchObject({ eventFailureCategory: null, eventCount: 1 });
  },
);
test.each(['Re-Triggered', 'Renotify'])(
  'a Datadog %s with no retained cycle is acknowledged and opens nothing',
  async (transition) => {
    const id = await seed('datadog');
    const before = await state();
    // Its date is when it repeated, not when the cycle began, so it cannot open a cycle.
    const response = await send('datadog', id, dd({ alert_transition: transition }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(await state()).toEqual(before);
  },
);
test('an acknowledged Datadog notice keeps an earlier delivery diagnostic', async () => {
  const id = await seed('datadog', 'C_UNSUBSCRIBED');
  expect((await send('datadog', id, dd())).status).toBe(503);
  expect((await send('datadog', id, dd({ alert_transition: 'Warn' }))).status).toBe(200);
  const [row] = await fixture.admin.db
    .select()
    .from(connectorConfigs)
    .where(eq(connectorConfigs.id, id));
  // The parked trigger still needs a human; a routine notice must not hide it.
  expect(row?.eventFailureCategory).toBe('alert_channel_not_subscribed');
});
test('Datadog repeat notices after the trigger keep one episode, one root and the original start', async () => {
  const id = await seed('datadog');
  expect((await send('datadog', id, dd())).status).toBe(200);
  const posts = fixture.postRoot.mock.calls.length;
  const later = String(Date.parse(start) + 120000);
  for (const repeat of [
    dd({ alert_transition: 'Re-Triggered', date: later }),
    dd({ alert_transition: 'Renotify', date: later }),
  ])
    expect((await send('datadog', id, repeat)).status).toBe(200);
  const signals = await fixture.admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.dataSourceId, id));
  expect(signals).toEqual([
    expect.objectContaining({ state: 'firing', startsAt: new Date(start) }),
  ]);
  expect(fixture.postRoot.mock.calls.length).toBe(posts);
});
