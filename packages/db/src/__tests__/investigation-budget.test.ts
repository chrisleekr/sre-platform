import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  admitInvestigationRun,
  completeInvestigationRun,
  createIncident,
  incidents,
  investigationRuns,
  llmInvocations,
  makeDb,
  tenants,
  withTenant,
  type DbHandle,
} from '..';
import { eq, inArray } from 'drizzle-orm';

let admin: DbHandle;
let app: DbHandle;
const tenantIds: string[] = [];

const unlimitedCosts = {
  tenantConfiguredCostLimitUsd: 0,
  monitorConfiguredCostLimitUsd: 0,
  configuredCostReady: true,
};

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
});

async function testTenant(name: string): Promise<string> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await admin.db.insert(tenants).values({ id: tenantId, name });
  return tenantId;
}

afterAll(async () => {
  if (admin) {
    await admin.db.delete(llmInvocations).where(inArray(llmInvocations.tenantId, tenantIds));
    await admin.db.delete(investigationRuns).where(inArray(investigationRuns.tenantId, tenantIds));
    await admin.db.delete(incidents).where(inArray(incidents.tenantId, tenantIds));
    await admin.db.delete(tenants).where(inArray(tenants.id, tenantIds));
    await admin.close();
  }
  if (app) await app.close();
});

test('counts an admitted run that exhausts its engine turn budget', async () => {
  const tenantId = await testTenant('Investigation engine budget');
  const [firstIncident, secondIncident] = await Promise.all(
    ['first', 'second'].map((name) =>
      createIncident(app.db, tenantId, {
        fingerprint: `turn-budget-${name}-${randomUUID()}`,
        alertSource: 'alertmanager',
        service: 'checkout',
        severity: 'sev2',
      }),
    ),
  );
  const limits = { tenantRunLimit: 1, monitorRunLimit: 0, ...unlimitedCosts };
  const first = await admitInvestigationRun(app.db, tenantId, firstIncident!.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'turn-budget-monitor' },
    limits,
  });
  await completeInvestigationRun(app.db, tenantId, firstIncident!.id, {
    id: first.id,
    provider: 'fake',
    engineModel: 'fake',
    engineSessionId: 'turn-budget-session',
    turnBudget: 8,
    outcome: 'budget_exhausted',
    result: { summary: 'The engine used every allowed turn.' },
    evidenceIds: [],
  });

  const second = await admitInvestigationRun(app.db, tenantId, secondIncident!.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'another-monitor' },
    limits,
  });
  expect(second).toMatchObject({ admitted: false });
  expect(second.budget?.exhaustedBy).toContain('tenant_run_limit');
});

test('expires every tenant and monitor budget input at the rolling 24-hour boundary', async () => {
  const tenantId = await testTenant('Investigation rolling window');
  const [expiredIncident, recentIncident, targetIncident] = await Promise.all(
    ['expired', 'recent', 'target'].map((name) =>
      createIncident(app.db, tenantId, {
        fingerprint: `rolling-window-${name}-${randomUUID()}`,
        alertSource: 'alertmanager',
        service: 'checkout',
        severity: 'sev2',
      }),
    ),
  );
  const monitorKey = `rolling-window-monitor-${randomUUID()}`;
  const sourceJobIds = {
    priced: randomUUID(),
    pending: randomUUID(),
    missing: randomUUID(),
    unpriced: randomUUID(),
    recent: randomUUID(),
  };
  const now = Date.now();
  const expiredAt = new Date(now - (24 * 60 + 1) * 60_000);
  const recentAt = new Date(now - (24 * 60 - 1) * 60_000);
  await withTenant(app.db, tenantId, async (tx) => {
    const completedRun = (jobId: string, startedAt: Date, summary: string) => ({
      tenantId,
      incidentId: expiredIncident!.id,
      jobId,
      operation: 'investigate' as const,
      triggerReason: 'new_episode' as const,
      triggerAutomatic: true,
      triggerMonitorKey: monitorKey,
      triggerMonitorKeys: [monitorKey],
      provider: 'fake',
      engineModel: 'fake',
      engineSessionId: `rolling-window-${jobId}`,
      turnBudget: 1,
      outcome: 'inconclusive' as const,
      result: { summary },
      startedAt,
      completedAt: startedAt,
    });
    await tx.insert(investigationRuns).values([
      completedRun(sourceJobIds.priced, expiredAt, 'Expired priced run.'),
      completedRun(sourceJobIds.missing, expiredAt, 'Expired missing-usage run.'),
      completedRun(sourceJobIds.unpriced, expiredAt, 'Expired unpriced run.'),
      {
        ...completedRun(sourceJobIds.recent, recentAt, 'Recent priced run.'),
        incidentId: recentIncident!.id,
      },
      {
        tenantId,
        incidentId: expiredIncident!.id,
        jobId: sourceJobIds.pending,
        operation: 'investigate',
        triggerReason: 'new_episode',
        triggerAutomatic: true,
        triggerMonitorKey: monitorKey,
        triggerMonitorKeys: [monitorKey],
        turnBudget: 1,
        startedAt: expiredAt,
      },
    ]);
    await tx.insert(llmInvocations).values([
      {
        tenantId,
        incidentId: expiredIncident!.id,
        jobId: sourceJobIds.priced,
        operation: 'investigate',
        runtime: 'claude-agent-sdk',
        provider: 'anthropic',
        model: 'test-model',
        config: {},
        status: 'succeeded',
        requestCount: 1,
        inputTokens: 1,
        usageReported: true,
        configuredCostUsd: '0.600000000000',
        startedAt: expiredAt,
        completedAt: expiredAt,
      },
      {
        tenantId,
        incidentId: recentIncident!.id,
        jobId: sourceJobIds.recent,
        operation: 'investigate',
        runtime: 'claude-agent-sdk',
        provider: 'anthropic',
        model: 'test-model',
        config: {},
        status: 'succeeded',
        requestCount: 1,
        inputTokens: 1,
        usageReported: true,
        configuredCostUsd: '0.400000000000',
        startedAt: recentAt,
        completedAt: recentAt,
      },
      {
        tenantId,
        incidentId: expiredIncident!.id,
        jobId: sourceJobIds.missing,
        operation: 'investigate',
        runtime: 'claude-agent-sdk',
        provider: 'anthropic',
        model: 'test-model',
        config: {},
        status: 'succeeded',
        usageReported: false,
        configuredCostUsd: null,
        startedAt: expiredAt,
        completedAt: expiredAt,
      },
      {
        tenantId,
        incidentId: expiredIncident!.id,
        jobId: sourceJobIds.unpriced,
        operation: 'investigate',
        runtime: 'claude-agent-sdk',
        provider: 'anthropic',
        model: 'test-model',
        config: {},
        status: 'succeeded',
        usageReported: true,
        configuredCostUsd: null,
        startedAt: expiredAt,
        completedAt: expiredAt,
      },
    ]);
  });

  const blocked = await admitInvestigationRun(app.db, tenantId, targetIncident!.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey },
    limits: {
      tenantRunLimit: 1,
      monitorRunLimit: 1,
      tenantConfiguredCostLimitUsd: 0.4,
      monitorConfiguredCostLimitUsd: 0.4,
      configuredCostReady: true,
    },
  });
  expect(blocked.admitted).toBe(false);
  expect(blocked.budget?.exhaustedBy).toEqual([
    'tenant_run_limit',
    'monitor_run_limit',
    'tenant_configured_cost_limit',
    'monitor_configured_cost_limit',
  ]);

  const admission = await admitInvestigationRun(app.db, tenantId, targetIncident!.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey },
    limits: {
      tenantRunLimit: 2,
      monitorRunLimit: 2,
      tenantConfiguredCostLimitUsd: 0.5,
      monitorConfiguredCostLimitUsd: 0.5,
      configuredCostReady: true,
    },
  });

  expect(admission.admitted).toBe(true);
  expect(admission.budget).toMatchObject({
    windowHours: 24,
    tenant: {
      runs: 1,
      configuredCostUsd: 0.4,
      pendingCostRuns: 0,
      missingUsageRuns: 0,
      unpricedRuns: 0,
    },
    monitors: [
      {
        monitorKey,
        runs: 1,
        configuredCostUsd: 0.4,
        pendingCostRuns: 0,
        missingUsageRuns: 0,
        unpricedRuns: 0,
      },
    ],
    exhaustedBy: [],
  });
});

test('keeps an incomplete same-incident run pending instead of superseding it automatically', async () => {
  const tenantId = await testTenant('Investigation pending owner');
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: `pending-owner-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev2',
  });
  const limits = { tenantRunLimit: 0, monitorRunLimit: 0, ...unlimitedCosts };
  const first = await admitInvestigationRun(app.db, tenantId, incident.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'pending-owner-monitor' },
    limits,
  });
  const second = await admitInvestigationRun(app.db, tenantId, incident.id, {
    jobId: randomUUID(),
    operation: 'reassess',
    trigger: { reason: 'material_change', automatic: true, monitorKey: 'pending-owner-monitor' },
    limits,
  });

  expect(first.admitted).toBe(true);
  expect(second).toMatchObject({ admitted: false });
  expect(second.budget?.exhaustedBy).toContain('incident_run_pending');
  const rows = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(investigationRuns).where(eq(investigationRuns.incidentId, incident.id)),
  );
  expect(rows.find((row) => row.id === first.id)).toMatchObject({
    completedAt: null,
    outcome: null,
  });
});

test('fails closed when a configured-cost guard has no usable pricing model', async () => {
  const tenantId = await testTenant('Investigation pricing readiness');
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: `pricing-readiness-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev2',
  });
  const admission = await admitInvestigationRun(app.db, tenantId, incident.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'pricing-ready-monitor' },
    limits: {
      tenantRunLimit: 0,
      monitorRunLimit: 0,
      tenantConfiguredCostLimitUsd: 1,
      monitorConfiguredCostLimitUsd: 0,
      configuredCostReady: false,
    },
  });

  expect(admission).toMatchObject({ admitted: false });
  expect(admission.budget?.exhaustedBy).toEqual(['configured_cost_unavailable']);
});

test('uses completed configured cost, not provider estimates, for tenant admission', async () => {
  const tenantId = await testTenant('Investigation tenant cost');
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: `cost-budget-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'payments',
    severity: 'sev2',
  });
  const firstJobId = randomUUID();
  const limits = {
    tenantRunLimit: 0,
    monitorRunLimit: 0,
    tenantConfiguredCostLimitUsd: 0.5,
    monitorConfiguredCostLimitUsd: 0,
    configuredCostReady: true,
  };
  const first = await admitInvestigationRun(app.db, tenantId, incident.id, {
    jobId: firstJobId,
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'prometheus:latency' },
    limits,
  });
  expect(first.admitted).toBe(true);
  await completeInvestigationRun(app.db, tenantId, incident.id, {
    id: first.id,
    provider: 'fake',
    engineModel: 'fake',
    engineSessionId: 'budget-cost-test',
    turnBudget: 1,
    outcome: 'inconclusive',
    result: { summary: 'Cost-producing test run.' },
    evidenceIds: [],
  });
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(llmInvocations).values({
      tenantId,
      incidentId: incident.id,
      jobId: firstJobId,
      operation: 'investigate',
      runtime: 'claude-agent-sdk',
      provider: 'anthropic',
      model: 'test-model',
      config: {},
      status: 'succeeded',
      requestCount: 1,
      inputTokens: 1,
      usageReported: true,
      configuredCostUsd: '0.600000000000',
      providerEstimatedCostUsd: '0.100000000000',
      completedAt: new Date(),
    }),
  );

  const second = await admitInvestigationRun(app.db, tenantId, incident.id, {
    jobId: randomUUID(),
    operation: 'reassess',
    trigger: { reason: 'material_change', automatic: true, monitorKey: 'prometheus:other' },
    limits,
  });
  expect(second).toMatchObject({ admitted: false });
  expect(second.budget?.tenant).toMatchObject({ configuredCostUsd: 0.6 });
  expect(second.budget?.exhaustedBy).toEqual(['tenant_configured_cost_limit']);
});

test('enforces configured cost independently for every constituent monitor', async () => {
  const tenantId = await testTenant('Investigation monitor cost');
  const [firstIncident, sameMonitorIncident, otherMonitorIncident] = await Promise.all(
    ['first', 'same', 'other'].map((name) =>
      createIncident(app.db, tenantId, {
        fingerprint: `monitor-cost-${name}-${randomUUID()}`,
        alertSource: 'alertmanager',
        service: 'payments',
        severity: 'sev2',
      }),
    ),
  );
  const firstJobId = randomUUID();
  const limits = {
    tenantRunLimit: 0,
    monitorRunLimit: 0,
    tenantConfiguredCostLimitUsd: 0,
    monitorConfiguredCostLimitUsd: 0.5,
    configuredCostReady: true,
  };
  const first = await admitInvestigationRun(app.db, tenantId, firstIncident!.id, {
    jobId: firstJobId,
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'monitor-cost-a' },
    limits,
  });
  await completeInvestigationRun(app.db, tenantId, firstIncident!.id, {
    id: first.id,
    provider: 'fake',
    engineModel: 'fake',
    engineSessionId: 'monitor-cost-session',
    turnBudget: 1,
    outcome: 'inconclusive',
    result: { summary: 'Monitor cost test.' },
    evidenceIds: [],
  });
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(llmInvocations).values({
      tenantId,
      incidentId: firstIncident!.id,
      jobId: firstJobId,
      operation: 'investigate',
      runtime: 'claude-agent-sdk',
      provider: 'anthropic',
      model: 'test-model',
      config: {},
      status: 'succeeded',
      requestCount: 1,
      inputTokens: 1,
      usageReported: true,
      configuredCostUsd: '0.600000000000',
      completedAt: new Date(),
    }),
  );

  const sameMonitor = await admitInvestigationRun(app.db, tenantId, sameMonitorIncident!.id, {
    jobId: randomUUID(),
    operation: 'verify-recovery',
    trigger: {
      reason: 'recovery_verification',
      automatic: true,
      monitorKey: null,
      monitorKeys: ['monitor-cost-a', 'monitor-cost-b'],
    },
    limits,
  });
  expect(sameMonitor).toMatchObject({ admitted: false });
  expect(sameMonitor.budget?.exhaustedBy).toEqual(['monitor_configured_cost_limit']);
  expect(
    sameMonitor.budget?.monitors.find((item) => item.monitorKey === 'monitor-cost-a'),
  ).toMatchObject({ configuredCostUsd: 0.6 });

  const otherMonitor = await admitInvestigationRun(app.db, tenantId, otherMonitorIncident!.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'monitor-cost-c' },
    limits,
  });
  expect(otherMonitor.admitted).toBe(true);
});

test('serializes configured-cost admissions and distinguishes pending, missing, and unpriced usage', async () => {
  const tenantId = await testTenant('Investigation unresolved cost');
  const [pendingIncident, blockedIncident, missingIncident, unpricedIncident] = await Promise.all(
    ['pending', 'blocked', 'missing', 'unpriced'].map((name) =>
      createIncident(app.db, tenantId, {
        fingerprint: `unknown-cost-${name}-${randomUUID()}`,
        alertSource: 'alertmanager',
        service: 'orders',
        severity: 'sev2',
      }),
    ),
  );
  const limits = {
    tenantRunLimit: 0,
    monitorRunLimit: 0,
    tenantConfiguredCostLimitUsd: 10,
    monitorConfiguredCostLimitUsd: 10,
    configuredCostReady: true,
  };
  const pendingJobId = randomUUID();
  const pending = await admitInvestigationRun(app.db, tenantId, pendingIncident!.id, {
    jobId: pendingJobId,
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'unknown-cost-a' },
    limits,
  });
  const blocked = await admitInvestigationRun(app.db, tenantId, blockedIncident!.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'unknown-cost-a' },
    limits,
  });
  expect(blocked).toMatchObject({ admitted: false });
  expect(blocked.budget?.exhaustedBy).toEqual([
    'tenant_configured_cost_pending',
    'monitor_configured_cost_pending',
  ]);

  await completeInvestigationRun(app.db, tenantId, pendingIncident!.id, {
    id: pending.id,
    provider: 'anthropic',
    engineModel: 'unpriced-model',
    engineSessionId: 'unpriced-session',
    turnBudget: 1,
    outcome: 'inconclusive',
    result: { summary: 'Provider usage was unavailable.' },
    evidenceIds: [],
  });
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(llmInvocations).values({
      tenantId,
      incidentId: pendingIncident!.id,
      jobId: pendingJobId,
      operation: 'investigate',
      runtime: 'claude-agent-sdk',
      provider: 'anthropic',
      model: 'unpriced-model',
      config: {},
      status: 'running',
      usageReported: false,
      configuredCostUsd: null,
    }),
  );
  const missing = await admitInvestigationRun(app.db, tenantId, missingIncident!.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'unknown-cost-a' },
    limits,
  });
  expect(missing).toMatchObject({ admitted: false });
  expect(missing.budget?.exhaustedBy).toEqual(['tenant_missing_usage', 'monitor_missing_usage']);

  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(llmInvocations)
      .set({ usageReported: true })
      .where(eq(llmInvocations.jobId, pendingJobId)),
  );
  const unpriced = await admitInvestigationRun(app.db, tenantId, unpricedIncident!.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'new_episode', automatic: true, monitorKey: 'unknown-cost-a' },
    limits,
  });
  expect(unpriced).toMatchObject({ admitted: false });
  expect(unpriced.budget?.exhaustedBy).toEqual(['tenant_unpriced_usage', 'monitor_unpriced_usage']);
});
