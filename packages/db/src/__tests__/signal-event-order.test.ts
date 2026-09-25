import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  incidentSignals,
  incidents,
  makeDb,
  tenants,
  type DbHandle,
} from '../index';

let admin: DbHandle;
let app: DbHandle;
const tenantId = randomUUID();

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'signal exact ordering' });
});

afterAll(async () => {
  await admin.db.delete(incidentSignals).where(sql`tenant_id = ${tenantId}`);
  await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
  await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
  await app.close();
  await admin.close();
});

test('applies a newer refire when opposite Slack edits share one millisecond', async () => {
  const incidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: `signal-microseconds-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  const externalMessageId = `microseconds-${randomUUID()}`;
  const eventAt = new Date('2026-08-21T01:00:00.000Z');
  const base = {
    incidentId,
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId,
    state: 'firing' as const,
    summary: 'Checkout error rate is high',
    contentHash: 'microseconds-initial',
    eventKey: 'microseconds:firing:initial',
    eventAt,
  };
  await applySignalObservation(app.db, tenantId, {
    ...base,
    eventVersion: '1787274000000000',
  });
  const resolved = await applySignalObservation(app.db, tenantId, {
    ...base,
    state: 'resolved',
    summary: '[RESOLVED] Checkout error rate',
    contentHash: 'microseconds-resolved',
    eventKey: 'microseconds:resolved',
    eventVersion: '1787274000000001',
  });
  const refired = await applySignalObservation(app.db, tenantId, {
    ...base,
    summary: 'Checkout error rate is high again',
    contentHash: 'microseconds-refired',
    eventKey: 'microseconds:firing:newer',
    eventVersion: '1787274000000999',
  });

  expect(resolved).toMatchObject({ applied: true, signal: { state: 'resolved' } });
  expect(refired).toMatchObject({
    applied: true,
    eventType: 'refired',
    signal: { state: 'firing', lastEventVersion: 1787274000000999 },
  });
});

test('keeps a newer old-writer timestamp above an older exact event version', async () => {
  const incidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: `signal-rolling-writer-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  const eventAt = new Date('2026-08-21T01:00:00.000Z');
  const externalMessageId = `rolling-writer-${randomUUID()}`;
  const initial = await applySignalObservation(app.db, tenantId, {
    incidentId,
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId,
    state: 'firing',
    summary: 'Initial exact observation',
    contentHash: 'rolling-initial',
    eventKey: 'rolling:initial',
    eventAt,
    eventVersion: '1787274000000001',
  });
  await admin.db
    .update(incidentSignals)
    .set({
      lastEventAt: new Date('2026-08-21T01:00:00.001Z'),
      summary: 'Newer observation from an old worker',
      contentHash: 'rolling-old-writer',
    })
    .where(eq(incidentSignals.id, initial.signal.id));

  const delayed = await applySignalObservation(app.db, tenantId, {
    incidentId,
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId,
    state: 'resolved',
    summary: 'Delayed observation',
    contentHash: 'rolling-delayed',
    eventKey: 'rolling:delayed',
    eventAt,
    eventVersion: '1787274000000999',
  });

  expect(delayed).toMatchObject({ applied: false });
  expect(delayed.signal).toMatchObject({
    state: 'firing',
    summary: 'Newer observation from an old worker',
    lastEventVersion: 1787274000001999,
  });
});

test('treats a legacy millisecond timestamp as the end of its millisecond', async () => {
  const incidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: `signal-legacy-millisecond-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  const externalMessageId = `legacy-millisecond-${randomUUID()}`;
  const inserted = await admin.db
    .insert(incidentSignals)
    .values({
      tenantId,
      incidentId,
      surface: 'slack',
      channel: 'C-alerts',
      externalMessageId,
      state: 'firing',
      lastEventType: 'opened',
      summary: 'Legacy observation',
      contentHash: 'legacy-millisecond',
      lastEventKey: 'legacy:millisecond',
      lastEventAt: new Date('2026-08-21T01:00:00.001Z'),
      lastEventVersion: null,
    })
    .returning({ id: incidentSignals.id });

  const delayed = await applySignalObservation(app.db, tenantId, {
    incidentId,
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId,
    state: 'resolved',
    summary: 'Delayed exact observation',
    contentHash: 'legacy-millisecond-delayed',
    eventKey: 'legacy:millisecond:delayed',
    eventAt: new Date('2026-08-21T01:00:00.001Z'),
    eventVersion: '1787274000001500',
  });

  expect(delayed).toMatchObject({
    applied: false,
    signal: {
      id: inserted[0]!.id,
      state: 'firing',
      summary: 'Legacy observation',
      lastEventVersion: null,
    },
  });
});

test('stores a new imprecise observation at the end of its millisecond', async () => {
  const incidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: `signal-imprecise-millisecond-${randomUUID()}`,
      alertSource: 'dashboard',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  const externalMessageId = `imprecise-millisecond-${randomUUID()}`;
  const eventAt = new Date('2026-08-21T01:00:00.003Z');
  const initial = await applySignalObservation(app.db, tenantId, {
    incidentId,
    surface: 'dashboard',
    channel: 'platform',
    externalMessageId,
    state: 'firing',
    summary: 'Imprecise observation',
    contentHash: 'imprecise-millisecond',
    eventKey: 'imprecise:millisecond',
    eventAt,
  });
  const delayed = await applySignalObservation(app.db, tenantId, {
    incidentId,
    surface: 'dashboard',
    channel: 'platform',
    externalMessageId,
    state: 'resolved',
    summary: 'Delayed exact observation',
    contentHash: 'imprecise-millisecond-delayed',
    eventKey: 'imprecise:millisecond:delayed',
    eventAt,
    eventVersion: '1787274000003500',
  });

  expect(initial).toMatchObject({
    applied: true,
    signal: { lastEventVersion: 1787274000003999 },
  });
  expect(delayed).toMatchObject({
    applied: false,
    signal: { state: 'firing', summary: 'Imprecise observation' },
  });
});

test('current observation handling preserves legacy null ordering and the floor projected by an old writer', async () => {
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
  });
  const signalId = randomUUID();
  const externalMessageId = randomUUID();
  await admin.db.insert(incidentSignals).values({
    id: signalId,
    tenantId,
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C_ORDER',
    externalMessageId,
    state: 'firing',
    lastEventType: 'opened',
    summary: 'Legacy checkout alert',
    contentHash: 'legacy-hash',
    lastEventKey: 'legacy-event',
    lastEventAt: new Date('2026-08-21T01:00:00.000Z'),
    lastEventVersion: null,
  });
  const observation = {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C_ORDER',
    externalMessageId,
    state: 'firing' as const,
    summary: 'Legacy checkout alert updated',
    contentHash: 'legacy-updated-hash',
  };
  const older = await applySignalObservation(app.db, tenantId, {
    ...observation,
    eventKey: 'legacy-older',
    eventAt: new Date('2026-08-21T00:59:59.999Z'),
    eventVersion: '1787273999999999',
  });
  const newer = await applySignalObservation(app.db, tenantId, {
    ...observation,
    eventKey: 'legacy-newer',
    eventAt: new Date('2026-08-21T01:00:00.001Z'),
    eventVersion: '1787274000001000',
  });
  expect(older.applied).toBe(false);
  expect(newer).toMatchObject({
    applied: true,
    signal: { id: signalId, lastEventVersion: 1787274000001000 },
  });
  await admin.db
    .update(incidentSignals)
    .set({
      lastEventAt: new Date('2026-08-21T01:00:00.002Z'),
      summary: 'newer old writer observation',
    })
    .where(eq(incidentSignals.id, signalId));
  const delayedSameMillisecond = await applySignalObservation(app.db, tenantId, {
    ...observation,
    state: 'resolved',
    summary: 'delayed exact observation',
    contentHash: 'delayed-exact-hash',
    eventKey: 'legacy-delayed-same-millisecond',
    eventAt: new Date('2026-08-21T01:00:00.002Z'),
    eventVersion: '1787274000002500',
  });
  expect(delayedSameMillisecond).toMatchObject({
    applied: false,
    signal: { summary: 'newer old writer observation', lastEventVersion: 1787274000002999 },
  });
});
