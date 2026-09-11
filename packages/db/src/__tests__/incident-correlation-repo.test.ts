import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  applySignalObservationTx,
  connectorConfigs,
  createIncident,
  decideIncidentEpisodeRouteTx,
  incidentRelations,
  incidentSignals,
  incidents,
  makeDb,
  recordIncidentRelation,
  recordSignalCorrelationDecisionTx,
  recordUnrelatedIncidents,
  tenants,
  withTenant,
  type DbHandle,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let dataSourceId: string;

function correlationDecisionFields(
  windowStartedAt: Date,
  windowExpiresAt: Date,
  maxIncidentAgeAt: Date,
) {
  return {
    correlationMethod: 'new_incident' as const,
    correlationRationale: 'Test fixture records a complete provider-neutral routing decision.',
    correlationFeatures: ['stable_subject_identity'],
    correlationConfidence: 100,
    correlationWindowStartedAt: windowStartedAt,
    correlationWindowExpiresAt: windowExpiresAt,
    correlationMaxAgeAt: maxIncidentAgeAt,
  };
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  dataSourceId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Correlation policy tenant' });
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(connectorConfigs).values({
      id: dataSourceId,
      tenantId,
      name: 'Metrics source',
      type: 'prometheus',
      settings: {},
    }),
  );
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentRelations).where(eq(incidentRelations.tenantId, tenantId));
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

async function incidentWithSignal(
  subjectKey: string,
  eventAt: Date,
  state: 'firing' | 'resolved' = 'firing',
): Promise<{ incidentId: string; signalId: string }> {
  const incidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  const signal = await withTenant(app.db, tenantId, (tx) =>
    applySignalObservationTx(tx, tenantId, {
      incidentId,
      dataSourceId,
      provider: 'alertmanager',
      providerFingerprint: randomUUID(),
      monitorKey: subjectKey,
      startsAt: eventAt,
      surface: 'slack',
      channel: 'C-CORRELATION',
      externalMessageId: randomUUID(),
      state,
      summary: subjectKey,
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt,
    }),
  );
  return { incidentId, signalId: signal.signal.id };
}

test('groups only inside the rolling window and records an explainable signal decision', async () => {
  const subjectKey = `monitor:${randomUUID()}`;
  const firstSeenAt = new Date();
  const seeded = await incidentWithSignal(subjectKey, firstSeenAt);
  const decision = await withTenant(app.db, tenantId, (tx) =>
    decideIncidentEpisodeRouteTx(tx, tenantId, {
      dataSourceId,
      subjectKey,
      observedAt: new Date(firstSeenAt.getTime() + 4 * 60_000),
      groupingWindowMs: 5 * 60_000,
      maxIncidentAgeMs: 24 * 60 * 60_000,
      allowGrouping: true,
    }),
  );
  expect(decision).toMatchObject({
    incident: { id: seeded.incidentId },
    method: 'stable_subject_window',
    confidence: 100,
    features: expect.arrayContaining(['stable_subject_identity', 'inside_rolling_window']),
  });

  await withTenant(app.db, tenantId, (tx) =>
    recordSignalCorrelationDecisionTx(tx, seeded.signalId, decision),
  );
  const rows = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(incidentSignals).where(eq(incidentSignals.id, seeded.signalId)),
  );
  expect(rows[0]).toMatchObject({
    correlationMethod: 'stable_subject_window',
    correlationConfidence: 100,
    correlationFeatures: expect.arrayContaining(['inside_incident_age_limit']),
  });
  const incidentRows = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(incidents).where(eq(incidents.id, seeded.incidentId)),
  );
  expect(incidentRows[0]?.correlationMaxAgeAt).toEqual(decision.maxIncidentAgeAt);

  const expired = await withTenant(app.db, tenantId, (tx) =>
    decideIncidentEpisodeRouteTx(tx, tenantId, {
      dataSourceId,
      subjectKey,
      observedAt: new Date(firstSeenAt.getTime() + 10 * 60_000),
      groupingWindowMs: 60 * 60_000,
      maxIncidentAgeMs: 24 * 60 * 60_000,
      allowGrouping: true,
    }),
  );
  expect(expired).toMatchObject({
    incident: null,
    method: 'new_incident',
    features: expect.arrayContaining(['rolling_window_expired']),
  });
});

test('a resolved grouped episode still advances the rolling window while another signal fires', async () => {
  const subjectKey = `monitor:${randomUUID()}`;
  const firstSeenAt = new Date();
  const seeded = await incidentWithSignal(subjectKey, firstSeenAt);
  const second = await withTenant(app.db, tenantId, (tx) =>
    applySignalObservationTx(tx, tenantId, {
      incidentId: seeded.incidentId,
      dataSourceId,
      provider: 'alertmanager',
      providerFingerprint: randomUUID(),
      monitorKey: subjectKey,
      startsAt: new Date(firstSeenAt.getTime() + 4 * 60_000),
      surface: 'slack',
      channel: 'C-CORRELATION',
      externalMessageId: randomUUID(),
      state: 'resolved',
      summary: subjectKey,
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(firstSeenAt.getTime() + 4 * 60_000),
    }),
  );
  await withTenant(app.db, tenantId, async (tx) => {
    const maxIncidentAgeAt = new Date(firstSeenAt.getTime() + 24 * 60 * 60_000);
    await tx
      .update(incidents)
      .set({ correlationMaxAgeAt: maxIncidentAgeAt })
      .where(eq(incidents.id, seeded.incidentId));
    await tx
      .update(incidentSignals)
      .set({
        firstSeenAt,
        ...correlationDecisionFields(
          firstSeenAt,
          new Date(firstSeenAt.getTime() + 5 * 60_000),
          maxIncidentAgeAt,
        ),
      })
      .where(eq(incidentSignals.id, seeded.signalId));
    const secondSeenAt = new Date(firstSeenAt.getTime() + 4 * 60_000);
    await tx
      .update(incidentSignals)
      .set({
        firstSeenAt: secondSeenAt,
        ...correlationDecisionFields(
          secondSeenAt,
          new Date(firstSeenAt.getTime() + 9 * 60_000),
          maxIncidentAgeAt,
        ),
      })
      .where(eq(incidentSignals.id, second.signal.id));
  });

  const decision = await withTenant(app.db, tenantId, (tx) =>
    decideIncidentEpisodeRouteTx(tx, tenantId, {
      dataSourceId,
      subjectKey,
      observedAt: new Date(firstSeenAt.getTime() + 8 * 60_000),
      groupingWindowMs: 5 * 60_000,
      maxIncidentAgeMs: 24 * 60 * 60_000,
      allowGrouping: true,
    }),
  );
  expect(decision).toMatchObject({
    incident: { id: seeded.incidentId },
    method: 'stable_subject_window',
  });

  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(incidentSignals)
      .set({ correlationWindowExpiresAt: new Date(firstSeenAt.getTime() + 60 * 60_000) })
      .where(eq(incidentSignals.id, seeded.signalId)),
  );
  const latestPolicyWins = await withTenant(app.db, tenantId, (tx) =>
    decideIncidentEpisodeRouteTx(tx, tenantId, {
      dataSourceId,
      subjectKey,
      observedAt: new Date(firstSeenAt.getTime() + 20 * 60_000),
      groupingWindowMs: 5 * 60_000,
      maxIncidentAgeMs: 24 * 60 * 60_000,
      allowGrouping: true,
    }),
  );
  expect(latestPolicyWins).toMatchObject({
    incident: null,
    method: 'new_incident',
    features: expect.arrayContaining(['rolling_window_expired']),
  });
});

test('attributed responder feedback can force future matching episodes to stay separate', async () => {
  const subjectKey = `monitor:${randomUUID()}`;
  const eventAt = new Date();
  const active = await incidentWithSignal(subjectKey, eventAt);
  const reference = await incidentWithSignal(subjectKey, eventAt, 'resolved');
  await expect(
    recordIncidentRelation(app.db, tenantId, {
      sourceIncidentId: active.incidentId,
      targetIncidentId: reference.incidentId,
      type: 'possible_related',
      rationale: 'A system route tried to create responder feedback.',
      evidence: ['invalid feedback authority'],
      decidedBy: 'system',
      correlationFeedback: {
        decision: 'separate',
        sourceScopeKeys: ['source'],
        targetScopeKeys: ['target'],
        sharedScopeKeys: ['shared'],
      },
    }),
  ).rejects.toThrow('correlation feedback requires an attributed responder');
  const relation = await recordUnrelatedIncidents(app.db, tenantId, {
    sourceIncidentId: active.incidentId,
    targetIncidentId: reference.incidentId,
    rationale: 'The two episodes had different causes.',
    evidence: ['trace:different'],
    decidedByUserId: randomUUID(),
  });
  expect(relation.correlationFeedback).toMatchObject({
    decision: 'separate',
    sharedScopeKeys: [expect.any(String)],
  });

  const decision = await withTenant(app.db, tenantId, (tx) =>
    decideIncidentEpisodeRouteTx(tx, tenantId, {
      dataSourceId,
      subjectKey,
      observedAt: new Date(eventAt.getTime() + 60_000),
      groupingWindowMs: 5 * 60_000,
      maxIncidentAgeMs: 24 * 60 * 60_000,
      allowGrouping: true,
    }),
  );
  expect(decision).toMatchObject({
    incident: null,
    method: 'new_incident',
    appliedFeedback: 'separate',
    features: expect.arrayContaining(['human_separate_feedback']),
  });
});

test('the hard incident age stops grouping even when the rolling window is fresh', async () => {
  const subjectKey = `monitor:${randomUUID()}`;
  const observedAt = new Date();
  const seeded = await incidentWithSignal(subjectKey, observedAt);
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(incidents)
      .set({ createdAt: new Date(observedAt.getTime() - 25 * 60 * 60_000) })
      .where(eq(incidents.id, seeded.incidentId)),
  );

  const decision = await withTenant(app.db, tenantId, (tx) =>
    decideIncidentEpisodeRouteTx(tx, tenantId, {
      dataSourceId,
      subjectKey,
      observedAt: new Date(observedAt.getTime() + 60_000),
      groupingWindowMs: 5 * 60_000,
      maxIncidentAgeMs: 24 * 60 * 60_000,
      allowGrouping: true,
    }),
  );
  expect(decision).toMatchObject({
    incident: null,
    method: 'new_incident',
    features: expect.arrayContaining(['incident_age_limit_reached']),
  });
});

test('an expired active incident does not make a newer eligible incident ambiguous', async () => {
  const subjectKey = `monitor:${randomUUID()}`;
  const observedAt = new Date();
  const expired = await incidentWithSignal(subjectKey, observedAt);
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(incidents)
      .set({ createdAt: new Date(observedAt.getTime() - 25 * 60 * 60_000) })
      .where(eq(incidents.id, expired.incidentId)),
  );
  const current = await incidentWithSignal(subjectKey, new Date(observedAt.getTime() + 1_000));

  const decision = await withTenant(app.db, tenantId, (tx) =>
    decideIncidentEpisodeRouteTx(tx, tenantId, {
      dataSourceId,
      subjectKey,
      observedAt: new Date(observedAt.getTime() + 60_000),
      groupingWindowMs: 5 * 60_000,
      maxIncidentAgeMs: 24 * 60 * 60_000,
      allowGrouping: true,
    }),
  );
  expect(decision).toMatchObject({
    incident: { id: current.incidentId },
    method: 'stable_subject_window',
  });
});

test('moving a younger episode into an older incident cannot extend the hard age stop', async () => {
  const subjectKey = `monitor:${randomUUID()}`;
  const observedAt = new Date();
  const older = await incidentWithSignal(subjectKey, new Date(observedAt.getTime() - 60_000));
  const younger = await incidentWithSignal(subjectKey, observedAt);
  await withTenant(app.db, tenantId, async (tx) => {
    const olderSeenAt = new Date(observedAt.getTime() - 60_000);
    const olderMaxAgeAt = new Date(observedAt.getTime() - 1_000);
    const youngerMaxAgeAt = new Date(observedAt.getTime() + 24 * 60 * 60_000);
    const windowExpiresAt = new Date(observedAt.getTime() + 5 * 60_000);
    await tx
      .update(incidents)
      .set({ correlationMaxAgeAt: olderMaxAgeAt })
      .where(eq(incidents.id, older.incidentId));
    await tx
      .update(incidents)
      .set({ correlationMaxAgeAt: youngerMaxAgeAt })
      .where(eq(incidents.id, younger.incidentId));
    await tx
      .update(incidentSignals)
      .set({
        firstSeenAt: olderSeenAt,
        ...correlationDecisionFields(olderSeenAt, windowExpiresAt, olderMaxAgeAt),
      })
      .where(eq(incidentSignals.id, older.signalId));
    await tx
      .update(incidentSignals)
      .set({
        incidentId: older.incidentId,
        firstSeenAt: observedAt,
        ...correlationDecisionFields(observedAt, windowExpiresAt, youngerMaxAgeAt),
      })
      .where(eq(incidentSignals.id, younger.signalId));
  });

  const decision = await withTenant(app.db, tenantId, (tx) =>
    decideIncidentEpisodeRouteTx(tx, tenantId, {
      dataSourceId,
      subjectKey,
      observedAt,
      groupingWindowMs: 5 * 60_000,
      maxIncidentAgeMs: 24 * 60 * 60_000,
      allowGrouping: true,
    }),
  );
  expect(decision).toMatchObject({
    incident: null,
    method: 'new_incident',
    features: expect.arrayContaining(['incident_age_limit_reached']),
  });
});

test('moving an older episode into a younger incident cannot shorten the hard age stop', async () => {
  const subjectKey = `monitor:${randomUUID()}`;
  const observedAt = new Date();
  const older = await incidentWithSignal(subjectKey, new Date(observedAt.getTime() - 60_000));
  const younger = await incidentWithSignal(subjectKey, observedAt);
  await withTenant(app.db, tenantId, async (tx) => {
    const olderSeenAt = new Date(observedAt.getTime() - 60_000);
    const olderMaxAgeAt = new Date(observedAt.getTime() - 1_000);
    const youngerMaxAgeAt = new Date(observedAt.getTime() + 24 * 60 * 60_000);
    const windowExpiresAt = new Date(observedAt.getTime() + 5 * 60_000);
    await tx
      .update(incidents)
      .set({ correlationMaxAgeAt: olderMaxAgeAt })
      .where(eq(incidents.id, older.incidentId));
    await tx
      .update(incidents)
      .set({ correlationMaxAgeAt: youngerMaxAgeAt })
      .where(eq(incidents.id, younger.incidentId));
    await tx
      .update(incidentSignals)
      .set({
        incidentId: younger.incidentId,
        firstSeenAt: olderSeenAt,
        ...correlationDecisionFields(olderSeenAt, windowExpiresAt, olderMaxAgeAt),
      })
      .where(eq(incidentSignals.id, older.signalId));
    await tx
      .update(incidentSignals)
      .set({
        firstSeenAt: observedAt,
        ...correlationDecisionFields(observedAt, windowExpiresAt, youngerMaxAgeAt),
      })
      .where(eq(incidentSignals.id, younger.signalId));
  });

  const decision = await withTenant(app.db, tenantId, (tx) =>
    decideIncidentEpisodeRouteTx(tx, tenantId, {
      dataSourceId,
      subjectKey,
      observedAt,
      groupingWindowMs: 5 * 60_000,
      maxIncidentAgeMs: 24 * 60 * 60_000,
      allowGrouping: true,
    }),
  );
  expect(decision).toMatchObject({
    incident: { id: younger.incidentId },
    method: 'stable_subject_window',
  });
});
