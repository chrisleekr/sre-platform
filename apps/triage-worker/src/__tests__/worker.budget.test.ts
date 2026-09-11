import { randomUUID } from 'node:crypto';

import {
  admitInvestigationRun,
  applySignalObservation,
  createIncident,
  getIncident,
  incidents as incidentTable,
  investigationRuns,
  serializeSignalFence,
} from '@sre/db';
import { and, eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';

import type { TriageEngine } from '../engine/types';
import { createFixture } from './worker.fixture';

const __fixture = createFixture();

test('automatic budget authority is derived from durable incident provenance', async () => {
  const incidents = await Promise.all(
    ['admitted', 'denied'].map((name) =>
      createIncident(__fixture.app.db, __fixture.tenantId, {
        fingerprint: `worker-budget-${name}-${randomUUID()}`,
        alertSource: 'alertmanager',
        service: 'checkout',
        severity: 'sev2',
      }),
    ),
  );
  const investigate = vi.fn<TriageEngine['investigate']>(async (input) => ({
    provider: 'fake',
    sessionId: `budget:${input.incident.id}`,
    model: 'fake-budget',
    outcome: 'inconclusive',
    turnBudget: 1,
    summary: 'The test investigation was inconclusive.',
    confidence: 0,
    rankedHypotheses: [],
  }));
  const engine: TriageEngine = {
    provider: 'fake',
    investigate,
    resume: async () => {
      throw new Error('resume is not used');
    },
    verifyRecovery: async () => {
      throw new Error('recovery is not used');
    },
  };
  const worker = __fixture.workerWithEngine(engine, {
    getAutomaticInvestigationBudget: async () => ({
      tenantRunLimit: 1,
      monitorRunLimit: 0,
      tenantConfiguredCostLimitUsd: 0,
      monitorConfiguredCostLimitUsd: 0,
      configuredCostReady: true,
    }),
  });
  const automaticTrigger = {
    reason: 'new_episode' as const,
    automatic: true,
    monitorKey: 'alertmanager:checkout-errors',
  };

  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'triage',
      attempts: 1,
      payload: { incidentId: incidents[0]!.id, investigationTrigger: automaticTrigger },
    },
    { signal: new AbortController().signal },
  );
  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'triage',
      attempts: 1,
      payload: { incidentId: incidents[1]!.id, investigationTrigger: automaticTrigger },
    },
    { signal: new AbortController().signal },
  );

  expect(investigate).toHaveBeenCalledTimes(1);
  const deniedRuns = await __fixture.admin.db
    .select()
    .from(investigationRuns)
    .where(
      and(
        eq(investigationRuns.tenantId, __fixture.tenantId),
        eq(investigationRuns.incidentId, incidents[1]!.id),
      ),
    );
  expect(deniedRuns).toEqual([
    expect.objectContaining({
      outcome: 'budget_exhausted',
      triggerReason: 'new_episode',
      triggerAutomatic: true,
    }),
  ]);
  expect(
    (await __fixture.hub.history(__fixture.tenantId, incidents[1]!.id)).some((message) =>
      message.content.includes('Automatic investigation paused'),
    ),
  ).toBe(true);

  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'triage',
      attempts: 1,
      payload: {
        incidentId: incidents[1]!.id,
        investigationTrigger: {
          reason: 'manual_investigation',
          automatic: false,
          monitorKey: null,
        },
      },
    },
    { signal: new AbortController().signal },
  );
  expect(investigate).toHaveBeenCalledTimes(1);
  const manualIncident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `worker-budget-manual-${randomUUID()}`,
    alertSource: 'manual',
    service: 'checkout',
    severity: 'sev2',
  });
  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'triage',
      attempts: 1,
      payload: { incidentId: manualIncident.id },
    },
    { signal: new AbortController().signal },
  );
  expect(investigate).toHaveBeenCalledTimes(2);
  expect(
    (
      await __fixture.admin.db
        .select()
        .from(investigationRuns)
        .where(eq(investigationRuns.incidentId, manualIncident.id))
    ).some((run) => run.triggerReason === 'manual_investigation' && run.triggerAutomatic === false),
  ).toBe(true);

  const mentionIncident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `worker-budget-mention-${randomUUID()}`,
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev2',
  });
  await __fixture.hub.append(__fixture.tenantId, mentionIncident.id, {
    author: 'human',
    kind: 'text',
    content: 'Human-initiated via @mention. Checkout is failing.',
    originSurface: 'slack',
    originMessageId: `slack:C-alerts:${randomUUID()}`,
  });
  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'triage',
      attempts: 1,
      payload: { incidentId: mentionIncident.id },
    },
    { signal: new AbortController().signal },
  );
  expect(investigate).toHaveBeenCalledTimes(3);
  expect(
    (
      await __fixture.admin.db
        .select()
        .from(investigationRuns)
        .where(eq(investigationRuns.incidentId, mentionIncident.id))
    ).some((run) => run.triggerReason === 'manual_investigation' && !run.triggerAutomatic),
  ).toBe(true);
});

test('manual investigations do not depend on automatic budget settings availability', async () => {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `worker-budget-manual-settings-${randomUUID()}`,
    alertSource: 'manual',
    service: 'checkout',
    severity: 'sev2',
  });
  const investigate = vi.fn<TriageEngine['investigate']>(async () => ({
    provider: 'fake',
    sessionId: `manual-settings:${incident.id}`,
    model: 'fake-budget',
    outcome: 'inconclusive',
    turnBudget: 1,
    summary: 'Manual investigation completed while budget settings were unavailable.',
    confidence: 0,
  }));
  const worker = __fixture.workerWithEngine(
    {
      provider: 'fake',
      investigate,
      resume: async () => {
        throw new Error('resume is not used');
      },
      verifyRecovery: async () => {
        throw new Error('recovery is not used');
      },
    },
    {
      getAutomaticInvestigationBudget: async () => {
        throw new Error('settings unavailable');
      },
    },
  );

  await expect(
    worker.handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'triage',
        attempts: 1,
        payload: { incidentId: incident.id },
      },
      { signal: new AbortController().signal },
    ),
  ).resolves.toBeUndefined();
  expect(investigate).toHaveBeenCalledOnce();
});

test('an exhausted scheduled recovery becomes a human-visible not-verified state', async () => {
  const blocker = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `recovery-budget-blocker-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev3',
  });
  const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `recovery-budget-target-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev3',
  });
  const monitorKey = `alertmanager:recovery-budget-${randomUUID()}`;
  const secondMonitorKey = `alertmanager:recovery-budget-${randomUUID()}`;
  const limits = {
    tenantRunLimit: 0,
    monitorRunLimit: 1,
    tenantConfiguredCostLimitUsd: 0,
    monitorConfiguredCostLimitUsd: 0,
    configuredCostReady: true,
  };
  await admitInvestigationRun(__fixture.app.db, __fixture.tenantId, blocker.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey },
    limits,
  });
  const resolved = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    incidentId: incident.id,
    provider: 'alertmanager',
    providerFingerprint: randomUUID(),
    monitorKey,
    startsAt: new Date('2026-08-31T00:00:00.000Z'),
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId: `resolved-${randomUUID()}`,
    state: 'resolved',
    summary: 'Alert resolved.',
    contentHash: 'resolved',
    materialHash: 'resolved-material',
    eventKey: `resolved:${randomUUID()}`,
    eventAt: new Date('2026-08-31T00:05:00.000Z'),
  });
  const secondResolved = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    incidentId: incident.id,
    provider: 'alertmanager',
    providerFingerprint: randomUUID(),
    monitorKey: secondMonitorKey,
    startsAt: new Date('2026-08-31T00:00:00.000Z'),
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId: `resolved-${randomUUID()}`,
    state: 'resolved',
    summary: 'A second alert resolved.',
    contentHash: 'second-resolved',
    materialHash: 'second-resolved-material',
    eventKey: `resolved:${randomUUID()}`,
    eventAt: new Date('2026-08-31T00:05:00.000Z'),
  });
  await __fixture.admin.db
    .update(incidentTable)
    .set({
      recoveryState: 'monitoring',
      recoveryNextCheckAt: new Date('2026-08-31T00:10:00.000Z'),
      recoveryScheduleReason: 'Wait for the service to settle.',
    })
    .where(eq(incidentTable.id, incident.id));
  const verifyRecovery = vi.fn<TriageEngine['verifyRecovery']>();
  const worker = __fixture.workerWithEngine(
    {
      provider: 'fake',
      investigate: async () => {
        throw new Error('investigate is not used');
      },
      resume: async () => {
        throw new Error('resume is not used');
      },
      verifyRecovery,
    },
    { getAutomaticInvestigationBudget: async () => limits },
  );

  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'recovery.verify',
      attempts: 1,
      payload: {
        incidentId: incident.id,
        lifecycleVersion: 0,
        signalFence: serializeSignalFence([resolved.signal, secondResolved.signal]),
        investigationTrigger: {
          reason: 'recovery_verification',
          automatic: true,
          monitorKey,
        },
      },
    },
    { signal: new AbortController().signal },
  );

  expect(verifyRecovery).not.toHaveBeenCalled();
  expect(
    (
      await __fixture.admin.db
        .select()
        .from(investigationRuns)
        .where(eq(investigationRuns.incidentId, incident.id))
    )[0],
  ).toMatchObject({ triggerMonitorKeys: [monitorKey, secondMonitorKey].sort() });
  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident.id)).toMatchObject({
    recoveryState: 'not_verified',
    recoveryNextCheckAt: null,
    recoveryScheduleReason: null,
    recoveryNextStep: 'Send a responder message to continue recovery verification.',
  });
});

test('a stale recovery job cannot consume budget or stamp a refired incident not verified', async () => {
  const blocker = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `stale-recovery-blocker-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev3',
  });
  const incident = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `stale-recovery-target-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev3',
  });
  const monitorKey = `alertmanager:stale-recovery-${randomUUID()}`;
  const limits = {
    tenantRunLimit: 0,
    monitorRunLimit: 1,
    tenantConfiguredCostLimitUsd: 0,
    monitorConfiguredCostLimitUsd: 0,
    configuredCostReady: true,
  };
  await admitInvestigationRun(__fixture.app.db, __fixture.tenantId, blocker.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey },
    limits,
  });
  const suffix = randomUUID();
  const resolved = await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    incidentId: incident.id,
    provider: 'alertmanager',
    providerFingerprint: suffix,
    monitorKey,
    startsAt: new Date('2026-08-31T00:06:00.000Z'),
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId: `stale-${suffix}-episode-2`,
    state: 'resolved',
    summary: 'Alert resolved.',
    contentHash: 'resolved',
    materialHash: 'stale-recovery-material',
    eventKey: `resolved:${suffix}`,
    eventAt: new Date('2026-08-31T00:05:00.000Z'),
  });
  const oldFence = serializeSignalFence([resolved.signal]);
  await applySignalObservation(__fixture.app.db, __fixture.tenantId, {
    incidentId: incident.id,
    provider: 'alertmanager',
    providerFingerprint: suffix,
    monitorKey,
    startsAt: new Date('2026-08-31T00:00:00.000Z'),
    surface: 'slack',
    channel: 'C-alerts',
    externalMessageId: `stale-${suffix}`,
    state: 'firing',
    summary: 'Alert refired.',
    contentHash: 'refired',
    materialHash: 'stale-recovery-material',
    eventKey: `refired:${suffix}`,
    eventAt: new Date('2026-08-31T00:06:00.000Z'),
  });
  const verifyRecovery = vi.fn<TriageEngine['verifyRecovery']>();
  const worker = __fixture.workerWithEngine(
    {
      provider: 'fake',
      investigate: async () => {
        throw new Error('investigate is not used');
      },
      resume: async () => {
        throw new Error('resume is not used');
      },
      verifyRecovery,
    },
    { getAutomaticInvestigationBudget: async () => limits },
  );

  await worker.handle(
    {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'recovery.verify',
      attempts: 1,
      payload: { incidentId: incident.id, lifecycleVersion: 0, signalFence: oldFence },
    },
    { signal: new AbortController().signal },
  );

  expect(verifyRecovery).not.toHaveBeenCalled();
  expect(await getIncident(__fixture.app.db, __fixture.tenantId, incident.id)).toMatchObject({
    recoveryState: null,
  });
  expect(
    await __fixture.admin.db
      .select()
      .from(investigationRuns)
      .where(eq(investigationRuns.incidentId, incident.id)),
  ).toHaveLength(0);
});
