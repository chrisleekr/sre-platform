import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  blockQueuedSurfaceDelivery,
  claimSurfaceDelivery,
  claimSurfaceDeliveryTx,
  createIncident,
  disconnectSurfaceConfig,
  enqueueConnectedSurfaceDeliveriesTx,
  finishSurfaceDelivery,
  hasAmbiguousLifecyclePostCreation,
  listMessageDeliveryTargets,
  listQueuedSurfaceMessagesSystem,
  listSurfaceDeliveriesForMessages,
  makeDb,
  markStaleSurfaceDeliveriesUncertainSystem,
  scheduleSurfaceDeliveryRetry,
  setIncidentArchivedTx,
  transitionIncidentTx,
  getSurfaceConfig,
  recordSurfaceBinding,
  activateSurfaceBinding,
  upsertSurfaceConfig,
  withTenant,
  type DbHandle,
} from '../index';
import {
  incidentMessages,
  incidents,
  surfaceBindings,
  surfaceConfigs,
  surfaceDeliveries,
  tenants,
} from '../schema';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let incidentA: string;
let incidentB: string;
let bindingA: string;
let bindingB: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'delivery-a' },
    { id: tenantB, name: 'delivery-b' },
  ]);
  incidentA = (
    await createIncident(app.db, tenantA, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  incidentB = (
    await createIncident(app.db, tenantB, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'billing',
      severity: 'sev3',
    })
  ).id;
  await upsertSurfaceConfig(app.db, tenantA, { surface: 'slack' });
  await upsertSurfaceConfig(app.db, tenantB, { surface: 'slack' });
  bindingA = (
    await recordSurfaceBinding(app.db, tenantA, {
      incidentId: incidentA,
      surface: 'slack',
      channel: 'C-DELIVERY-A',
      threadId: '1787000000.000001',
    })
  ).id;
  bindingB = (
    await recordSurfaceBinding(app.db, tenantB, {
      incidentId: incidentB,
      surface: 'slack',
      channel: 'C-DELIVERY-B',
      threadId: '1787000000.000002',
    })
  ).id;
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(surfaceDeliveries).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidentMessages).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(surfaceBindings).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(surfaceConfigs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

async function appendWithOutbox(
  tenantId: string,
  incidentId: string,
  originSurface: string | null,
  kind = 'text',
  structured: {
    lifecycleFrom?: string | null;
    lifecycleTo?: string;
    lifecycleVersion?: number;
    transitionKey?: string;
    recovery?: {
      recovered: boolean;
      checks: Array<{ name: string; before: string | null; now: string }>;
      unknowns: string[];
      nextStep: string | null;
    };
  } = {},
): Promise<string> {
  return withTenant(app.db, tenantId, async (tx) => {
    const [message] = await tx
      .insert(incidentMessages)
      .values({
        tenantId,
        incidentId,
        author: 'human',
        kind,
        content: randomUUID(),
        originSurface,
        ...structured,
      })
      .returning();
    await enqueueConnectedSurfaceDeliveriesTx(
      tx,
      tenantId,
      incidentId,
      message!.id,
      kind,
      originSurface,
    );
    return message!.id;
  });
}

describe('durable surface outbox and receipt', () => {
  test('queues the connected destination atomically and excludes an origin echo', async () => {
    const dashboardMessage = await appendWithOutbox(tenantA, incidentA, 'dashboard');
    const slackMessage = await appendWithOutbox(tenantA, incidentA, 'slack');

    expect(await listMessageDeliveryTargets(app.db, tenantA, dashboardMessage)).toEqual([
      { surface: 'slack', bindingId: bindingA, bindingAssignmentVersion: 0 },
    ]);
    expect(await listMessageDeliveryTargets(app.db, tenantA, slackMessage)).toEqual([]);
    expect(await listMessageDeliveryTargets(app.db, tenantB, dashboardMessage)).toEqual([]);
  });

  test('claims once and records only remote API acceptance, tenant scoped', async () => {
    const messageId = await appendWithOutbox(tenantA, incidentA, 'dashboard');

    expect(await claimSurfaceDelivery(app.db, tenantA, 'slack', bindingA, messageId)).toBe(true);
    expect(await claimSurfaceDelivery(app.db, tenantA, 'slack', bindingA, messageId)).toBe(false);
    expect(
      await finishSurfaceDelivery(app.db, tenantA, 'slack', bindingA, messageId, {
        state: 'accepted',
        operation: 'post',
        remoteMessageId: '1787270000.000100',
      }),
    ).toBe(true);

    const [receipt] = await listSurfaceDeliveriesForMessages(
      app.db,
      tenantA,
      [messageId],
      incidentA,
    );
    expect(receipt).toMatchObject({
      messageId,
      state: 'accepted',
      operation: 'post',
      remoteMessageId: '1787270000.000100',
    });
    expect(await listSurfaceDeliveriesForMessages(app.db, tenantB, [messageId])).toEqual([]);
  });

  test('turns an interrupted attempt uncertain and never reclaims it', async () => {
    const messageId = await appendWithOutbox(tenantA, incidentA, 'dashboard');
    expect(await claimSurfaceDelivery(app.db, tenantA, 'slack', bindingA, messageId)).toBe(true);
    await admin.db
      .update(surfaceDeliveries)
      .set({ attemptedAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(surfaceDeliveries.messageId, messageId));

    expect(
      await markStaleSurfaceDeliveriesUncertainSystem(admin.db, new Date('2026-01-01T00:01:00Z')),
    ).toBeGreaterThanOrEqual(1);
    expect(await claimSurfaceDelivery(app.db, tenantA, 'slack', bindingA, messageId)).toBe(false);
    expect(
      await finishSurfaceDelivery(app.db, tenantA, 'slack', bindingA, messageId, {
        state: 'accepted',
        operation: 'post',
        remoteMessageId: '1787270000.000200',
      }),
    ).toBe(false);
    const [receipt] = await listSurfaceDeliveriesForMessages(app.db, tenantA, [messageId]);
    expect(receipt).toMatchObject({
      state: 'uncertain',
      reasonCode: 'worker_interrupted',
      remoteMessageId: null,
    });
  });

  test('detects an older ambiguous lifecycle creation attempt but excludes the current delivery', async () => {
    const first = await appendWithOutbox(tenantA, incidentA, null, 'lifecycle');
    const next = await appendWithOutbox(tenantA, incidentA, null, 'lifecycle');
    expect(await claimSurfaceDelivery(app.db, tenantA, 'slack', bindingA, first)).toBe(true);

    expect(await hasAmbiguousLifecyclePostCreation(app.db, tenantA, 'slack', bindingA, first)).toBe(
      false,
    );
    expect(await hasAmbiguousLifecyclePostCreation(app.db, tenantA, 'slack', bindingA, next)).toBe(
      true,
    );

    const reassignedIncident = (
      await createIncident(app.db, tenantA, {
        fingerprint: randomUUID(),
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    try {
      await withTenant(app.db, tenantA, (tx) =>
        tx
          .update(surfaceBindings)
          .set({
            incidentId: reassignedIncident,
            assignmentVersion: sql`${surfaceBindings.assignmentVersion} + 1`,
          })
          .where(eq(surfaceBindings.id, bindingA)),
      );
      expect(
        await hasAmbiguousLifecyclePostCreation(app.db, tenantA, 'slack', bindingA, next),
      ).toBe(true);
    } finally {
      await withTenant(app.db, tenantA, (tx) =>
        tx
          .update(surfaceBindings)
          .set({
            incidentId: incidentA,
            assignmentVersion: sql`${surfaceBindings.assignmentVersion} + 1`,
          })
          .where(eq(surfaceBindings.id, bindingA)),
      );
      await admin.db.delete(incidents).where(eq(incidents.id, reassignedIncident));
    }

    expect(
      await finishSurfaceDelivery(app.db, tenantA, 'slack', bindingA, first, {
        state: 'rejected',
        operation: 'post',
        reasonCode: 'slack_rejected',
      }),
    ).toBe(true);
    expect(await hasAmbiguousLifecyclePostCreation(app.db, tenantA, 'slack', bindingA, next)).toBe(
      false,
    );
  });

  test('outbox scan recovers queued messages and a pre-request failure becomes blocked', async () => {
    const messageId = await appendWithOutbox(tenantB, incidentB, 'dashboard');
    const queued = await listQueuedSurfaceMessagesSystem(admin.db, 100);
    expect(queued.some((item) => item.message.id === messageId && item.tenantId === tenantB)).toBe(
      true,
    );

    await blockQueuedSurfaceDelivery(
      app.db,
      tenantB,
      'slack',
      bindingB,
      messageId,
      'not_connected',
    );
    const [receipt] = await listSurfaceDeliveriesForMessages(app.db, tenantB, [messageId]);
    expect(receipt).toMatchObject({ state: 'blocked', reasonCode: 'not_connected' });
  });

  test('outbox recovery retains lifecycle projection metadata', async () => {
    const transitionKey = `dashboard:${incidentA}:${randomUUID()}`;
    const messageId = await appendWithOutbox(tenantA, incidentA, null, 'lifecycle', {
      lifecycleFrom: 'open',
      lifecycleTo: 'mitigated',
      lifecycleVersion: 1,
      transitionKey,
    });

    const queued = await listQueuedSurfaceMessagesSystem(admin.db, 100);
    expect(queued.find((item) => item.message.id === messageId)?.message).toMatchObject({
      lifecycleFrom: 'open',
      lifecycleTo: 'mitigated',
      lifecycleVersion: 1,
      transitionKey,
    });
  });

  test('outbox recovery retains the structured recovery table payload', async () => {
    const recovery = {
      recovered: true,
      checks: [{ name: 'Error rate', before: '12%', now: '0.2%' }],
      unknowns: ['Whether the preventive change is scheduled'],
      nextStep: 'Track the preventive change separately.',
    };
    const messageId = await appendWithOutbox(tenantA, incidentA, null, 'finding', { recovery });

    const queued = await listQueuedSurfaceMessagesSystem(admin.db, 100);
    expect(queued.find((item) => item.message.id === messageId)?.message.recovery).toEqual(
      recovery,
    );
  });

  test('deletion blocks queued delivery and the claim backstop refuses tombstones', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `delivery-delete-${randomUUID()}`,
        alertSource: 'slack',
        service: 'deleted-delivery',
        severity: 'sev3',
      })
    ).id;
    const binding = await recordSurfaceBinding(app.db, tenantA, {
      incidentId,
      surface: 'slack',
      channel: 'C-DELETE',
      threadId: randomUUID(),
    });
    const messageId = await appendWithOutbox(tenantA, incidentId, 'dashboard');
    await withTenant(app.db, tenantA, (tx) => transitionIncidentTx(tx, incidentId, 'resolved'));

    expect(
      await withTenant(app.db, tenantA, (tx) =>
        setIncidentArchivedTx(tx, incidentId, true, { expectedVersion: 1 }),
      ),
    ).toMatchObject({ outcome: 'applied' });
    expect(await claimSurfaceDelivery(app.db, tenantA, 'slack', binding.id, messageId)).toBe(false);
    expect(await listSurfaceDeliveriesForMessages(app.db, tenantA, [messageId])).toEqual([
      expect.objectContaining({ state: 'blocked', reasonCode: 'incident_archived' }),
    ]);
  });

  test('a claim waits for an uncommitted deletion and then blocks the queued delivery', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `delivery-delete-race-${randomUUID()}`,
        alertSource: 'slack',
        service: 'deleted-delivery-race',
        severity: 'sev3',
      })
    ).id;
    const binding = await recordSurfaceBinding(app.db, tenantA, {
      incidentId,
      surface: 'slack',
      channel: 'C-DELETE-RACE',
      threadId: randomUUID(),
    });
    const messageId = await appendWithOutbox(tenantA, incidentId, 'dashboard');
    await withTenant(app.db, tenantA, (tx) => transitionIncidentTx(tx, incidentId, 'resolved'));
    let releaseDelete!: () => void;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let deleteApplied!: () => void;
    const deleteReached = new Promise<void>((resolve) => {
      deleteApplied = resolve;
    });
    const deletion = withTenant(app.db, tenantA, async (tx) => {
      const result = await setIncidentArchivedTx(tx, incidentId, true, { expectedVersion: 1 });
      deleteApplied();
      await deleteReleased;
      return result;
    });
    await deleteReached;

    let claimSettled = false;
    const claim = claimSurfaceDelivery(app.db, tenantA, 'slack', binding.id, messageId).then(
      (result) => {
        claimSettled = true;
        return result;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(claimSettled).toBe(false);
    releaseDelete();

    await expect(deletion).resolves.toMatchObject({ outcome: 'applied' });
    await expect(claim).resolves.toBe(false);
    expect(await listSurfaceDeliveriesForMessages(app.db, tenantA, [messageId])).toEqual([
      expect.objectContaining({ state: 'blocked', reasonCode: 'incident_archived' }),
    ]);
  });

  test('deletion waits while a surface request is in flight', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `delivery-in-flight-${randomUUID()}`,
        alertSource: 'slack',
        service: 'sending-delivery',
        severity: 'sev3',
      })
    ).id;
    const binding = await recordSurfaceBinding(app.db, tenantA, {
      incidentId,
      surface: 'slack',
      channel: 'C-SENDING',
      threadId: randomUUID(),
    });
    const messageId = await appendWithOutbox(tenantA, incidentId, 'dashboard');
    await withTenant(app.db, tenantA, (tx) => transitionIncidentTx(tx, incidentId, 'resolved'));
    let releaseClaim!: () => void;
    const claimReleased = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimApplied!: () => void;
    const claimReached = new Promise<void>((resolve) => {
      claimApplied = resolve;
    });
    const claim = withTenant(app.db, tenantA, async (tx) => {
      const result = await claimSurfaceDeliveryTx(tx, 'slack', binding.id, messageId);
      claimApplied();
      await claimReleased;
      return result;
    });
    await claimReached;

    let deleteSettled = false;
    const deletion = withTenant(app.db, tenantA, (tx) =>
      setIncidentArchivedTx(tx, incidentId, true, { expectedVersion: 1 }),
    ).then((result) => {
      deleteSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deleteSettled).toBe(false);
    releaseClaim();

    await expect(claim).resolves.toBe(true);
    await expect(deletion).resolves.toMatchObject({ outcome: 'work_in_progress' });
    await finishSurfaceDelivery(app.db, tenantA, 'slack', binding.id, messageId, {
      state: 'accepted',
      operation: 'post',
      remoteMessageId: 'remote-message',
    });
    expect(
      await withTenant(app.db, tenantA, (tx) =>
        setIncidentArchivedTx(tx, incidentId, true, { expectedVersion: 1 }),
      ),
    ).toMatchObject({ outcome: 'applied' });
  });

  test('a delayed poison row does not block later eligible outbox work', async () => {
    const poison = await appendWithOutbox(tenantA, incidentA, 'dashboard');
    const later = await appendWithOutbox(tenantA, incidentA, 'dashboard');
    const retryAt = new Date(Date.now() + 60_000);

    expect(
      await scheduleSurfaceDeliveryRetry(
        app.db,
        tenantA,
        'slack',
        bindingA,
        poison,
        'queued',
        retryAt,
        'dependency_unavailable',
      ),
    ).toBe(true);
    const queued = await listQueuedSurfaceMessagesSystem(admin.db, 100);
    expect(queued.some((item) => item.message.id === poison)).toBe(false);
    expect(queued.some((item) => item.message.id === later)).toBe(true);
    expect(await claimSurfaceDelivery(app.db, tenantA, 'slack', bindingA, poison)).toBe(false);

    expect(
      await scheduleSurfaceDeliveryRetry(
        app.db,
        tenantA,
        'slack',
        bindingA,
        poison,
        'queued',
        new Date(Date.now() - 1_000),
        'dependency_unavailable',
      ),
    ).toBe(true);
    const eligible = await listQueuedSurfaceMessagesSystem(admin.db, 100);
    expect(eligible.some((item) => item.message.id === poison)).toBe(true);
    expect(await claimSurfaceDelivery(app.db, tenantA, 'slack', bindingA, poison)).toBe(true);
  });

  test('a claimed rate-limited row returns to a delayed queue', async () => {
    const messageId = await appendWithOutbox(tenantA, incidentA, 'dashboard');
    expect(await claimSurfaceDelivery(app.db, tenantA, 'slack', bindingA, messageId)).toBe(true);
    expect(
      await scheduleSurfaceDeliveryRetry(
        app.db,
        tenantA,
        'slack',
        bindingA,
        messageId,
        'sending',
        new Date(Date.now() + 60_000),
        'rate_limited',
      ),
    ).toBe(true);

    const [receipt] = await listSurfaceDeliveriesForMessages(app.db, tenantA, [messageId]);
    expect(receipt).toMatchObject({
      state: 'queued',
      reasonCode: 'rate_limited',
      attemptedAt: null,
    });
    expect(await claimSurfaceDelivery(app.db, tenantA, 'slack', bindingA, messageId)).toBe(false);
  });

  test('disconnect fences both queued and in-flight rows before deleting the connection', async () => {
    const queuedId = await appendWithOutbox(tenantB, incidentB, 'dashboard');
    const sendingId = await appendWithOutbox(tenantB, incidentB, 'dashboard');
    expect(await claimSurfaceDelivery(app.db, tenantB, 'slack', bindingB, sendingId)).toBe(true);

    await disconnectSurfaceConfig(app.db, tenantB, 'slack');

    expect(await getSurfaceConfig(app.db, tenantB, 'slack')).toBeUndefined();
    const receipts = await listSurfaceDeliveriesForMessages(app.db, tenantB, [queuedId, sendingId]);
    expect(receipts.find((receipt) => receipt.messageId === queuedId)).toMatchObject({
      state: 'blocked',
      reasonCode: 'not_connected',
    });
    expect(receipts.find((receipt) => receipt.messageId === sendingId)).toMatchObject({
      state: 'uncertain',
      reasonCode: 'disconnected_in_flight',
    });
    expect(
      await scheduleSurfaceDeliveryRetry(
        app.db,
        tenantB,
        'slack',
        bindingB,
        sendingId,
        'sending',
        new Date(Date.now() + 60_000),
        'rate_limited',
      ),
    ).toBe(false);
  });

  test('lifecycle projects everywhere while findings follow the newly active thread', async () => {
    const source = await recordSurfaceBinding(app.db, tenantA, {
      incidentId: incidentA,
      surface: 'slack',
      channel: 'C-DELIVERY-A',
      threadId: '1787000000.000099',
      role: 'source',
    });
    await activateSurfaceBinding(app.db, tenantA, 'slack', incidentA, source.id);
    const lifecycle = await appendWithOutbox(tenantA, incidentA, null, 'lifecycle', {
      lifecycleFrom: 'open',
      lifecycleTo: 'mitigated',
      lifecycleVersion: 9,
      transitionKey: randomUUID(),
    });
    const finding = await appendWithOutbox(tenantA, incidentA, null, 'finding');

    expect(await listMessageDeliveryTargets(app.db, tenantA, lifecycle)).toEqual(
      expect.arrayContaining([
        { surface: 'slack', bindingId: bindingA, bindingAssignmentVersion: 2 },
        { surface: 'slack', bindingId: source.id, bindingAssignmentVersion: 0 },
      ]),
    );
    expect(await listMessageDeliveryTargets(app.db, tenantA, lifecycle)).toHaveLength(2);
    expect(await listMessageDeliveryTargets(app.db, tenantA, finding)).toEqual([
      { surface: 'slack', bindingId: source.id, bindingAssignmentVersion: 0 },
    ]);
  });
});
