import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applySignalObservationTx,
  connectorConfigs,
  createIncident,
  getBindingByIncident,
  getIncident,
  getIncidentDetail,
  listIncidents,
  listIncidentsPage,
  listBindingsByIncident,
  listIncidentRelations,
  listIncidentSignals,
  makeDb,
  mergeIncidents,
  recordIncidentRelation,
  recordUnrelatedIncidents,
  recordSurfaceBinding,
  splitMergedIncident,
  transitionIncidentTx,
  withTenant,
  type DbHandle,
} from '../index';
import {
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  surfaceBindings,
  surfaceDeliveries,
  tenants,
  jobs,
} from '../schema';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let sourceIncidentId: string;
let targetIncidentId: string;
let sourceBindingId: string;
let targetBindingId: string;
let correctionDataSourceId: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  correctionDataSourceId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Incident correction tenant' });
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(connectorConfigs).values({
      id: correctionDataSourceId,
      tenantId,
      name: 'Correction metrics source',
      type: 'prometheus',
      settings: {},
    }),
  );
  sourceIncidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'prometheus',
      service: 'checkout',
      severity: 'sev2',
      title: 'Checkout latency',
      investigationStatus: 'assessed',
    })
  ).id;
  targetIncidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'prometheus',
      service: 'database',
      severity: 'sev2',
      title: 'Database saturation',
      investigationStatus: 'assessed',
    })
  ).id;
  sourceBindingId = (
    await recordSurfaceBinding(app.db, tenantId, {
      incidentId: sourceIncidentId,
      surface: 'slack',
      channel: 'C-CORRECTION',
      threadId: '1788000000.000001',
    })
  ).id;
  targetBindingId = (
    await recordSurfaceBinding(app.db, tenantId, {
      incidentId: targetIncidentId,
      surface: 'slack',
      channel: 'C-CORRECTION',
      threadId: '1788000000.000002',
    })
  ).id;
  await withTenant(app.db, tenantId, async (tx) => {
    for (const [incidentId, externalMessageId, minute] of [
      [sourceIncidentId, 'source-episode', 0],
      [targetIncidentId, 'target-episode', 1],
    ] as const) {
      await applySignalObservationTx(tx, tenantId, {
        incidentId,
        dataSourceId: correctionDataSourceId,
        provider: 'alertmanager',
        providerFingerprint: randomUUID(),
        monitorKey: 'shared-correction-monitor',
        startsAt: new Date(`2026-08-26T00:0${minute}:00Z`),
        surface: 'alertmanager',
        channel: 'connector-1',
        externalMessageId,
        state: 'firing',
        summary: externalMessageId,
        contentHash: externalMessageId,
        eventKey: externalMessageId,
        eventAt: new Date('2026-08-26T00:00:00Z'),
      });
    }
  });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(surfaceDeliveries).where(eq(surfaceDeliveries.tenantId, tenantId));
    await admin.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(incidentRelations).where(eq(incidentRelations.tenantId, tenantId));
    await admin.db.delete(incidentSignals).where(eq(incidentSignals.tenantId, tenantId));
    await admin.db.delete(surfaceBindings).where(eq(surfaceBindings.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

test('refuses to merge a source that still participates in the causal response graph', async () => {
  const source = await createIncident(app.db, tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'prometheus',
    service: 'causal-source',
    severity: 'sev2',
    title: 'Causal merge source',
    investigationStatus: 'assessed',
  });
  const target = await createIncident(app.db, tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'prometheus',
    service: 'causal-target',
    severity: 'sev2',
    title: 'Causal merge target',
    investigationStatus: 'assessed',
  });
  await recordSurfaceBinding(app.db, tenantId, {
    incidentId: source.id,
    surface: 'slack',
    channel: 'C-CAUSAL-MERGE',
    threadId: randomUUID(),
  });
  await recordSurfaceBinding(app.db, tenantId, {
    incidentId: target.id,
    surface: 'slack',
    channel: 'C-CAUSAL-MERGE',
    threadId: randomUUID(),
  });
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: source.id,
    targetIncidentId: target.id,
    type: 'caused_by',
    rationale: 'The source is still governed by this causal response group.',
    evidence: ['responder:causal-merge-guard'],
    decidedBy: 'human',
    decidedByUserId: randomUUID(),
  });

  await expect(
    mergeIncidents(app.db, tenantId, {
      sourceIncidentId: source.id,
      targetIncidentId: target.id,
      rationale: 'This merge would strand the causal edge.',
      evidence: ['responder:unsafe-merge'],
      decidedByUserId: randomUUID(),
    }),
  ).rejects.toThrow(/causal links/i);
});

test('merge and split restore the exact signals and interactive Slack roots', async () => {
  const userId = randomUUID();
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(surfaceBindings)
      .set({ statusMessageId: '1788000000.100001', statusMessageVersion: 0 })
      .where(eq(surfaceBindings.id, sourceBindingId)),
  );
  const merged = await mergeIncidents(app.db, tenantId, {
    sourceIncidentId,
    targetIncidentId,
    rationale: 'Both alerts share the same database lock evidence.',
    evidence: ['trace:abc', 'deployment:123'],
    decidedByUserId: userId,
  });
  expect(merged.correction).toMatchObject({
    primaryBindingId: sourceBindingId,
    bindingIds: [sourceBindingId],
  });
  expect(merged.relation).toMatchObject({
    decidedBy: 'human',
    decidedByUserId: userId,
    correlationFeedback: {
      decision: 'group',
      sharedScopeKeys: [expect.any(String)],
    },
  });
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(incidentRelations)
      .set({ correlationFeedback: null })
      .where(eq(incidentRelations.id, merged.relation.id)),
  );
  expect(await listIncidentSignals(app.db, tenantId, sourceIncidentId)).toHaveLength(0);
  expect(await listIncidentSignals(app.db, tenantId, targetIncidentId)).toHaveLength(2);
  expect(await getBindingByIncident(app.db, tenantId, 'slack', sourceIncidentId)).toBeUndefined();
  expect(await getBindingByIncident(app.db, tenantId, 'slack', targetIncidentId)).toMatchObject({
    id: targetBindingId,
    role: 'primary',
  });
  expect(await listBindingsByIncident(app.db, tenantId, 'slack', targetIncidentId)).toEqual([
    expect.objectContaining({ id: targetBindingId, role: 'primary', projectionMode: 'full' }),
    expect.objectContaining({
      id: sourceBindingId,
      role: 'source',
      projectionMode: 'status',
      statusMessageId: '1788000000.100001',
      statusMessageVersion: -1,
      assignmentVersion: 1,
    }),
  ]);
  expect(await getIncidentDetail(app.db, tenantId, targetIncidentId)).toMatchObject({
    originThreadId: '1788000000.000002',
  });
  expect(
    (await listIncidents(app.db, tenantId)).filter(({ id }) => id === targetIncidentId),
  ).toHaveLength(1);
  expect(
    (await listIncidentsPage(app.db, tenantId, { scope: 'open', limit: 100 })).incidents.filter(
      ({ id }) => id === targetIncidentId,
    ),
  ).toHaveLength(1);
  expect(
    (await listIncidentsPage(app.db, tenantId, { scope: 'closed', limit: 100 })).incidents.filter(
      ({ id }) => id === sourceIncidentId,
    ),
  ).toHaveLength(1);
  expect((await listIncidentRelations(app.db, tenantId, sourceIncidentId))[0]).toMatchObject({
    type: 'merged_into',
    sourceIncidentId,
    targetIncidentId,
    sourceIncident: { title: 'Checkout latency', status: 'closed' },
    targetIncident: { title: 'Database saturation', status: 'open' },
  });
  expect(
    await withTenant(app.db, tenantId, (tx) => transitionIncidentTx(tx, sourceIncidentId, 'open')),
  ).toMatchObject({ outcome: 'merged', from: 'closed', to: 'open' });
  await expect(
    mergeIncidents(app.db, tenantId, {
      sourceIncidentId,
      targetIncidentId,
      rationale: 'Attempt to merge the same source again.',
      evidence: ['relation:already-active'],
      decidedByUserId: userId,
    }),
  ).rejects.toThrow(/source is already joined/i);
  await expect(
    recordUnrelatedIncidents(app.db, tenantId, {
      sourceIncidentId,
      targetIncidentId,
      rationale: 'A stale correction tried to bypass the reversible split.',
      evidence: ['trace:stale-correction'],
      decidedByUserId: userId,
    }),
  ).rejects.toThrow(/split the joined incidents/i);

  const queuedMessageId = await withTenant(app.db, tenantId, async (tx) => {
    const messages = await tx
      .insert(incidentMessages)
      .values({
        tenantId,
        incidentId: targetIncidentId,
        author: 'system',
        kind: 'lifecycle',
        content: 'Target lifecycle update queued before split.',
      })
      .returning({ id: incidentMessages.id });
    await tx.insert(surfaceDeliveries).values({
      tenantId,
      incidentId: targetIncidentId,
      messageId: messages[0]!.id,
      bindingId: sourceBindingId,
      bindingAssignmentVersion: 1,
      surface: 'slack',
    });
    return messages[0]!.id;
  });

  const split = await splitMergedIncident(app.db, tenantId, {
    sourceIncidentId,
    targetIncidentId,
    rationale: 'The latency alert persisted after the database recovered.',
    evidence: ['metric:latency_still_high'],
    decidedByUserId: userId,
  });
  expect(split.relation).toMatchObject({
    decidedBy: 'human',
    decidedByUserId: userId,
    correlationFeedback: {
      decision: 'separate',
      sharedScopeKeys: [expect.any(String)],
    },
  });
  expect(await listIncidentSignals(app.db, tenantId, sourceIncidentId)).toHaveLength(1);
  expect(await listIncidentSignals(app.db, tenantId, targetIncidentId)).toHaveLength(1);
  expect(await getBindingByIncident(app.db, tenantId, 'slack', sourceIncidentId)).toMatchObject({
    id: sourceBindingId,
    role: 'primary',
    projectionMode: 'full',
    statusMessageId: '1788000000.100001',
    statusMessageVersion: -1,
    assignmentVersion: 2,
  });
  expect(await getBindingByIncident(app.db, tenantId, 'slack', targetIncidentId)).toMatchObject({
    id: targetBindingId,
    role: 'primary',
  });
  expect(await getIncident(app.db, tenantId, sourceIncidentId)).toMatchObject({ status: 'open' });
  expect((await listIncidentRelations(app.db, tenantId, sourceIncidentId))[0]).toMatchObject({
    type: 'split_from',
    sourceIncidentId,
    targetIncidentId,
  });
  expect(
    await withTenant(app.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ state: surfaceDeliveries.state, reasonCode: surfaceDeliveries.reasonCode })
        .from(surfaceDeliveries)
        .where(eq(surfaceDeliveries.messageId, queuedMessageId));
      return rows[0];
    }),
  ).toEqual({ state: 'blocked', reasonCode: 'incident_split' });
});

test('refuses to move incident evidence while an investigation job is queued', async () => {
  const jobId = randomUUID();
  await admin.db.insert(jobs).values({
    id: jobId,
    tenantId,
    type: 'signal.reassess',
    payload: { incidentId: sourceIncidentId },
    stream: 'sre:triage',
  });
  await expect(
    mergeIncidents(app.db, tenantId, {
      sourceIncidentId,
      targetIncidentId,
      rationale: 'The same change appears in both investigations.',
      evidence: ['deployment:456'],
      decidedByUserId: randomUUID(),
    }),
  ).rejects.toThrow(/independent investigations to finish/i);
  await admin.db.delete(jobs).where(eq(jobs.id, jobId));
});

test('incident corrections cannot mutate a deleted incident after acquiring their locks', async () => {
  const source = (
    await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'prometheus',
      service: 'deleted-correction-source',
      severity: 'sev3',
      investigationStatus: 'assessed',
    })
  ).id;
  const target = (
    await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'prometheus',
      service: 'deleted-correction-target',
      severity: 'sev3',
      investigationStatus: 'assessed',
    })
  ).id;
  await recordSurfaceBinding(app.db, tenantId, {
    incidentId: source,
    surface: 'slack',
    channel: 'C-DELETED-CORRECTION',
    threadId: randomUUID(),
  });
  await recordSurfaceBinding(app.db, tenantId, {
    incidentId: target,
    surface: 'slack',
    channel: 'C-DELETED-CORRECTION',
    threadId: randomUUID(),
  });
  const input = {
    sourceIncidentId: source,
    targetIncidentId: target,
    rationale: 'Correction must not revive a deleted incident.',
    evidence: ['deleted source'],
    decidedByUserId: randomUUID(),
  };
  await mergeIncidents(app.db, tenantId, input);
  await admin.db.update(incidents).set({ archivedAt: new Date() }).where(eq(incidents.id, source));

  await expect(splitMergedIncident(app.db, tenantId, input)).rejects.toThrow(
    /both incidents must exist/i,
  );
  await expect(recordUnrelatedIncidents(app.db, tenantId, input)).rejects.toThrow(
    /both incidents must exist/i,
  );

  const deletedMergeSource = (
    await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'prometheus',
      service: 'deleted-before-merge',
      severity: 'sev3',
      investigationStatus: 'assessed',
    })
  ).id;
  await admin.db
    .update(incidents)
    .set({ archivedAt: new Date() })
    .where(eq(incidents.id, deletedMergeSource));
  await expect(
    mergeIncidents(app.db, tenantId, { ...input, sourceIncidentId: deletedMergeSource }),
  ).rejects.toThrow(/both incidents must exist/i);
});

test('a correction waits for an uncommitted deletion and then performs no merge', async () => {
  const source = (
    await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'prometheus',
      service: 'deletion-race-source',
      severity: 'sev3',
      investigationStatus: 'assessed',
    })
  ).id;
  const target = (
    await createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'prometheus',
      service: 'deletion-race-target',
      severity: 'sev3',
      investigationStatus: 'assessed',
    })
  ).id;
  await recordSurfaceBinding(app.db, tenantId, {
    incidentId: source,
    surface: 'slack',
    channel: 'C-DELETION-RACE',
    threadId: randomUUID(),
  });
  let releaseDelete!: () => void;
  const deleteReleased = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let deleteLocked!: () => void;
  const deleteReached = new Promise<void>((resolve) => {
    deleteLocked = resolve;
  });
  const deletion = admin.db.transaction(async (tx) => {
    await tx.update(incidents).set({ archivedAt: new Date() }).where(eq(incidents.id, source));
    deleteLocked();
    await deleteReleased;
  });
  await deleteReached;

  let mergeSettled = false;
  const merging = mergeIncidents(app.db, tenantId, {
    sourceIncidentId: source,
    targetIncidentId: target,
    rationale: 'This correction must lose to the committed deletion.',
    evidence: ['transaction ordering'],
    decidedByUserId: randomUUID(),
  }).then(
    () => {
      mergeSettled = true;
      return null;
    },
    (error: unknown) => {
      mergeSettled = true;
      return error;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mergeSettled).toBe(false);
  releaseDelete();
  await deletion;

  expect(String(await merging)).toMatch(/both incidents must exist/i);
  expect(await listIncidentRelations(app.db, tenantId, source)).toEqual([]);
});

test('a causal decision supersedes the prior candidate but preserves provider recurrence lineage', async () => {
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId,
    targetIncidentId,
    type: 'recurrence_of',
    rationale: 'Alertmanager reported a later episode for the same provider fingerprint.',
    evidence: ['provider_fingerprint:test'],
    decidedBy: 'system',
  });
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: targetIncidentId,
    targetIncidentId: sourceIncidentId,
    type: 'possible_related',
    rationale: 'The alerts shared a burst window.',
    evidence: ['cohort:test'],
    decidedBy: 'system',
  });
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId,
    targetIncidentId,
    type: 'unrelated',
    rationale: 'The traces prove separate failure domains.',
    evidence: ['trace:separate'],
    decidedBy: 'human',
    decidedByUserId: randomUUID(),
  });

  expect(await listIncidentRelations(app.db, tenantId, sourceIncidentId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'recurrence_of', sourceIncidentId, targetIncidentId }),
      expect.objectContaining({ type: 'unrelated', sourceIncidentId, targetIncidentId }),
    ]),
  );
  expect(await listIncidentRelations(app.db, tenantId, sourceIncidentId)).toHaveLength(2);
});
