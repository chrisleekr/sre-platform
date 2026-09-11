import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  entityServiceMappings,
  incidentSignals,
  incidents,
  listIncidents,
  makeDb,
  memberships,
  services,
  tenants,
  upsertEntityServiceMapping,
  users,
  type DbHandle,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let userId: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  userId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'owner-resolution' });
  await admin.db.insert(users).values({
    id: userId,
    issuer: 'test',
    subject: randomUUID(),
    email: 'owner-resolution@example.test',
  });
  await admin.db.insert(memberships).values({ tenantId, userId });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db
      .delete(entityServiceMappings)
      .where(eq(entityServiceMappings.tenantId, tenantId));
    await admin.db.delete(services).where(eq(services.tenantId, tenantId));
    await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.db.delete(users).where(eq(users.id, userId));
    await admin.close();
  }
  if (app) await app.close();
});

describe('incident owner resolution', () => {
  test('does not fall back to a legacy team after a mapped entity resolves to a teamless service', async () => {
    const legacyService = `legacy-${randomUUID()}`;
    const mappedService = `mapped-${randomUUID()}`;
    const candidateKey = `runtime:workload:${randomUUID()}`;
    await admin.db.insert(services).values([
      { tenantId, name: legacyService, team: 'legacy-on-call' },
      { tenantId, name: mappedService, team: null },
    ]);
    const incident = await createIncident(app.db, tenantId, {
      fingerprint: `owner-${randomUUID()}`,
      alertSource: 'test',
      service: legacyService,
      severity: 'sev2',
    });
    await upsertEntityServiceMapping(app.db, tenantId, {
      candidateKey,
      candidateKind: 'workload',
      serviceName: mappedService,
      confirmedByUserId: userId,
      rationale: 'The workload belongs to the mapped service.',
    });
    const observedAt = new Date();
    await applySignalObservation(app.db, tenantId, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-OWNER',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Mapped workload is unhealthy.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: observedAt,
      affectedEntities: [
        {
          key: candidateKey,
          kind: 'workload',
          stableId: 'runtime-controller',
          displayName: 'runtime-controller',
          scope: { namespace: 'runtime' },
          provenance: { kind: 'provider_label', source: 'pod' },
          confidence: 90,
          observedAt: observedAt.toISOString(),
          completeness: 'complete',
          requiredCapabilities: ['runtime'],
        },
      ],
    });

    expect(
      (await listIncidents(app.db, tenantId)).find((row) => row.id === incident.id),
    ).toMatchObject({
      responsibleOwner: null,
    });

    await admin.db
      .update(services)
      .set({ team: 'mapped-on-call', updatedAt: sql`now()` })
      .where(and(eq(services.tenantId, tenantId), eq(services.name, mappedService)));
    expect(
      (await listIncidents(app.db, tenantId)).find((row) => row.id === incident.id),
    ).toMatchObject({
      responsibleOwner: 'mapped-on-call',
    });
  });

  test('does not fall back to a legacy team for an exact teamless catalog service candidate', async () => {
    const legacyService = `legacy-exact-${randomUUID()}`;
    const exactService = `exact-${randomUUID()}`;
    const candidateKey = `provider:service:${randomUUID()}`;
    await admin.db.insert(services).values([
      { tenantId, name: legacyService, team: 'legacy-on-call' },
      { tenantId, name: exactService, team: null },
    ]);
    const incident = await createIncident(app.db, tenantId, {
      fingerprint: `exact-owner-${randomUUID()}`,
      alertSource: 'test',
      service: legacyService,
      severity: 'sev2',
    });
    const observedAt = new Date();
    await applySignalObservation(app.db, tenantId, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-OWNER-EXACT',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Exact catalog service is unhealthy.',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: observedAt,
      affectedEntities: [
        {
          key: candidateKey,
          kind: 'service',
          stableId: exactService,
          displayName: exactService,
          scope: {},
          provenance: { kind: 'provider_label', source: 'service' },
          confidence: 95,
          observedAt: observedAt.toISOString(),
          completeness: 'complete',
          requiredCapabilities: ['metrics'],
        },
      ],
    });

    expect(
      (await listIncidents(app.db, tenantId)).find((row) => row.id === incident.id),
    ).toMatchObject({ responsibleOwner: null });
  });
});
