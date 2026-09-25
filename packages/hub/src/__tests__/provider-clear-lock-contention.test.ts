import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  applySignalObservation,
  approvals,
  connectorConfigs,
  createApproval,
  createIncident,
  getIncident,
  listResponseGroupSignalsTx,
  serializeSignalFence,
  withTenant,
} from '@sre/db';
import { createFixture } from './hub.fixture';

const fixture = createFixture();

async function seed(policy: 'provider_clear' | 'verified_recovery') {
  const dataSourceId = randomUUID();
  await fixture.admin.db.insert(connectorConfigs).values({
    id: dataSourceId,
    tenantId: fixture.tenantA,
    type: 'statuscake',
    name: dataSourceId,
    enabled: true,
  });
  const incident = await createIncident(fixture.app.db, fixture.tenantA, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
    resolutionPolicy: policy,
  });
  await applySignalObservation(fixture.app.db, fixture.tenantA, {
    incidentId: incident.id,
    dataSourceId,
    providerFingerprint: randomUUID(),
    startsAt: new Date(Date.now() - 60000),
    signalSource: {
      kind: 'monitor' as const,
      lifecycleVersion: 0,
      provider: 'statuscake',
      dataSourceId,
      externalId: '73',
      displayName: 'Checkout uptime',
      observedAt: new Date().toISOString(),
    },
    surface: 'slack',
    channel: 'C_RECOVERY',
    externalMessageId: randomUUID(),
    state: 'resolved',
    clearProvenance: 'provider',
    eventKey: randomUUID(),
    eventAt: new Date(),
    summary: 'Monitor recovered',
    contentHash: randomUUID(),
  });
  return { incident, dataSourceId };
}

async function fence(id: string) {
  const incident = await getIncident(fixture.app.db, fixture.tenantA, id);
  const signals = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    listResponseGroupSignalsTx(tx, fixture.tenantA, id),
  );
  return {
    lifecycleVersion: incident!.lifecycleVersion,
    signalFence: serializeSignalFence(signals),
  };
}

/** Runs `body` while another connection holds the lock a connector write takes on the row. */
async function whileConnectorWriteHeld<T>(dataSourceId: string, body: () => Promise<T>) {
  return fixture.admin.db.transaction(async (holder) => {
    await holder.execute(
      sql`select id from connector_configs where id = ${dataSourceId} for no key update`,
    );
    return body();
  });
}

test('a verified-recovery group never waits on or fails over a connector write', async () => {
  const { incident, dataSourceId } = await seed('verified_recovery');
  const handled = await whileConnectorWriteHeld(dataSourceId, async () =>
    fixture.hub.resolveProviderClear(
      fixture.tenantA,
      incident.id,
      await fence(incident.id),
      randomUUID(),
    ),
  );
  expect(handled).toBe(false);
});

test('a contended provider-clear evaluation fails without writing so the worker can redeliver', async () => {
  const { incident, dataSourceId } = await seed('provider_clear');
  const expected = await fence(incident.id);
  await expect(
    whileConnectorWriteHeld(dataSourceId, () =>
      fixture.hub.resolveProviderClear(fixture.tenantA, incident.id, expected, randomUUID()),
    ),
  ).rejects.toMatchObject({ name: 'ProviderClearLockContendedError' });
  expect(await getIncident(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
    status: 'open',
    resolutionBasis: null,
  });
  // Once the connector write commits, the redelivered evaluation resolves the incident.
  expect(
    await fixture.hub.resolveProviderClear(fixture.tenantA, incident.id, expected, randomUUID()),
  ).toBe(true);
  expect((await getIncident(fixture.app.db, fixture.tenantA, incident.id))?.status).toBe(
    'resolved',
  );
});

test('a contended approval commits its decision and hands recovery to a durable job', async () => {
  const { incident, dataSourceId } = await seed('provider_clear');
  const approval = await createApproval(fixture.app.db, fixture.tenantA, {
    incidentId: incident.id,
    actionId: randomUUID(),
    prompt: 'Apply change?',
    options: [{ id: 'deny', label: 'Deny' }],
  });
  const enqueueRecoveryTx = vi.fn(async () => randomUUID());
  const messages = await whileConnectorWriteHeld(dataSourceId, () =>
    withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
      await tx.update(approvals).set({ decision: 'deny' }).where(eq(approvals.id, approval.row.id));
      const result = await fixture.hub.completeVerifiedRecoveryAfterApprovalTx(
        tx,
        fixture.tenantA,
        incident.id,
        approval.row.id,
        enqueueRecoveryTx,
      );
      // The caller's transaction must still accept writes after the contended lock.
      await tx
        .update(approvals)
        .set({ decidedBy: 'responder' })
        .where(eq(approvals.id, approval.row.id));
      return result;
    }),
  );
  expect(messages).toEqual([]);
  expect(enqueueRecoveryTx).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ rootIncidentId: incident.id }),
  );
  const decided = await fixture.admin.db
    .select({ decision: approvals.decision, decidedBy: approvals.decidedBy })
    .from(approvals)
    .where(eq(approvals.id, approval.row.id));
  expect(decided[0]).toEqual({ decision: 'deny', decidedBy: 'responder' });
  expect((await getIncident(fixture.app.db, fixture.tenantA, incident.id))?.status).toBe('open');
});
