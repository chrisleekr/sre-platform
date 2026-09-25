import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applySignalObservation,
  connectorConfigs,
  investigationRuns,
  jobs,
  approvals,
  createApproval,
  createIncident,
  getIncident,
  incidents,
  listResponseGroupSignalsTx,
  recordIncidentRelation,
  serializeSignalFence,
  withTenant,
} from '@sre/db';
import { createFixture } from './hub.fixture';
const fixture = createFixture();
async function seed(policy: 'provider_clear' | 'verified_recovery' = 'provider_clear') {
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
  const signal = await applySignalObservation(fixture.app.db, fixture.tenantA, {
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
  return { incident, signal: signal.signal };
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
async function relate(source: string, target: string, type: 'caused_by' | 'unrelated') {
  return recordIncidentRelation(fixture.app.db, fixture.tenantA, {
    sourceIncidentId: source,
    targetIncidentId: target,
    type,
    rationale: 'Current dependency evidence',
    evidence: ['human:observed'],
    decidedBy: 'human',
  });
}
test.each(['provider_clear', 'verified_recovery'] as const)(
  'a causal group honors its %s child policy',
  async (policy) => {
    const root = await seed();
    const child = await seed(policy);
    await relate(child.incident.id, root.incident.id, 'caused_by');
    const handled = await fixture.hub.resolveProviderClear(
      fixture.tenantA,
      root.incident.id,
      await fence(root.incident.id),
      randomUUID(),
    );
    expect(handled).toBe(policy === 'provider_clear');
    for (const id of [root.incident.id, child.incident.id]) {
      expect(await getIncident(fixture.app.db, fixture.tenantA, id)).toMatchObject({
        status: policy === 'provider_clear' ? 'resolved' : 'open',
        resolutionBasis: policy === 'provider_clear' ? 'provider_clear' : null,
      });
    }
  },
);
test('final approval reevaluates provider clearance without a verified health projection', async () => {
  const { incident } = await seed();
  const approval = await createApproval(fixture.app.db, fixture.tenantA, {
    incidentId: incident.id,
    actionId: randomUUID(),
    prompt: 'Apply change?',
    options: [{ id: 'deny', label: 'Deny' }],
  });
  await fixture.hub.resolveProviderClear(
    fixture.tenantA,
    incident.id,
    await fence(incident.id),
    randomUUID(),
  );
  expect(
    (await getIncident(fixture.app.db, fixture.tenantA, incident.id))?.recoveryNextStep,
  ).toContain('pending action');
  const messages = await withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
    await tx.update(approvals).set({ decision: 'deny' }).where(eq(approvals.id, approval.row.id));
    return fixture.hub.completeVerifiedRecoveryAfterApprovalTx(
      tx,
      fixture.tenantA,
      incident.id,
      approval.row.id,
    );
  });
  expect(messages).toHaveLength(1);
  // The blocked narrative must not survive onto the resolved incident.
  expect(await getIncident(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
    status: 'resolved',
    resolutionBasis: 'provider_clear',
    recoveryState: null,
    recoverySummary: null,
    recoveryNextStep: null,
    recoveryUpdatedAt: null,
  });
});
test('causal removal and re-add invalidate an earlier group decision even with identical signal membership', async () => {
  const root = await seed();
  const child = await seed();
  await relate(child.incident.id, root.incident.id, 'caused_by');
  const before = await fence(root.incident.id);
  await relate(child.incident.id, root.incident.id, 'unrelated');
  await relate(child.incident.id, root.incident.id, 'caused_by');
  expect((await fence(root.incident.id)).lifecycleVersion).toBeGreaterThan(before.lifecycleVersion);
  await fixture.hub.resolveProviderClear(fixture.tenantA, root.incident.id, before, randomUUID());
  expect((await getIncident(fixture.app.db, fixture.tenantA, root.incident.id))?.status).toBe(
    'open',
  );
});
test('reopening and causal changes clear the prior provider resolution basis', async () => {
  const root = await seed();
  await fixture.hub.resolveProviderClear(
    fixture.tenantA,
    root.incident.id,
    await fence(root.incident.id),
    randomUUID(),
  );
  await fixture.hub.transitionIncident(fixture.tenantA, root.incident.id, {
    to: 'open',
    reason: 'A new symptom requires investigation.',
    transitionKey: randomUUID(),
    author: 'system',
  });
  expect(
    (await getIncident(fixture.app.db, fixture.tenantA, root.incident.id))?.resolutionBasis,
  ).toBeNull();
  await fixture.hub.resolveProviderClear(
    fixture.tenantA,
    root.incident.id,
    await fence(root.incident.id),
    randomUUID(),
  );
  const child = await seed();
  await relate(child.incident.id, root.incident.id, 'caused_by');
  expect(
    (await getIncident(fixture.app.db, fixture.tenantA, root.incident.id))?.resolutionBasis,
  ).toBeNull();
});
test('a child policy change invalidates an existing group verification and queues the current root', async () => {
  const root = await seed();
  const child = await seed();
  await relate(child.incident.id, root.incident.id, 'caused_by');
  await fixture.admin.db
    .update(incidents)
    .set({ recoveryState: 'verified' })
    .where(eq(incidents.id, root.incident.id));
  const before = await fence(root.incident.id);
  const enqueueRecoveryTx = vi.fn(async () => randomUUID());
  const current = await getIncident(fixture.app.db, fixture.tenantA, child.incident.id);
  const changed = await fixture.hub.changeResolutionPolicy(fixture.tenantA, child.incident.id, {
    policy: 'verified_recovery',
    reason: 'Require a health check for the dependent service.',
    requestId: randomUUID(),
    expectedVersion: current!.lifecycleVersion,
    authorUserId: fixture.memberUserId,
    enqueueRecoveryTx,
  });
  expect(changed.outcome).toBe('applied');
  expect((await fence(root.incident.id)).lifecycleVersion).toBeGreaterThan(before.lifecycleVersion);
  expect(
    (await getIncident(fixture.app.db, fixture.tenantA, root.incident.id))?.recoveryState,
  ).toBeNull();
  expect(enqueueRecoveryTx).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ rootIncidentId: root.incident.id }),
  );
});
test('policy mutation refuses an unauthenticated or inactive member', async () => {
  const { incident } = await seed();
  const result = await fixture.hub.changeResolutionPolicy(fixture.tenantA, incident.id, {
    policy: 'verified_recovery',
    reason: 'Review required',
    requestId: randomUUID(),
    expectedVersion: 0,
    authorUserId: null,
    enqueueRecoveryTx: vi.fn(),
  });
  expect(result.outcome).toBe('forbidden');
  expect((await getIncident(fixture.app.db, fixture.tenantA, incident.id))?.lifecycleVersion).toBe(
    0,
  );
});
test('policy mutation refuses an archived incident without changing it', async () => {
  const { incident } = await seed('verified_recovery');
  await fixture.admin.db
    .update(incidents)
    .set({ archivedAt: new Date() })
    .where(eq(incidents.id, incident.id));
  const enqueueRecoveryTx = vi.fn();
  const result = await fixture.hub.changeResolutionPolicy(fixture.tenantA, incident.id, {
    policy: 'provider_clear',
    reason: 'Monitoring is the approved criterion.',
    requestId: randomUUID(),
    expectedVersion: 0,
    authorUserId: fixture.memberUserId,
    enqueueRecoveryTx,
  });
  expect(result).toEqual({ outcome: 'archived' });
  expect(enqueueRecoveryTx).not.toHaveBeenCalled();
  expect(await getIncident(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
    resolutionPolicy: 'verified_recovery',
    lifecycleVersion: 0,
  });
});
test('a replayed request identity is a noop only when its content matches the recorded command', async () => {
  const { incident } = await seed('verified_recovery');
  const command = {
    policy: 'provider_clear' as const,
    reason: 'Monitoring is the approved criterion.',
    requestId: randomUUID(),
    expectedVersion: 0,
    authorUserId: fixture.memberUserId,
    enqueueRecoveryTx: vi.fn(async () => null),
  };
  const change = () => fixture.hub.changeResolutionPolicy(fixture.tenantA, incident.id, command);
  expect((await change()).outcome).toBe('applied');
  // A retry carries the pre-change version, so the replay check must run before the version check.
  expect(await change()).toEqual({ outcome: 'noop' });
  expect(
    await fixture.hub.changeResolutionPolicy(fixture.tenantA, incident.id, {
      ...command,
      reason: 'A different justification under the same request identity.',
    }),
  ).toEqual({ outcome: 'stale' });
  expect(await getIncident(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
    resolutionPolicy: 'provider_clear',
    lifecycleVersion: 1,
  });
});

test.each(['policy', 'causal'] as const)(
  '%s invalidation restores the investigation status saved by an in-flight recovery',
  async (mutation) => {
    const { incident } = await seed('verified_recovery');
    const child = await seed();
    const jobId = randomUUID();
    await fixture.admin.db.insert(jobs).values({
      id: jobId,
      tenantId: fixture.tenantA,
      type: 'recovery.verify',
      stream: 'sre:triage',
      status: 'processing',
      payload: { incidentId: incident.id, restoreInvestigationStatus: 'assessed' },
    });
    const runId = randomUUID();
    await fixture.admin.db.insert(investigationRuns).values({
      id: runId,
      tenantId: fixture.tenantA,
      incidentId: incident.id,
      operation: 'verify-recovery',
      jobId,
    });
    await fixture.admin.db
      .update(incidents)
      .set({ investigationStatus: 'gathering', recoveryState: 'verifying', recoveryRunId: runId })
      .where(eq(incidents.id, incident.id));
    if (mutation === 'policy') {
      await fixture.hub.changeResolutionPolicy(fixture.tenantA, incident.id, {
        policy: 'provider_clear',
        reason: 'Monitoring is the approved criterion.',
        requestId: randomUUID(),
        expectedVersion: 0,
        authorUserId: fixture.memberUserId,
        enqueueRecoveryTx: vi.fn(async () => null),
      });
    } else await relate(child.incident.id, incident.id, 'caused_by');
    expect(await getIncident(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
      investigationStatus: 'assessed',
      recoveryState: null,
      lifecycleVersion: 1,
    });
  },
);

test.each(['root', 'child'] as const)(
  'a %s refire invalidates provider resolution basis across its causal group',
  async (member) => {
    const root = await seed();
    const child = await seed();
    await relate(child.incident.id, root.incident.id, 'caused_by');
    await fixture.hub.resolveProviderClear(
      fixture.tenantA,
      root.incident.id,
      await fence(root.incident.id),
      randomUUID(),
    );
    const target = member === 'root' ? root : child;
    await applySignalObservation(fixture.app.db, fixture.tenantA, {
      incidentId: target.incident.id,
      surface: target.signal.surface,
      channel: target.signal.channel,
      externalMessageId: `${target.signal.externalMessageId}:new-episode`,
      state: 'firing',
      summary: 'Monitor refired',
      contentHash: randomUUID(),
      eventKey: randomUUID(),
      eventAt: new Date(target.signal.lastEventAt.getTime() + 1000),
    });
    for (const id of [root.incident.id, child.incident.id]) {
      expect((await getIncident(fixture.app.db, fixture.tenantA, id))?.resolutionBasis).toBeNull();
    }
  },
);

test('terminal reopening discards prior verified health before a later approval can resolve it', async () => {
  const { incident } = await seed('verified_recovery');
  await fixture.admin.db
    .update(incidents)
    .set({ recoveryState: 'verified' })
    .where(eq(incidents.id, incident.id));
  await fixture.hub.transitionIncident(fixture.tenantA, incident.id, {
    to: 'resolved',
    reason: 'Health was verified.',
    transitionKey: randomUUID(),
    author: 'system',
  });
  await fixture.hub.transitionIncident(fixture.tenantA, incident.id, {
    to: 'open',
    reason: 'A fresh issue needs investigation.',
    transitionKey: randomUUID(),
    author: 'system',
  });
  expect(await getIncident(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
    status: 'open',
    resolutionBasis: null,
    recoveryState: null,
  });
  const messages = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    fixture.hub.completeVerifiedRecoveryAfterApprovalTx(
      tx,
      fixture.tenantA,
      incident.id,
      randomUUID(),
    ),
  );
  expect(messages).toHaveLength(0);
});

test('reopening a terminal child invalidates current root verification and the group fence', async () => {
  const root = await seed('verified_recovery');
  const child = await seed();
  await relate(child.incident.id, root.incident.id, 'caused_by');
  await fixture.hub.transitionIncident(fixture.tenantA, child.incident.id, {
    to: 'resolved',
    reason: 'Child monitor recovered.',
    transitionKey: randomUUID(),
    author: 'system',
  });
  await fixture.admin.db
    .update(incidents)
    .set({ recoveryState: 'verified' })
    .where(eq(incidents.id, root.incident.id));
  const before = await fence(root.incident.id);
  await fixture.hub.transitionIncident(fixture.tenantA, child.incident.id, {
    to: 'open',
    reason: 'Child requires a fresh assessment.',
    transitionKey: randomUUID(),
    author: 'system',
  });
  expect(
    (await getIncident(fixture.app.db, fixture.tenantA, root.incident.id))?.recoveryState,
  ).toBeNull();
  expect((await fence(root.incident.id)).lifecycleVersion).toBeGreaterThan(before.lifecycleVersion);
});
