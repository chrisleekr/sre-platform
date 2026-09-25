import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  applySignalObservation,
  connectorConfigs,
  createIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
  makeDb,
  signalDispositions,
  tenants,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '@sre/hub';
import { Queue } from '@sre/queue';
import {
  hash,
  investigationMaterial,
  signalObservation,
  type NormalizedAlert,
} from '../provider-lifecycle/normalize';
import { updateAcceptedEpisode } from '../provider-lifecycle/update-episode';

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let hub: ConversationHub;
let queue: Queue;
const tenantId = randomUUID();

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: null });
  hub = new ConversationHub(app.db, redis);
  queue = new Queue(admin.db, redis);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'provider generation repeat' });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(jobs).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(signalDispositions).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidentMessages).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidentSignals).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(connectorConfigs).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.close();
  }
  if (app) await app.close();
  if (redis) await redis.quit();
});

const startsAt = new Date('2026-09-01T00:00:00.000Z');
const firstSeen = new Date('2026-09-01T00:01:00.000Z');
const repeatSeen = new Date('2026-09-01T00:05:00.000Z');

function alert(status: 'firing' | 'resolved' = 'firing'): NormalizedAlert {
  return {
    status,
    fingerprint: randomUUID().replaceAll('-', '').slice(0, 16),
    monitorIdentity: null,
    startsAt,
    endsAt: status === 'resolved' ? new Date('2026-09-01T00:03:00.000Z') : null,
    alertName: 'CheckoutErrors',
    labels: { alertname: 'CheckoutErrors', severity: 'critical', service: 'checkout' },
    annotations: { summary: 'Checkout error rate is high' },
    generatorUrl: null,
  };
}

async function workspace(): Promise<{ connectorId: string; incidentId: string }> {
  const [connector] = await admin.db
    .insert(connectorConfigs)
    .values({ tenantId, type: 'prometheus', name: randomUUID(), lifecycleVersion: 0 })
    .returning({ id: connectorConfigs.id });
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: `generation-repeat-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev1',
  });
  return { connectorId: connector!.id, incidentId: incident.id };
}

async function bumpGeneration(connectorId: string): Promise<void> {
  await admin.db
    .update(connectorConfigs)
    .set({ lifecycleVersion: 1 })
    .where(eq(connectorConfigs.id, connectorId));
}

async function markRecovering(incidentId: string): Promise<void> {
  await admin.db
    .update(incidents)
    .set({ recoveryState: 'monitoring', recoverySummary: 'Watching the error rate' })
    .where(eq(incidents.id, incidentId));
}

async function state(incidentId: string) {
  const [signal] = await admin.db
    .select()
    .from(incidentSignals)
    .where(eq(incidentSignals.incidentId, incidentId));
  const [incident] = await admin.db.select().from(incidents).where(eq(incidents.id, incidentId));
  const reassessments = await admin.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.type, 'signal.reassess'),
        sql`${jobs.payload}->>'incidentId' = ${incidentId}`,
      ),
    );
  return { signal: signal!, incident: incident!, reassessments: reassessments.length };
}

async function deliverRepeat(
  connectorId: string,
  incidentId: string,
  observed: NormalizedAlert,
): Promise<void> {
  await updateAcceptedEpisode(
    { appDb: app.db, hub, route: { appDb: app.db, redis, queue }, postAlertRoot: vi.fn() },
    tenantId,
    connectorId,
    incidentId,
    'group',
    observed,
    hash(investigationMaterial(observed)),
    repeatSeen,
    { channel: 'C-alerts', threadId: `${randomUUID()}` },
    1,
    1,
  );
}

test('an unchanged firing repeat under a new connector generation refreshes freshness only', async () => {
  const { connectorId, incidentId } = await workspace();
  const firing = alert();
  const materialHash = hash(investigationMaterial(firing));
  await applySignalObservation(app.db, tenantId, {
    incidentId,
    ...signalObservation(connectorId, 'group', firing, materialHash, firstSeen, 0),
  });
  const before = await state(incidentId);
  expect(before.signal.signalSource?.lifecycleVersion).toBe(0);
  await markRecovering(incidentId);
  await bumpGeneration(connectorId);

  await deliverRepeat(connectorId, incidentId, firing);

  const after = await state(incidentId);
  expect(after.signal.version).toBe(before.signal.version);
  expect(after.signal.lastEventKey).toBe(before.signal.lastEventKey);
  expect(after.signal.lastSeenAt).toEqual(repeatSeen);
  expect(after.signal.signalSource?.lifecycleVersion).toBe(1);
  expect(after.signal.signalSource?.lifecycleState).toBe('firing');
  expect(after.incident.recoveryState).toBe('monitoring');
  expect(after.reassessments).toBe(0);
});

test('an unchanged firing repeat on a signal stored before generations existed refreshes freshness only', async () => {
  const { connectorId, incidentId } = await workspace();
  const firing = alert();
  const materialHash = hash(investigationMaterial(firing));
  const legacy = signalObservation(connectorId, 'group', firing, materialHash, firstSeen);
  // Rows written before connector generations carried no generation in the source or event identity.
  const { lifecycleVersion: _omitted, ...legacySource } = legacy.signalSource!;
  await applySignalObservation(app.db, tenantId, {
    incidentId,
    ...legacy,
    signalSource: legacySource,
    contentHash: hash({ status: 'firing', materialHash, endsAt: undefined }),
    eventKey: `${legacy.externalMessageId}:firing:${materialHash}:`,
  });
  const before = await state(incidentId);
  expect(before.signal.signalSource?.lifecycleVersion).toBeUndefined();
  await markRecovering(incidentId);
  await bumpGeneration(connectorId);

  await deliverRepeat(connectorId, incidentId, firing);

  const after = await state(incidentId);
  expect(after.signal.version).toBe(before.signal.version);
  expect(after.signal.lastSeenAt).toEqual(repeatSeen);
  expect(after.signal.signalSource?.lifecycleVersion).toBe(1);
  expect(after.incident.recoveryState).toBe('monitoring');
  expect(after.reassessments).toBe(0);
});

test('an unchanged provider clear under a new connector generation still re-certifies the clear', async () => {
  const { connectorId, incidentId } = await workspace();
  const firing = alert();
  const resolved = { ...alert('resolved'), fingerprint: firing.fingerprint };
  const materialHash = hash(investigationMaterial(firing));
  await applySignalObservation(app.db, tenantId, {
    incidentId,
    ...signalObservation(connectorId, 'group', firing, materialHash, firstSeen, 0),
  });
  const cleared = await applySignalObservation(app.db, tenantId, {
    incidentId,
    ...signalObservation(
      connectorId,
      'group',
      resolved,
      materialHash,
      new Date('2026-09-01T00:03:00.000Z'),
      0,
    ),
  });
  expect(cleared.signal.providerClearGeneration).toBe(0);

  const recertified = await applySignalObservation(app.db, tenantId, {
    incidentId,
    ...signalObservation(connectorId, 'group', resolved, materialHash, repeatSeen, 1),
  });

  expect(recertified.applied).toBe(true);
  expect(recertified.signal.version).toBe(cleared.signal.version + 1);
  expect(recertified.signal.providerClearGeneration).toBe(1);
  expect(recertified.signal.signalSource?.lifecycleVersion).toBe(1);
});

test('an unchanged firing repeat from an older connector generation never moves the source back', async () => {
  const { connectorId, incidentId } = await workspace();
  const firing = alert();
  const materialHash = hash(investigationMaterial(firing));
  await applySignalObservation(app.db, tenantId, {
    incidentId,
    ...signalObservation(connectorId, 'group', firing, materialHash, firstSeen, 1),
  });
  const before = await state(incidentId);
  expect(before.signal.signalSource?.lifecycleVersion).toBe(1);

  // A slow worker still on generation 0 can deliver after generation 1 with a newer event time.
  const stale = await applySignalObservation(app.db, tenantId, {
    incidentId,
    ...signalObservation(connectorId, 'group', firing, materialHash, repeatSeen, 0),
  });

  expect(stale.applied).toBe(false);
  const after = await state(incidentId);
  expect(after.signal.version).toBe(before.signal.version);
  expect(after.signal.lastSeenAt).toEqual(repeatSeen);
  expect(after.signal.signalSource?.lifecycleVersion).toBe(1);
});
