import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  incidentFeedback,
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  jobs,
  listIncidentFeedback,
  makeDb,
  memberships,
  mergeIncidents,
  recordIncidentFeedback,
  recordSurfaceBinding,
  splitMergedIncident,
  surfaceBindings,
  surfaceDeliveries,
  tenants,
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
  await admin.db.insert(tenants).values({ id: tenantId, name: 'relation-feedback' });
  await admin.db.insert(users).values({
    id: userId,
    issuer: 'test',
    subject: randomUUID(),
    email: 'relation-feedback@example.test',
  });
  await admin.db.insert(memberships).values({ tenantId, userId });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(surfaceDeliveries).where(eq(surfaceDeliveries.tenantId, tenantId));
    await admin.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await admin.db.delete(incidentFeedback).where(eq(incidentFeedback.tenantId, tenantId));
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(incidentRelations).where(eq(incidentRelations.tenantId, tenantId));
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(surfaceBindings).where(eq(surfaceBindings.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.db.delete(users).where(eq(users.id, userId));
    await admin.close();
  }
  if (app) await app.close();
});

describe('incident relation feedback ownership', () => {
  test('moves signal noise feedback with its signal through merge and split corrections', async () => {
    const source = await createIncident(app.db, tenantId, {
      fingerprint: `source-${randomUUID()}`,
      alertSource: 'slack',
      service: 'source-service',
      severity: 'sev2',
      investigationStatus: 'assessed',
    });
    const target = await createIncident(app.db, tenantId, {
      fingerprint: `target-${randomUUID()}`,
      alertSource: 'slack',
      service: 'target-service',
      severity: 'sev2',
      investigationStatus: 'assessed',
    });
    await recordSurfaceBinding(app.db, tenantId, {
      incidentId: source.id,
      surface: 'slack',
      channel: 'C-RELATION',
      threadId: randomUUID(),
    });
    await recordSurfaceBinding(app.db, tenantId, {
      incidentId: target.id,
      surface: 'slack',
      channel: 'C-RELATION',
      threadId: randomUUID(),
    });
    const observed = await applySignalObservation(app.db, tenantId, {
      incidentId: source.id,
      surface: 'slack',
      channel: 'C-RELATION',
      externalMessageId: randomUUID(),
      state: 'firing',
      summary: 'Source signal',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(),
    });
    await recordIncidentFeedback(app.db, tenantId, source.id, {
      targetType: 'noise',
      targetId: observed.signal.id,
      decision: 'noise',
      rationale: 'Responder classified this provider signal as noise.',
      createdByUserId: userId,
    });
    const correction = {
      sourceIncidentId: source.id,
      targetIncidentId: target.id,
      rationale: 'The alerts share the same current cause.',
      evidence: ['shared runtime evidence'],
      decidedByUserId: userId,
    };

    await mergeIncidents(app.db, tenantId, correction);
    expect(await listIncidentFeedback(app.db, tenantId, source.id)).toEqual([]);
    expect(await listIncidentFeedback(app.db, tenantId, target.id)).toEqual([
      expect.objectContaining({ targetType: 'noise', targetId: observed.signal.id }),
    ]);

    await splitMergedIncident(app.db, tenantId, correction);
    expect(await listIncidentFeedback(app.db, tenantId, target.id)).toEqual([]);
    expect(await listIncidentFeedback(app.db, tenantId, source.id)).toEqual([
      expect.objectContaining({ targetType: 'noise', targetId: observed.signal.id }),
    ]);
  });
});
