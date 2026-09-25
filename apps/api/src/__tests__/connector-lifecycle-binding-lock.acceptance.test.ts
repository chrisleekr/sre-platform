import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import {
  ConnectorRegistry,
  makeStatusCakeConnector,
  statusCakeConnectorDefinition,
} from '@sre/connectors';
import {
  applySignalObservation,
  connectorConfigs,
  connectorCredentialKey,
  createIncident,
  lockConnectorLifecycle,
  recordSurfaceBinding,
  withTenant,
} from '@sre/db';
import type { TenantAuthVariables } from '../auth';
import type { ConnectorRouteContext } from '../connectors/routes/context';
import { registerConnectorLifecycleRoutes } from '../connectors/routes/lifecycle';
import { createFixture } from './alertmanager-webhook.fixture';

// Kept apart from connector-lifecycle-binding.acceptance.test.ts only for the file line cap; the
// StatusCake stub and seed mirror that file.
const fixture = createFixture();
const start = new Date(Date.now() - 600000);
const end = new Date(Date.now() - 60000);
const registry = new ConnectorRegistry([
  {
    ...statusCakeConnectorDefinition,
    create: (config) =>
      makeStatusCakeConnector(config, (async (input) => {
        const url = new URL(String(input));
        const id = url.pathname.split('/')[3]!;
        return Response.json(
          url.pathname.endsWith('/periods')
            ? {
                data: [
                  { status: 'down', created_at: start.toISOString(), ended_at: end.toISOString() },
                ],
                links: {},
              }
            : url.pathname.endsWith('/alerts')
              ? { data: [{ status: 'down', triggered_at: start.toISOString() }], links: {} }
              : { data: { id, name: `Monitor ${id}`, status: 'up', paused: false } },
        );
      }) as typeof fetch),
  },
]);
function request(id: string, body: Record<string, unknown>) {
  const routes = new Hono<{ Variables: TenantAuthVariables }>();
  routes.use('*', async (c, next) => {
    c.set('tenant', { tenantId: fixture.tenantId, userId: null } as never);
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
  return routes.request(`/statuscake/${id}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  const externalMessageId = randomUUID();
  const { signal } = await applySignalObservation(fixture.app.db, fixture.tenantId, {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C07ALERTS',
    externalMessageId,
    state: 'firing',
    summary: 'Historical stock notification',
    contentHash: 'original',
    eventKey: randomUUID(),
    eventAt: new Date(start.getTime() + 5000),
  });
  await withTenant(fixture.app.db, fixture.tenantId, (tx) =>
    recordSurfaceBinding(tx, fixture.tenantId, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C07ALERTS',
      threadId: externalMessageId,
      role: 'source',
    }),
  );
  return { id, signal };
}

test('binding waits for a concurrent connector save so the save cannot drop the new binding', async () => {
  const { id, signal } = await seed();
  const preview = (await (
    await request(id, { mode: 'preview', signalId: signal.id, monitorId: '73', family: 'uptime' })
  ).json()) as Record<string, unknown>;
  let releaseHolder!: () => void;
  const holderMayFinish = new Promise<void>((resolve) => (releaseHolder = resolve));
  let holderLocked!: () => void;
  const holderHasLock = new Promise<void>((resolve) => (holderLocked = resolve));
  // Mirrors a connector save: settings read under the lifecycle lock with no row lock, then
  // written back whole. Had binding committed in between, this write would erase it.
  const holder: Promise<unknown> = fixture.admin.db.transaction(async (tx) => {
    await lockConnectorLifecycle(tx, fixture.tenantId, id);
    const [config] = await tx.select().from(connectorConfigs).where(eq(connectorConfigs.id, id));
    holderLocked();
    await holderMayFinish;
    await tx
      .update(connectorConfigs)
      .set({ settings: config!.settings })
      .where(eq(connectorConfigs.id, id));
  });
  await holderHasLock;
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
  const [holderOutcome, bindOutcome] = await Promise.allSettled([holder, bound]);
  expect(holderOutcome.status === 'rejected' ? holderOutcome.reason : 'ok').toBe('ok');
  expect(bindOutcome.status === 'fulfilled' ? bindOutcome.value.status : bindOutcome.reason).toBe(
    200,
  );
  const [config] = await fixture.admin.db
    .select()
    .from(connectorConfigs)
    .where(eq(connectorConfigs.id, id));
  expect((config!.settings as { lifecycleBindings?: unknown[] }).lifecycleBindings).toEqual([
    expect.objectContaining({ signalId: signal.id, monitorId: '73' }),
  ]);
}, 20_000);
