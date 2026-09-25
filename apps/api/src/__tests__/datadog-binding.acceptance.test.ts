import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, expect, test } from 'vitest';
import {
  ConnectorRegistry,
  alertmanagerEventCredential,
  datadogConnectorDefinition,
  makeDatadogConnector,
} from '@sre/connectors';
import {
  alertEpisodeIntakes,
  applySignalObservation,
  connectorConfigs,
  connectorCredentialKey,
  connectorEventCredentialKey,
  createIncident,
  incidentSignals,
  recordSurfaceBinding,
  withTenant,
} from '@sre/db';
import type { TenantAuthVariables } from '../auth';
import type { ConnectorRouteContext } from '../connectors/routes/context';
import { registerConnectorLifecycleRoutes } from '../connectors/routes/lifecycle';
import { providerLifecycleWebhookRoutes } from '../provider-lifecycle-webhook';
import { createFixture } from './alertmanager-webhook.fixture';
const fixture = createFixture();
const start = new Date(Math.floor(Date.now() / 1000) * 1000 - 600000);
const registry = new ConnectorRegistry([
  {
    ...datadogConnectorDefinition,
    create: (config) =>
      makeDatadogConnector(config, (async (_input: string | URL | Request) =>
        Response.json({
          id: 127,
          name: 'Checkout',
          state: {
            groups: {
              'host:checkout': { status: 'Alert', last_triggered_ts: start.getTime() / 1000 },
            },
          },
        })) as typeof fetch),
  },
]);
beforeAll(() =>
  fixture.api.route(
    '/webhooks/datadog',
    providerLifecycleWebhookRoutes(fixture.webhookDeps, 'datadog', registry),
  ),
);
function api(tenantId = fixture.tenantId) {
  const routes = new Hono<{ Variables: TenantAuthVariables }>();
  routes.use('*', async (c, next) => {
    c.set('tenant', { tenantId, userId: null } as never);
    await next();
  });
  registerConnectorLifecycleRoutes(routes, {
    deps: {
      db: fixture.app.db,
      secrets: fixture.webhookDeps.secrets,
      registry,
      lifecycle: fixture.webhookDeps,
    },
  } as ConnectorRouteContext);
  return routes;
}
async function seed() {
  const id = randomUUID();
  await fixture.admin.db.insert(connectorConfigs).values({
    id,
    tenantId: fixture.tenantId,
    type: 'datadog',
    name: id,
    enabled: true,
    webhookKey: id,
    settings: { eventTransport: 'direct', alertChannel: 'C07ALERTS' },
  });
  await fixture.webhookDeps.secrets.put(
    fixture.tenantId,
    connectorCredentialKey(id),
    JSON.stringify({ apiKey: 'api', appKey: 'app' }),
  );
  await fixture.webhookDeps.secrets.put(
    fixture.tenantId,
    connectorEventCredentialKey(id),
    alertmanagerEventCredential(fixture.EVENT_TOKEN),
  );
  const incident = await createIncident(fixture.app.db, fixture.tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
    resolutionPolicy: 'provider_clear',
  });
  const signal = (
    await applySignalObservation(fixture.app.db, fixture.tenantId, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C07ALERTS',
      externalMessageId: randomUUID(),
      state: 'unknown',
      summary: 'Historical Datadog notification',
      contentHash: 'original',
      eventKey: randomUUID(),
      eventAt: new Date(start.getTime() + 5000),
    })
  ).signal;
  await withTenant(fixture.app.db, fixture.tenantId, (tx) =>
    recordSurfaceBinding(tx, fixture.tenantId, {
      incidentId: incident.id,
      surface: 'slack',
      channel: signal.channel,
      threadId: signal.externalMessageId,
      role: 'source',
    }),
  );
  return { id, signal, incident };
}
const request = (id: string, body: unknown, tenantId = fixture.tenantId) =>
  api(tenantId).request(`/datadog/${id}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const native = (id: string, cycle = 'cycle-a', at = start, transition = 'Triggered') =>
  fixture.api.request(`/webhooks/datadog/${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fixture.EVENT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      alert_id: '127',
      alert_scope: 'host:checkout',
      alert_cycle_key: cycle,
      alert_title: 'Checkout',
      alert_transition: transition,
      date: String(at.getTime()),
    }),
  });
async function preview(id: string, signalId: string, cycleKey?: string) {
  const response = await request(id, {
    mode: 'preview',
    signalId,
    monitorId: '127',
    scope: 'host:checkout',
    cycleKey,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}
async function bind(id: string, signalId: string, cycleKey?: string) {
  const proof = await preview(id, signalId, cycleKey);
  return request(id, {
    ...proof,
    mode: 'bind',
    scope: 'host:checkout',
    cycleKey,
    reason: 'Associated the exact provider delivery cycle',
  });
}
async function snapshot(id: string) {
  const signals = await fixture.admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.dataSourceId, id));
  const [config] = await fixture.admin.db
    .select()
    .from(connectorConfigs)
    .where(eq(connectorConfigs.id, id));
  return { signals, config };
}
test('explicit Datadog cycle binding before native delivery adopts the original root once; distinct cycles remain separate', async () => {
  const { id, signal } = await seed();
  expect((await bind(id, signal.id, 'cycle-a')).status).toBe(200);
  expect(JSON.stringify((await snapshot(id)).config)).not.toContain('cycle-a');
  expect((await request(id, { mode: 'reconcile' })).status).toBe(200);
  expect((await native(id)).status).toBe(200);
  expect((await snapshot(id)).signals).toEqual([
    expect.objectContaining({ id: signal.id, surface: 'slack' }),
  ]);
  expect(fixture.postRoot).not.toHaveBeenCalled();
  expect((await native(id)).status).toBe(200);
  expect((await native(id, 'cycle-b')).status).toBe(200);
  expect((await snapshot(id)).signals).toHaveLength(2);
  expect(fixture.postRoot).toHaveBeenCalledTimes(1);
  const beforeRebind = await snapshot(id);
  expect((await bind(id, signal.id, 'cycle-c')).status).toBe(409);
  expect(await snapshot(id)).toEqual(beforeRebind);
});
test('existing native Datadog cycle rejects duplicate legacy binding with a canonical incident and no partial writes', async () => {
  const { id, signal } = await seed();
  expect((await native(id)).status).toBe(200);
  const before = await snapshot(id);
  const legacyBefore = (
    await fixture.admin.db.select().from(incidentSignals).where(eq(incidentSignals.id, signal.id))
  )[0];
  const response = await bind(id, signal.id, 'cycle-a');
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    canonicalIncidentId: before.signals[0]!.incidentId,
    nextStep: expect.stringContaining('administrative'),
  });
  expect(await snapshot(id)).toEqual(before);
  expect(
    (
      await fixture.admin.db.select().from(incidentSignals).where(eq(incidentSignals.id, signal.id))
    )[0],
  ).toEqual(legacyBefore);
});
test('Datadog read binding stays usable without a cycle key and explicitly reports missing native association', async () => {
  const { id, signal } = await seed();
  const response = await bind(id, signal.id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ nativeAssociation: 'cycle_key_required' });
  expect((await request(id, { mode: 'reconcile' })).status).toBe(200);
  expect((await snapshot(id)).signals[0]?.signalSource?.lifecycleState).toBe('firing');
  const pending = await native(id);
  expect(pending.status).toBe(202);
  expect(await pending.json()).toMatchObject({ reason: 'native_cycle_association_required' });
  expect(fixture.postRoot).not.toHaveBeenCalled();
  expect((await bind(id, signal.id, 'cycle-a')).status).toBe(200);
  expect((await native(id)).status).toBe(200);
  expect((await snapshot(id)).signals).toHaveLength(1);
  expect(fixture.postRoot).not.toHaveBeenCalled();
});
test('an associated native cycle with a different exact start is retained for repair without a second incident', async () => {
  const { id, signal } = await seed();
  expect((await bind(id, signal.id, 'cycle-a')).status).toBe(200);
  const response = await native(id, 'cycle-a', new Date(start.getTime() + 1000));
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ reason: 'binding_episode_mismatch' });
  expect((await snapshot(id)).signals).toHaveLength(1);
  expect(fixture.postRoot).not.toHaveBeenCalled();
  expect((await native(id)).status).toBe(200);
  expect((await snapshot(id)).signals).toHaveLength(1);
  expect(fixture.postRoot).not.toHaveBeenCalled();
  const [intake] = await fixture.admin.db
    .select()
    .from(alertEpisodeIntakes)
    .where(eq(alertEpisodeIntakes.dataSourceId, id));
  expect(intake).toMatchObject({ failureCategory: null, startsAt: start });
});
test('a Re-Triggered notice on a bound cycle adopts the bound start instead of quarantining it', async () => {
  const { id, signal } = await seed();
  expect((await bind(id, signal.id, 'cycle-a')).status).toBe(200);
  // The repeat carries when it repeated; a trigger with this time would be a binding mismatch.
  const response = await native(id, 'cycle-a', new Date(start.getTime() + 120000), 'Re-Triggered');
  expect(response.status).toBe(200);
  expect((await snapshot(id)).signals).toEqual([
    expect.objectContaining({ id: signal.id, surface: 'slack' }),
  ]);
  expect(fixture.postRoot).not.toHaveBeenCalled();
  const [intake] = await fixture.admin.db
    .select()
    .from(alertEpisodeIntakes)
    .where(eq(alertEpisodeIntakes.dataSourceId, id));
  expect(intake).toMatchObject({ failureCategory: null, startsAt: start });
});
test('a repeat notice against a legacy binding opens no second incident, and the real trigger still asks for the cycle key', async () => {
  const { id, signal } = await seed();
  expect((await bind(id, signal.id)).status).toBe(200);
  for (const transition of ['Renotify', 'Re-Triggered'])
    expect(
      (await native(id, 'cycle-a', new Date(start.getTime() + 120000), transition)).status,
    ).toBe(200);
  expect((await snapshot(id)).signals).toEqual([expect.objectContaining({ id: signal.id })]);
  expect(fixture.postRoot).not.toHaveBeenCalled();
  const trigger = await native(id);
  expect(trigger.status).toBe(202);
  expect(await trigger.json()).toMatchObject({ reason: 'native_cycle_association_required' });
  expect(fixture.postRoot).not.toHaveBeenCalled();
});
test('a repeat notice does not lift a bound cycle quarantined for a conflicting trigger start', async () => {
  const { id, signal } = await seed();
  expect((await bind(id, signal.id, 'cycle-a')).status).toBe(200);
  expect((await native(id, 'cycle-a', new Date(start.getTime() + 1000))).status).toBe(202);
  const repeat = await native(id, 'cycle-a', new Date(start.getTime() + 120000), 'Re-Triggered');
  expect(repeat.status).toBe(202);
  expect(await repeat.json()).toMatchObject({ reason: 'binding_episode_mismatch' });
  const [intake] = await fixture.admin.db
    .select()
    .from(alertEpisodeIntakes)
    .where(eq(alertEpisodeIntakes.dataSourceId, id));
  expect(intake).toMatchObject({ failureCategory: 'binding_episode_mismatch', startsAt: null });
  expect(intake?.observation.annotations.conflicting_starts_at).toBeDefined();
});
test('cycle binding preview is tenant-isolated and connector generation changes reject without partial association', async () => {
  const { id, signal } = await seed();
  const proof = await preview(id, signal.id, 'cycle-a');
  expect(
    (
      await request(
        id,
        {
          mode: 'preview',
          signalId: signal.id,
          monitorId: '127',
          scope: 'host:checkout',
          cycleKey: 'cycle-a',
        },
        randomUUID(),
      )
    ).status,
  ).toBe(404);
  await fixture.admin.db
    .update(connectorConfigs)
    .set({ lifecycleVersion: 1 })
    .where(eq(connectorConfigs.id, id));
  const before = await snapshot(id);
  expect(
    (
      await request(id, {
        ...proof,
        mode: 'bind',
        scope: 'host:checkout',
        cycleKey: 'cycle-a',
        reason: 'Stale preview',
      })
    ).status,
  ).toBe(409);
  expect(await snapshot(id)).toEqual(before);
});

test.each(['trigger-first', 'recovery-first'])(
  'pending native association survives %s paired delivery until explicit binding and authenticated replay',
  async (order) => {
    const { id, signal } = await seed();
    expect((await bind(id, signal.id)).status).toBe(200);
    const recovered = new Date(start.getTime() + 300000);
    const events =
      order === 'trigger-first'
        ? ([
            [start, 'Triggered'],
            [recovered, 'Recovered'],
          ] as const)
        : ([
            [recovered, 'Recovered'],
            [start, 'Triggered'],
          ] as const);
    for (const [at, transition] of events)
      expect((await native(id, 'cycle-a', at, transition)).status).toBe(202);
    const [pending] = await fixture.admin.db
      .select()
      .from(alertEpisodeIntakes)
      .where(eq(alertEpisodeIntakes.dataSourceId, id));
    expect(pending).toMatchObject({
      failureCategory: 'native_cycle_association_required',
      state: 'pending',
      startsAt: start,
      observation: { status: 'resolved' },
    });
    expect((await snapshot(id)).signals).toEqual([
      expect.objectContaining({ id: signal.id, state: 'unknown' }),
    ]);
    expect(fixture.postRoot).not.toHaveBeenCalled();
    expect((await bind(id, signal.id, 'cycle-a')).status).toBe(200);
    expect((await native(id)).status).toBe(200);
    expect((await native(id, 'cycle-a', recovered, 'Recovered')).status).toBe(200);
    expect((await snapshot(id)).signals).toEqual([
      expect.objectContaining({ id: signal.id, state: 'resolved', providerClearGeneration: 2 }),
    ]);
    expect(fixture.postRoot).not.toHaveBeenCalled();
    expect(
      await fixture.admin.db
        .select()
        .from(alertEpisodeIntakes)
        .where(eq(alertEpisodeIntakes.dataSourceId, id)),
    ).toEqual([expect.objectContaining({ failureCategory: null, state: 'accepted' })]);
  },
);
