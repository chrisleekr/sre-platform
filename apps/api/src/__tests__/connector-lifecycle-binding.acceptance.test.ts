import { publicSignalCoverage } from '../incidents/signal-lifecycle-coverage';
import { processAlert } from '@sre/alerts';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import {
  ConnectorRegistry,
  makeStatusCakeConnector,
  statusCakeConnectorDefinition,
} from '@sre/connectors';
import { reconcileConnectorLifecycle } from '@sre/agent-tools';
import {
  applySignalObservation,
  connectorConfigs,
  connectorCredentialKey,
  createIncident,
  incidentSignals,
  incidents,
  jobs,
  lockResponseGroupWorkTx,
  serializeSignalFence,
  recordSurfaceBinding,
  withTenant,
} from '@sre/db';
import type { TenantAuthVariables } from '../auth';
import type { ConnectorRouteContext } from '../connectors/routes/context';
import { registerConnectorLifecycleRoutes } from '../connectors/routes/lifecycle';
import { createFixture } from './alertmanager-webhook.fixture';

const fixture = createFixture();
const start = new Date(Date.now() - 600000);
const end = new Date(Date.now() - 60000);
let firing = false;
let beforeRead: (() => Promise<void>) | undefined;
const reads = vi.fn();
const registry = new ConnectorRegistry([
  {
    ...statusCakeConnectorDefinition,
    create: (config) =>
      makeStatusCakeConnector(config, (async (input) => {
        const url = new URL(String(input));
        const id = url.pathname.split('/')[3]!;
        reads(id);
        if (beforeRead) {
          const callback = beforeRead;
          beforeRead = undefined;
          await callback();
        }
        return Response.json(
          url.pathname.endsWith('/periods')
            ? {
                data: firing
                  ? []
                  : [
                      {
                        status: 'down',
                        created_at: start.toISOString(),
                        ended_at: end.toISOString(),
                      },
                    ],
                links: {},
              }
            : url.pathname.endsWith('/alerts')
              ? { data: [{ status: 'down', triggered_at: start.toISOString() }], links: {} }
              : {
                  data: {
                    id,
                    name: `Monitor ${id}`,
                    status: firing ? 'down' : 'up',
                    paused: false,
                  },
                },
        );
      }) as typeof fetch),
  },
]);
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
    type: 'statuscake',
    name: id,
    enabled: true,
    settings: { alertChannel: 'C07ALERTS' },
  });
  await fixture.webhookDeps.secrets.put(
    fixture.tenantId,
    connectorCredentialKey(id),
    'read-bearer',
  );
  const incident = await createIncident(fixture.app.db, fixture.tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
    resolutionPolicy: 'provider_clear',
  });
  const observation = {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C07ALERTS',
    externalMessageId: randomUUID(),
    state: 'firing' as const,
    summary: 'Historical stock notification',
    contentHash: 'original',
    eventKey: randomUUID(),
    eventAt: new Date(start.getTime() + 5000),
  };
  const signal = (await applySignalObservation(fixture.app.db, fixture.tenantId, observation))
    .signal;
  await withTenant(fixture.app.db, fixture.tenantId, (tx) =>
    recordSurfaceBinding(tx, fixture.tenantId, {
      incidentId: incident.id,
      surface: 'slack',
      channel: observation.channel,
      threadId: observation.externalMessageId,
      role: 'source',
    }),
  );
  return { id, incident, signal, observation };
}
async function request(id: string, body: Record<string, unknown>, tenantId = fixture.tenantId) {
  return api(tenantId).request(`/statuscake/${id}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function snapshot(id: string, signalId: string) {
  const [config] = await fixture.admin.db
    .select()
    .from(connectorConfigs)
    .where(eq(connectorConfigs.id, id));
  const [signal] = await fixture.admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.id, signalId));
  const history = await fixture.webhookDeps.hub.history(fixture.tenantId, signal!.incidentId);
  return { config, signal, history };
}
test('preview and audited exact binding preserve original evidence, then reconcile the historical incident', async () => {
  const { id, signal } = await seed();
  const response = await request(id, {
    mode: 'preview',
    signalId: signal.id,
    monitorId: '73',
    family: 'uptime',
  });
  expect(response.status).toBe(200);
  const preview = (await response.json()) as Record<string, unknown>;
  expect((await snapshot(id, signal.id)).signal).toEqual(signal);
  expect(
    (
      await request(id, {
        ...preview,
        mode: 'bind',
        family: 'uptime',
        reason: 'Verified the provider test configuration',
      })
    ).status,
  ).toBe(200);
  const bound = await snapshot(id, signal.id);
  expect(bound.signal).toMatchObject({
    state: 'firing',
    clearProvenance: null,
    summary: signal.summary,
    lastEventKey: signal.lastEventKey,
    dataSourceId: id,
    version: 2,
  });
  expect(bound.history).toHaveLength(1);
  const source = registry.create({
    id,
    tenantId: fixture.tenantId,
    type: 'statuscake',
    name: id,
    settings: {},
    getCredential: async () => 'read-bearer',
  });
  const native = await source.alertLifecycle!.readEpisode!({
    monitorId: '73',
    family: 'uptime',
    startsAt: start,
    observedAt: new Date(),
  });
  expect(native.status).toBe('verified');
  if (native.status !== 'verified') throw new Error('Expected provider evidence');
  const postsBefore = fixture.postRoot.mock.calls.length;
  await processAlert(
    fixture.webhookDeps,
    bound.config!,
    'statuscake:uptime:73',
    null,
    native.observations[0]!,
    new Date(),
  );
  expect(fixture.postRoot.mock.calls.length).toBe(postsBefore);
  expect(
    await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.dataSourceId, id)),
  ).toHaveLength(1);

  expect((await request(id, { mode: 'reconcile' })).status).toBe(200);
  expect((await snapshot(id, signal.id)).signal).toMatchObject({
    state: 'resolved',
    clearProvenance: 'provider',
    signalSource: { lifecycleVersion: 1, kind: 'monitor' },
  });
});
test('capacity rejection commits no partial binding or audit', async () => {
  const { id, signal } = await seed();
  await fixture.admin.db
    .update(connectorConfigs)
    .set({
      settings: {
        lifecycleBindings: Array.from({ length: 50 }, () => ({
          signalId: randomUUID(),
          monitorId: 'other',
          startsAt: start.toISOString(),
        })),
      },
    })
    .where(eq(connectorConfigs.id, id));
  const preview = (await (
    await request(id, { mode: 'preview', signalId: signal.id, monitorId: '73', family: 'uptime' })
  ).json()) as Record<string, unknown>;
  const before = await snapshot(id, signal.id);
  const response = await request(id, {
    ...preview,
    mode: 'bind',
    family: 'uptime',
    reason: 'Capacity check',
  });
  expect(response.status).toBe(409);
  // A fresh preview cannot free a slot, so the response must not ask for one.
  expect(await response.json()).toEqual({
    error: 'binding capacity reached',
    nextStep: expect.stringContaining('maximum of 50'),
  });
  expect(await snapshot(id, signal.id)).toEqual(before);
});
test('the binding audit line stores a scrubbed reason, never the pasted credential', async () => {
  const { id, signal } = await seed();
  // Built at runtime so the literal never reads as a committed credential.
  const token = `ghp_${'a1B2c3D4e5'.repeat(3)}`;
  const preview = (await (
    await request(id, { mode: 'preview', signalId: signal.id, monitorId: '73', family: 'uptime' })
  ).json()) as Record<string, unknown>;
  expect(
    (
      await request(id, {
        ...preview,
        mode: 'bind',
        family: 'uptime',
        reason: `Checked with ${token} against the provider`,
      })
    ).status,
  ).toBe(200);
  const { history } = await snapshot(id, signal.id);
  expect(history).toHaveLength(1);
  expect(history[0]!.content).not.toContain(token);
  expect(history[0]!.content).toContain('Reason: Checked with [REDACTED] against the provider');
});
test('a generation change during the provider read cannot bind stale evidence, and another tenant sees no connector', async () => {
  const { id, signal } = await seed();
  const body = { mode: 'preview', signalId: signal.id, monitorId: '73', family: 'uptime' };
  const preview = (await (await request(id, body)).json()) as Record<string, unknown>;
  beforeRead = async () => {
    await fixture.admin.db
      .update(connectorConfigs)
      .set({ lifecycleVersion: 1 })
      .where(eq(connectorConfigs.id, id));
  };
  expect(
    (await request(id, { ...preview, mode: 'bind', family: 'uptime', reason: 'Must retry' }))
      .status,
  ).toBe(409);
  expect((await snapshot(id, signal.id)).signal).toEqual(signal);
  expect((await request(id, body, randomUUID())).status).toBe(404);
});
test('bounded reconciliation advances beyond 50 still-firing retained episodes', async () => {
  const { id, incident } = await seed();
  await fixture.admin.db.insert(incidentSignals).values(
    Array.from({ length: 53 }, (_, index) => ({
      tenantId: fixture.tenantId,
      incidentId: incident.id,
      dataSourceId: id,
      surface: 'statuscake',
      channel: id,
      externalMessageId: `episode-${index}`,
      state: 'firing' as const,
      lastEventType: 'opened' as const,
      summary: 'Native monitor',
      contentHash: 'native',
      lastEventKey: `native-${index}`,
      lastEventAt: start,
      startsAt: start,
      providerFingerprint: `fingerprint-${index}`,
      labels: { monitor_id: String(index), check_type: 'uptime' },
    })),
  );
  const seen = new Set<string>();
  const connector = registry.create({
    id,
    tenantId: fixture.tenantId,
    type: 'statuscake',
    name: id,
    settings: {},
    getCredential: async () => 'read-token',
  });
  Object.defineProperty(connector, 'generation', { value: { id, lifecycleVersion: 0 } });
  connector.alertLifecycle!.readEpisode = async (query) => {
    seen.add(query.monitorId);
    return { status: 'unverified', reason: 'provider_read_failed' };
  };
  for (let n = 0; n < 2; n++)
    await reconcileConnectorLifecycle({
      db: fixture.app.db,
      tenantId: fixture.tenantId,
      connector,
      hub: fixture.webhookDeps.hub,
      queue: fixture.webhookDeps.route.queue,
    });
  expect(seen.size).toBe(53);
  const history = await fixture.webhookDeps.hub.history(fixture.tenantId, incident.id);
  await reconcileConnectorLifecycle({
    db: fixture.app.db,
    tenantId: fixture.tenantId,
    connector,
    hub: fixture.webhookDeps.hub,
    queue: fixture.webhookDeps.route.queue,
  });
  expect(await fixture.webhookDeps.hub.history(fixture.tenantId, incident.id)).toEqual(history);
});

test('rejected native firing cannot certify a historical clear, while a fresh exact clear can', async () => {
  const { id, incident, signal } = await seed();
  await fixture.admin.db
    .update(incidentSignals)
    .set({ state: 'resolved', clearProvenance: 'provider' })
    .where(eq(incidentSignals.id, signal.id));
  firing = true;
  try {
    const preview = (await (
      await request(id, { mode: 'preview', signalId: signal.id, monitorId: '73', family: 'uptime' })
    ).json()) as Record<string, unknown>;
    expect(
      (
        await request(id, {
          ...preview,
          mode: 'bind',
          family: 'uptime',
          reason: 'Confirmed exact test',
        })
      ).status,
    ).toBe(200);
    const bound = await snapshot(id, signal.id);
    await applySignalObservation(fixture.app.db, fixture.tenantId, {
      incidentId: incident.id,
      surface: signal.surface,
      channel: signal.channel,
      externalMessageId: signal.externalMessageId,
      state: 'resolved',
      clearProvenance: 'provider',
      dataSourceId: id,
      providerFingerprint: bound.signal!.providerFingerprint!,
      startsAt: start,
      summary: 'Stale clear',
      contentHash: 'stale',
      eventKey: randomUUID(),
      eventAt: start,
      signalSource: {
        kind: 'monitor',
        provider: 'statuscake',
        dataSourceId: id,
        externalId: '73',
        displayName: 'Checkout',
        observedAt: start.toISOString(),
        lifecycleVersion: 1,
        lifecycleState: 'resolved',
      },
    });
    expect((await snapshot(id, signal.id)).signal?.providerClearGeneration).toBeNull();
    expect((await snapshot(id, signal.id)).signal?.signalSource?.lifecycleVersion).toBeUndefined();
    const source = registry.create({
      id,
      tenantId: fixture.tenantId,
      type: 'statuscake',
      name: id,
      settings: {},
      getCredential: async () => 'bearer',
    });
    const observation = await source.alertLifecycle!.readEpisode!({
      monitorId: '73',
      family: 'uptime',
      startsAt: start,
      observedAt: new Date(),
    });
    if (observation.status !== 'verified') throw new Error('Fixture should verify');
    await processAlert(
      fixture.webhookDeps,
      bound.config!,
      'uptime:73',
      null,
      observation.observations[0]!,
      new Date(),
    );
    let state = await snapshot(id, signal.id);
    const [beforeClear] = await fixture.admin.db
      .select()
      .from(incidents)
      .where(eq(incidents.id, incident.id));
    await fixture.webhookDeps.hub.resolveProviderClear(
      fixture.tenantId,
      incident.id,
      {
        lifecycleVersion: beforeClear!.lifecycleVersion,
        signalFence: serializeSignalFence([state.signal!]),
      },
      randomUUID(),
    );
    expect(
      (await fixture.admin.db.select().from(incidents).where(eq(incidents.id, incident.id)))[0]
        ?.status,
    ).toBe('open');
    expect(state.signal?.signalSource?.lifecycleVersion).toBeUndefined();
    firing = false;
    expect((await request(id, { mode: 'reconcile' })).status).toBe(200);
    state = await snapshot(id, signal.id);
    expect(state.signal?.providerClearGeneration).toBe(1);
    firing = true;
    expect((await request(id, { mode: 'reconcile' })).status).toBe(200);
    expect((await snapshot(id, signal.id)).signal?.providerClearGeneration).toBeNull();
    firing = false;
    expect((await request(id, { mode: 'reconcile' })).status).toBe(200);
    state = await snapshot(id, signal.id);
    expect(state.signal?.providerClearGeneration).toBe(1);
    const [currentIncident] = await fixture.admin.db
      .select()
      .from(incidents)
      .where(eq(incidents.id, incident.id));
    await fixture.webhookDeps.hub.resolveProviderClear(
      fixture.tenantId,
      incident.id,
      {
        lifecycleVersion: currentIncident!.lifecycleVersion,
        signalFence: serializeSignalFence([state.signal!]),
      },
      randomUUID(),
    );
    expect(
      (await fixture.admin.db.select().from(incidents).where(eq(incidents.id, incident.id)))[0]
        ?.status,
    ).toBe('resolved');
  } finally {
    firing = false;
  }
});

test('audited binding plus verified firing reports current coverage without changing historical unknown state or queuing recovery', async () => {
  const { id, signal } = await seed();
  await fixture.admin.db
    .update(incidentSignals)
    .set({ state: 'unknown' })
    .where(eq(incidentSignals.id, signal.id));
  firing = true;
  try {
    const preview = (await (
      await request(id, { mode: 'preview', signalId: signal.id, monitorId: '73', family: 'uptime' })
    ).json()) as Record<string, unknown>;
    expect(
      (
        await request(id, {
          ...preview,
          mode: 'bind',
          family: 'uptime',
          reason: 'Confirmed exact test',
        })
      ).status,
    ).toBe(200);
    const before = await snapshot(id, signal.id);
    const jobsBefore = await fixture.admin.db
      .select()
      .from(jobs)
      .where(eq(jobs.tenantId, fixture.tenantId));
    expect((await request(id, { mode: 'reconcile' })).status).toBe(200);
    expect(
      await fixture.admin.db.select().from(jobs).where(eq(jobs.tenantId, fixture.tenantId)),
    ).toEqual(jobsBefore);
    const after = await snapshot(id, signal.id);
    expect(after.signal).toMatchObject({
      providerClearGeneration: null,
      state: 'unknown',
      version: before.signal!.version,
      lastEventKey: before.signal!.lastEventKey,
    });
    expect(
      (await publicSignalCoverage(fixture.app.db, fixture.tenantId, [after.signal!]))[0],
    ).toMatchObject({ lifecycleCoverage: 'verified', verifiedProviderState: 'firing' });
  } finally {
    firing = false;
  }
});
test('binding takes response-group work locks before the incident and signal row locks', async () => {
  const { id, incident, signal } = await seed();
  const preview = (await (
    await request(id, { mode: 'preview', signalId: signal.id, monitorId: '73', family: 'uptime' })
  ).json()) as Record<string, unknown>;
  let releaseHolder!: () => void;
  const holderMayFinish = new Promise<void>((resolve) => (releaseHolder = resolve));
  let holderLocked!: () => void;
  const holderHasGroupLock = new Promise<void>((resolve) => (holderLocked = resolve));
  // Mirrors a signal writer: group work locks first, then the incident row.
  const holder: Promise<unknown> = fixture.admin.db.transaction(async (tx) => {
    await lockResponseGroupWorkTx(tx, fixture.tenantId, incident.id);
    holderLocked();
    await holderMayFinish;
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.id, incident.id))
      .for('update');
  });
  await holderHasGroupLock;
  const bound = request(id, {
    ...preview,
    mode: 'bind',
    family: 'uptime',
    reason: 'Verified the provider test configuration',
  });
  // Without an observed advisory wait the holder never contended, so the outcome proves nothing.
  try {
    await vi.waitFor(
      async () => {
        const waiting = await fixture.admin.db.execute(
          sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory'`,
        );
        if (waiting.length === 0) throw new Error('binding is not waiting on an advisory lock');
      },
      { timeout: 5_000, interval: 50 },
    );
  } finally {
    releaseHolder();
  }
  // An inverted order deadlocks here and Postgres aborts one side with 40P01.
  const [holderOutcome, bindOutcome] = await Promise.allSettled([holder, bound]);
  expect(holderOutcome.status === 'rejected' ? holderOutcome.reason : 'ok').toBe('ok');
  expect(bindOutcome.status === 'fulfilled' ? bindOutcome.value.status : bindOutcome.reason).toBe(
    200,
  );
  expect((await snapshot(id, signal.id)).signal).toMatchObject({ dataSourceId: id, version: 2 });
}, 20_000);
