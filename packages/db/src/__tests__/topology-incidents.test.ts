import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  incidents,
  listTopologyIncidentServices,
  makeDb,
  memberships,
  services,
  surfaceBindings,
  tenants,
  upsertEntityServiceMapping,
  users,
  type DbHandle,
} from '../index';

let admin: DbHandle;
let app: DbHandle;
const tenantId = randomUUID();
const otherTenant = randomUUID();
const userId = randomUUID();

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values([
    { id: tenantId, name: 'Topology mapping test' },
    { id: otherTenant, name: 'Other topology' },
  ]);
  await admin.db.insert(users).values({ id: userId, issuer: 'test', subject: randomUUID() });
  await admin.db.insert(memberships).values({ userId, tenantId });
  await admin.db.insert(services).values([
    { tenantId, name: 'checkout' },
    { tenantId, name: 'payments' },
  ]);
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, otherTenant));
    await admin.db.delete(users).where(eq(users.id, userId));
    await admin.close();
  }
  if (app) await app.close();
});

test('confirmed mapping overrides exact candidate and legacy service; unresolved transport is not a service', async () => {
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'test',
    service: 'slack:C-TOPOLOGY',
    severity: 'sev2',
  });
  await admin.db.insert(surfaceBindings).values({
    tenantId,
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C-TOPOLOGY',
    threadId: '1',
  });
  expect(await listTopologyIncidentServices(app.db, tenantId)).toContainEqual({
    incidentId: incident.id,
    services: [],
    incident: expect.objectContaining({ id: incident.id, service: 'slack:C-TOPOLOGY' }),
  });
  const key = `service:${randomUUID()}`;
  const observedAt = new Date();
  await applySignalObservation(app.db, tenantId, {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C-TOPOLOGY',
    externalMessageId: '1',
    state: 'firing',
    summary: 'Test service failure',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: observedAt,
    affectedEntities: [
      {
        key,
        kind: 'service',
        stableId: 'checkout',
        displayName: 'Checkout',
        scope: {},
        provenance: { kind: 'provider_label', source: 'service' },
        confidence: 90,
        observedAt: observedAt.toISOString(),
        completeness: 'complete',
        requiredCapabilities: [],
      },
    ],
  });
  expect(await listTopologyIncidentServices(app.db, tenantId)).toContainEqual({
    incidentId: incident.id,
    services: ['checkout'],
    incident: expect.objectContaining({ id: incident.id }),
  });
  await upsertEntityServiceMapping(app.db, tenantId, {
    candidateKey: key,
    candidateKind: 'service',
    serviceName: 'payments',
    confirmedByUserId: userId,
    rationale: 'Correct the affected service.',
  });
  expect(await listTopologyIncidentServices(app.db, tenantId)).toContainEqual({
    incidentId: incident.id,
    services: ['payments'],
    incident: expect.objectContaining({ id: incident.id }),
  });
  expect(await listTopologyIncidentServices(app.db, otherTenant)).toEqual([]);
});

test('retains a real legacy service and excludes closed incidents', async () => {
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'test',
    service: 'legacy-service',
    severity: 'sev3',
  });
  expect(await listTopologyIncidentServices(app.db, tenantId)).toContainEqual({
    incidentId: incident.id,
    services: ['legacy-service'],
    incident: expect.objectContaining({ id: incident.id }),
  });
  await admin.db.update(incidents).set({ status: 'closed' }).where(eq(incidents.id, incident.id));
  expect(
    (await listTopologyIncidentServices(app.db, tenantId)).some(
      (row) => row.incidentId === incident.id,
    ),
  ).toBe(false);
});
