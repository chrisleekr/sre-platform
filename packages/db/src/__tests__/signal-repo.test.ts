import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  applySignalObservation,
  applyTriageResult,
  beginRecoveryVerification,
  createIncident,
  getIncident,
  getSignalByExternal,
  incidentSignalFenceTx,
  incidentSignals,
  incidents,
  jobs,
  listIncidentSignals,
  makeDb,
  serializeSignalFence,
  tenants,
  transitionIncidentTx,
  withTenant,
  type DbHandle,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'signal-a' },
    { id: tenantB, name: 'signal-b' },
  ]);
});

afterAll(async () => {
  await admin.db.delete(jobs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
  await admin.db.delete(incidentSignals).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
  await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
  await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
  await app.close();
  await admin.close();
});

const observation = (
  incidentId: string,
  over: Partial<Parameters<typeof applySignalObservation>[2]> = {},
) => ({
  incidentId,
  surface: 'slack',
  channel: 'C-alerts',
  externalMessageId: '1787280000.000100',
  state: 'firing' as const,
  summary: 'Checkout error rate is high',
  contentHash: 'hash-1',
  eventKey: 'slack:C-alerts:1787280000.000100',
  eventAt: new Date('2026-08-21T01:00:00.000Z'),
  ...over,
});

describe('incident signal state machine', () => {
  test('concurrent first observations create one signal without surfacing a unique violation', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `signal-race-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    const first = observation(incidentId, {
      externalMessageId: `race-${randomUUID()}`,
      eventKey: `race-${randomUUID()}`,
    });

    const results = await Promise.all([
      applySignalObservation(app.db, tenantA, first),
      applySignalObservation(app.db, tenantA, first),
    ]);

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect(results.filter((result) => !result.applied)).toHaveLength(1);
    expect(results[0]!.signal.id).toBe(results[1]!.signal.id);
  });

  test('records a provider renotification as last-seen activity without advancing investigation material', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `provider-repeat-${randomUUID()}`,
        alertSource: 'alertmanager',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    const providerFingerprint = randomUUID();
    const externalMessageId = `provider-repeat-${randomUUID()}`;
    const initial = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        provider: 'alertmanager',
        providerFingerprint,
        externalMessageId,
        monitorKey: 'alertmanager:checkout-errors',
        startsAt: new Date('2026-08-21T00:55:00.000Z'),
        materialHash: 'stable-material',
      }),
    );
    const repeat = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        provider: 'alertmanager',
        providerFingerprint,
        externalMessageId,
        monitorKey: 'alertmanager:checkout-errors',
        startsAt: new Date('2026-08-21T00:55:00.000Z'),
        materialHash: 'stable-material',
        summary: 'Checkout error rate is now 12.5%',
        contentHash: 'changed-observation',
        eventKey: 'alertmanager:repeat',
        eventAt: new Date('2026-08-21T01:05:00.000Z'),
      }),
    );

    expect(initial.investigationTriggerReason).toBe('new_episode');
    expect(repeat).toMatchObject({
      applied: false,
      investigationTriggerReason: 'unchanged_renotification',
      signal: {
        version: 1,
        monitorKey: 'alertmanager:checkout-errors',
        lastSeenAt: new Date('2026-08-21T01:05:00.000Z'),
      },
    });
  });

  test('folds transport-only renotifications into the active monitor episode', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `transport-repeat-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    const initial = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        externalMessageId: 'transport-root-1',
        eventKey: 'transport-event-1',
        monitorKey: 'slack:C-alerts:checkout-errors:0',
        materialHash: 'stable-material',
      }),
    );
    const repeat = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        externalMessageId: 'transport-root-2',
        eventKey: 'transport-event-2',
        eventAt: new Date('2026-08-21T01:05:00.000Z'),
        monitorKey: 'slack:C-alerts:checkout-errors:0',
        materialHash: 'stable-material',
        summary: 'Checkout error rate is now 12.5%',
        contentHash: 'transport-observation-2',
      }),
    );

    expect(repeat).toMatchObject({
      applied: false,
      investigationTriggerReason: 'unchanged_renotification',
      signal: {
        id: initial.signal.id,
        version: 1,
        lastSeenAt: new Date('2026-08-21T01:05:00.000Z'),
      },
    });
    expect(await listIncidentSignals(app.db, tenantA, incidentId)).toHaveLength(1);
  });

  test('versions material changes but opens a new transport episode after resolution', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `transport-change-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    const common = {
      monitorKey: 'slack:C-alerts:checkout-errors:0',
      materialHash: 'material-1',
    };
    const initial = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        ...common,
        externalMessageId: 'transport-change-root-1',
        eventKey: 'transport-change-event-1',
      }),
    );
    const changed = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        ...common,
        materialHash: 'material-2',
        externalMessageId: 'transport-change-root-2',
        eventKey: 'transport-change-event-2',
        eventAt: new Date('2026-08-21T01:05:00.000Z'),
        summary: 'Checkout errors now affect a second region',
        contentHash: 'transport-change-content-2',
      }),
    );
    await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        ...common,
        materialHash: 'material-2',
        externalMessageId: 'transport-change-root-1',
        eventKey: 'transport-resolved-event',
        eventAt: new Date('2026-08-21T01:10:00.000Z'),
        state: 'resolved',
      }),
    );
    const recurrence = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        ...common,
        materialHash: 'material-2',
        externalMessageId: 'transport-change-root-3',
        eventKey: 'transport-change-event-3',
        eventAt: new Date('2026-08-21T01:15:00.000Z'),
      }),
    );

    expect(changed).toMatchObject({
      applied: true,
      investigationTriggerReason: 'material_change',
      signal: { id: initial.signal.id, version: 2, materialHash: 'material-2' },
    });
    expect(recurrence).toMatchObject({
      applied: true,
      investigationTriggerReason: 'new_episode',
      signal: { version: 1, state: 'firing' },
    });
    expect(recurrence.signal.id).not.toBe(initial.signal.id);
  });

  test('applies opened, updated, resolved, and refired monotonically and idempotently', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `signal-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;

    const opened = await applySignalObservation(app.db, tenantA, observation(incidentId));
    expect(opened).toMatchObject({
      applied: true,
      eventType: 'opened',
      previousState: null,
      allResolved: false,
    });
    expect(opened.signal.version).toBe(1);

    const duplicate = await applySignalObservation(app.db, tenantA, observation(incidentId));
    expect(duplicate).toMatchObject({
      applied: false,
      eventType: 'updated',
      investigationTriggerReason: 'unchanged_renotification',
    });
    expect(duplicate.signal.version).toBe(1);

    const metadataOnly = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        eventKey: 'slack:C-alerts:1787280000.000100:edit:1787280060.000100',
        eventAt: new Date('2026-08-21T01:01:00.000Z'),
      }),
    );
    expect(metadataOnly.applied).toBe(false);

    const updated = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        summary: 'Checkout error rate is now 20%',
        contentHash: 'hash-2',
        eventKey: 'slack:C-alerts:1787280000.000100:edit:1787280120.000100',
        eventAt: new Date('2026-08-21T01:02:00.000Z'),
      }),
    );
    expect(updated).toMatchObject({
      applied: true,
      eventType: 'updated',
      previousState: 'firing',
      investigationTriggerReason: 'material_change',
    });
    expect(updated.signal.version).toBe(2);

    const resolved = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        state: 'resolved',
        summary: '[RESOLVED] Checkout error rate',
        contentHash: 'hash-3',
        eventKey: 'slack:C-alerts:1787280000.000100:edit:1787280180.000100',
        eventAt: new Date('2026-08-21T01:03:00.000Z'),
      }),
    );
    expect(resolved).toMatchObject({
      applied: true,
      eventType: 'resolved',
      allResolved: true,
      investigationTriggerReason: 'state_transition',
    });
    expect(resolved.signal.resolvedAt).toEqual(new Date('2026-08-21T01:03:00.000Z'));

    const scheduledRecoveryId = randomUUID();
    await admin.db.insert(jobs).values({
      id: scheduledRecoveryId,
      tenantId: tenantA,
      type: 'recovery.verify',
      payload: {
        incidentId,
        lifecycleVersion: 0,
        signalFence: serializeSignalFence([resolved.signal]),
        attempt: 2,
        maxChecks: 3,
        scheduleReason: 'Wait for the rollout to settle.',
      },
      status: 'queued',
      stream: 'signal-repo-test',
      availableAt: new Date('2026-08-21T01:10:00.000Z'),
    });
    await admin.db
      .update(incidents)
      .set({ recoveryState: 'monitoring', recoveryAttempt: 1, recoveryMaxChecks: 3 })
      .where(sql`id = ${incidentId}`);

    const staleRefire = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        contentHash: 'hash-stale',
        eventKey: 'stale-refire',
        eventAt: new Date('2026-08-21T01:02:30.000Z'),
      }),
    );
    expect(staleRefire.applied).toBe(false);
    expect(staleRefire.signal.state).toBe('resolved');
    expect(
      (
        await admin.db
          .select()
          .from(jobs)
          .where(sql`id = ${scheduledRecoveryId}`)
      )[0]?.status,
    ).toBe('queued');

    const refired = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        summary: 'Checkout error rate is high again',
        contentHash: 'hash-4',
        eventKey: 'refire',
        eventAt: new Date('2026-08-21T01:04:00.000Z'),
      }),
    );
    expect(refired).toMatchObject({
      applied: true,
      eventType: 'refired',
      previousState: 'resolved',
      allResolved: false,
    });
    expect(refired.signal).toMatchObject({ version: 4, state: 'firing', resolvedAt: null });
    expect(
      (
        await admin.db
          .select()
          .from(jobs)
          .where(sql`id = ${scheduledRecoveryId}`)
      )[0]?.status,
    ).toBe('done');
    expect(await getIncident(app.db, tenantA, incidentId)).toMatchObject({
      recoveryState: null,
      recoveryAttempt: null,
      recoveryMaxChecks: null,
    });

    expect(
      await getSignalByExternal(app.db, tenantB, 'slack', 'C-alerts', '1787280000.000100'),
    ).toBeNull();
    expect(await listIncidentSignals(app.db, tenantB, incidentId)).toEqual([]);
  });

  test('allResolved requires every attached signal to clear', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `multi-signal-${randomUUID()}`,
        alertSource: 'slack',
        service: 'payments',
        severity: 'sev1',
      })
    ).id;
    const first = observation(incidentId, { externalMessageId: 'signal-a', eventKey: 'signal-a' });
    const second = observation(incidentId, { externalMessageId: 'signal-b', eventKey: 'signal-b' });
    await applySignalObservation(app.db, tenantA, first);
    await applySignalObservation(app.db, tenantA, second);

    const oneCleared = await applySignalObservation(app.db, tenantA, {
      ...first,
      state: 'resolved',
      contentHash: 'signal-a-resolved',
      eventKey: 'signal-a-resolved',
      eventAt: new Date('2026-08-21T01:05:00.000Z'),
    });
    expect(oneCleared.allResolved).toBe(false);

    const bothCleared = await applySignalObservation(app.db, tenantA, {
      ...second,
      state: 'resolved',
      contentHash: 'signal-b-resolved',
      eventKey: 'signal-b-resolved',
      eventAt: new Date('2026-08-21T01:06:00.000Z'),
    });
    expect(bothCleared.allResolved).toBe(true);
    expect(await withTenant(app.db, tenantA, (tx) => incidentSignalFenceTx(tx, incidentId))).toBe(
      serializeSignalFence([oneCleared.signal, bothCleared.signal]),
    );
  });

  test('recovery startup durably restores progress after lifecycle changes across redelivery', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `recovery-start-${randomUUID()}`,
        alertSource: 'slack',
        service: 'payments',
        severity: 'sev2',
      })
    ).id;
    await applyTriageResult(app.db, tenantA, incidentId, {
      provider: 'fake',
      sessionId: `fake:${incidentId}`,
      summary: 'The payments pool saturated.',
      confidence: 70,
    });
    const cleared = await applySignalObservation(
      app.db,
      tenantA,
      observation(incidentId, {
        externalMessageId: `recovery-start-${incidentId}`,
        state: 'resolved',
        contentHash: 'recovery-start-resolved',
        eventKey: `recovery-start-resolved:${incidentId}`,
      }),
    );
    const signalFence = serializeSignalFence([cleared.signal]);
    expect(cleared.signal.state).toBe('resolved');
    expect(await getIncident(app.db, tenantA, incidentId)).toMatchObject({
      status: 'open',
      lifecycleVersion: 0,
      investigationStatus: 'assessed',
    });
    expect(await withTenant(app.db, tenantA, (tx) => incidentSignalFenceTx(tx, incidentId))).toBe(
      signalFence,
    );
    const jobId = randomUUID();
    await admin.db.insert(jobs).values({
      id: jobId,
      tenantId: tenantA,
      type: 'recovery.verify',
      payload: {
        incidentId,
        lifecycleVersion: 0,
        signalFence,
        restoreInvestigationStatus: 'assessed',
      },
      status: 'processing',
      stream: 'signal-repo-test',
    });

    expect(
      await beginRecoveryVerification(app.db, tenantA, jobId, incidentId, 0, signalFence),
    ).toMatchObject({ restoreInvestigationStatus: 'assessed' });
    expect(await getIncident(app.db, tenantA, incidentId)).toMatchObject({
      investigationStatus: 'gathering',
      recoveryState: 'verifying',
    });
    await withTenant(app.db, tenantA, (tx) =>
      transitionIncidentTx(tx, incidentId, 'mitigated', { expectedVersion: 0 }),
    );

    const freshStaleJobId = randomUUID();
    await admin.db.insert(jobs).values({
      id: freshStaleJobId,
      tenantId: tenantA,
      type: 'recovery.verify',
      payload: {
        incidentId,
        lifecycleVersion: 0,
        signalFence,
        restoreInvestigationStatus: 'assessed',
      },
      status: 'processing',
      stream: 'signal-repo-test',
    });
    expect(
      await beginRecoveryVerification(app.db, tenantA, freshStaleJobId, incidentId, 0, signalFence),
    ).toBeNull();

    expect(
      await beginRecoveryVerification(app.db, tenantA, jobId, incidentId, 0, signalFence),
    ).toBeNull();
    await admin.db
      .update(jobs)
      .set({ payload: sql`${jobs.payload} || ${JSON.stringify({ lifecycleVersion: 1 })}::jsonb` })
      .where(sql`id = ${jobId}`);
    expect(
      await beginRecoveryVerification(app.db, tenantA, jobId, incidentId, 1, signalFence),
    ).toMatchObject({
      incident: { status: 'mitigated', lifecycleVersion: 1 },
      restoreInvestigationStatus: 'assessed',
    });
    await withTenant(app.db, tenantA, (tx) =>
      transitionIncidentTx(tx, incidentId, 'resolved', { expectedVersion: 1 }),
    );

    expect(
      await beginRecoveryVerification(app.db, tenantA, jobId, incidentId, 0, signalFence),
    ).toBeNull();
    expect(await getIncident(app.db, tenantA, incidentId)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 2,
      investigationStatus: 'assessed',
      recoveryState: null,
    });
    await withTenant(app.db, tenantA, (tx) =>
      transitionIncidentTx(tx, incidentId, 'open', { expectedVersion: 2 }),
    );
    expect(
      await beginRecoveryVerification(app.db, tenantA, jobId, incidentId, 0, signalFence),
    ).toBeNull();
    expect(await getIncident(app.db, tenantA, incidentId)).toMatchObject({
      status: 'open',
      lifecycleVersion: 3,
      recoveryState: null,
    });
    const jobRows = await admin.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(sql`id = ${jobId}`);
    expect(jobRows[0]?.payload).toMatchObject({
      restoreInvestigationStatus: 'assessed',
      lifecycleVersion: 1,
    });
  });
});
