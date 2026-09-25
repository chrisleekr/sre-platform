import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  countIncidentsByScope,
  entityServiceMappings,
  incidentSignals,
  incidentServiceAssignments,
  incidents,
  listIncidents,
  listIncidentsPage,
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
  test.each(['owned', 'teamless'] as const)(
    'explicit %s assignment overrides a provider and legacy owner',
    async (kind) => {
      const legacy = `legacy-${randomUUID()}`;
      const assigned = `assigned-${randomUUID()}`;
      await admin.db.insert(services).values([
        { tenantId, name: legacy, team: 'Legacy team' },
        { tenantId, name: assigned, team: kind === 'owned' ? 'Assigned team' : null },
      ]);
      const incident = await createIncident(app.db, tenantId, {
        fingerprint: randomUUID(),
        alertSource: 'test',
        service: legacy,
        severity: 'sev2',
      });
      const observedAt = new Date();
      await applySignalObservation(app.db, tenantId, {
        incidentId: incident.id,
        surface: 'slack',
        channel: 'C-ASSIGNED',
        externalMessageId: randomUUID(),
        state: 'firing',
        summary: 'Provider service unhealthy.',
        contentHash: randomUUID(),
        eventKey: randomUUID(),
        eventAt: observedAt,
        affectedEntities: [
          {
            key: `provider:service:${randomUUID()}`,
            kind: 'service',
            stableId: legacy,
            displayName: legacy,
            scope: {},
            provenance: { kind: 'provider_label', source: 'service' },
            confidence: 95,
            observedAt: observedAt.toISOString(),
            completeness: 'complete',
            requiredCapabilities: ['metrics'],
          },
        ],
      });
      await admin.db.insert(incidentServiceAssignments).values({
        tenantId,
        incidentId: incident.id,
        serviceName: assigned,
        confirmedByUserId: userId,
        rationale: 'Confirmed affected service.',
      });
      for (const db of [app.db, admin.db]) {
        const row = (await listIncidents(db, tenantId)).find((item) => item.id === incident.id);
        expect.soft(row?.responsibleOwner).toBe(kind === 'owned' ? 'Assigned team' : null);
      }
    },
  );

  test('multiple candidate-less assignments preserve distinct comma-bearing teams and paginated row identity', async () => {
    const countsBefore = await countIncidentsByScope(app.db, tenantId);
    const legacy = `page-legacy-${randomUUID()}`;
    const assigned = [randomUUID(), randomUUID(), randomUUID()];
    await admin.db.insert(services).values([
      { tenantId, name: legacy, team: 'Legacy team' },
      ...assigned.map((name, index) => ({
        tenantId,
        name,
        team: index === 1 ? 'Zulu' : 'Alpha, Operations',
      })),
    ]);
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const incident = await createIncident(app.db, tenantId, {
        fingerprint: randomUUID(),
        alertSource: 'test',
        service: legacy,
        severity: 'sev2',
      });
      ids.push(incident.id);
      for (let signalIndex = 0; signalIndex < 2; signalIndex++) {
        await applySignalObservation(app.db, tenantId, {
          incidentId: incident.id,
          surface: 'slack',
          channel: 'C-MULTI-OWNER',
          externalMessageId: randomUUID(),
          state: 'firing',
          summary: 'Unmapped provider observation.',
          contentHash: randomUUID(),
          eventKey: randomUUID(),
          eventAt: new Date(),
        });
      }
      await admin.db
        .update(incidents)
        .set({ createdAt: new Date(`2026-01-0${index + 1}T00:00:00Z`) })
        .where(eq(incidents.id, incident.id));
      await admin.db.insert(incidentServiceAssignments).values(
        assigned.map((serviceName) => ({
          tenantId,
          incidentId: incident.id,
          serviceName,
          confirmedByUserId: userId,
          rationale: 'Several confirmed affected services.',
        })),
      );
    }
    const first = await listIncidentsPage(app.db, tenantId, {
      scope: 'all',
      query: legacy,
      limit: 2,
    });
    expect(first.incidents.map((row) => row.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listIncidentsPage(app.db, tenantId, {
      scope: 'all',
      query: legacy,
      limit: 2,
      before: first.nextCursor!,
    });
    expect(second.incidents.map((row) => row.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    for (const row of [...first.incidents, ...second.incidents]) {
      expect.soft(row.responsibleOwner).toBe('Alpha, Operations, Zulu');
      expect(row.signalCount).toBe(2);
    }
    const active = (await listIncidents(app.db, tenantId)).filter((row) => row.service === legacy);
    expect(active).toHaveLength(3);
    expect(new Set(active.map((row) => row.id)).size).toBe(3);
    const countsAfter = await countIncidentsByScope(app.db, tenantId);
    expect(countsAfter.all).toBe(countsBefore.all + 3);
    expect(countsAfter.open).toBe(countsBefore.open + 3);
  });

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
