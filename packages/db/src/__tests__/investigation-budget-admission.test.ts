import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  admitInvestigationRun,
  createIncident,
  incidents,
  investigationRuns,
  makeDb,
  tenants,
  withTenant,
  type DbHandle,
} from '..';
import { eq } from 'drizzle-orm';

let admin: DbHandle;
let app: DbHandle;
const tenantId = randomUUID();

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Investigation count budget' });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(investigationRuns).where(eq(investigationRuns.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

test('serializes monitor admission and lets an explicit manual run bypass the exhausted budget', async () => {
  const incidentRows = await Promise.all(
    ['first', 'second'].map((name) =>
      createIncident(app.db, tenantId, {
        fingerprint: `budget-${name}-${randomUUID()}`,
        alertSource: 'alertmanager',
        service: 'checkout',
        severity: 'sev2',
      }),
    ),
  );
  const limits = {
    tenantRunLimit: 10,
    monitorRunLimit: 1,
    tenantConfiguredCostLimitUsd: 0,
    monitorConfiguredCostLimitUsd: 0,
    configuredCostReady: true,
  };
  const automatic = (incidentId: string) =>
    admitInvestigationRun(app.db, tenantId, incidentId, {
      jobId: randomUUID(),
      operation: 'investigate',
      trigger: {
        reason: 'new_episode',
        automatic: true,
        monitorKey: 'alertmanager:checkout-errors',
      },
      limits,
    });

  const admissions = await Promise.all(incidentRows.map((incident) => automatic(incident.id)));
  expect(admissions.filter((admission) => admission.admitted)).toHaveLength(1);
  const denied = admissions.find((admission) => !admission.admitted)!;
  expect(denied.budget?.exhaustedBy).toEqual(['monitor_run_limit']);

  const manual = await admitInvestigationRun(app.db, tenantId, incidentRows[1]!.id, {
    jobId: randomUUID(),
    operation: 'investigate',
    trigger: { reason: 'manual_investigation', automatic: false, monitorKey: null },
    limits,
  });
  expect(manual).toMatchObject({ admitted: true, budget: null });

  const rows = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(investigationRuns).where(eq(investigationRuns.tenantId, tenantId)),
  );
  expect(rows.find((row) => row.id === denied.id)).toMatchObject({
    outcome: 'budget_exhausted',
    admissionDenied: true,
    triggerReason: 'new_episode',
    triggerAutomatic: true,
    triggerMonitorKey: 'alertmanager:checkout-errors',
    triggerMonitorKeys: ['alertmanager:checkout-errors'],
    turnBudget: 0,
  });
  expect(rows.find((row) => row.id === manual.id)).toMatchObject({
    outcome: null,
    admissionDenied: false,
    triggerReason: 'manual_investigation',
    triggerAutomatic: false,
  });
  await expect(
    withTenant(app.db, tenantId, (tx) =>
      tx
        .update(investigationRuns)
        .set({ admissionDenied: true })
        .where(eq(investigationRuns.id, manual.id)),
    ),
  ).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringContaining(
        'investigation run identity and admission provenance are immutable',
      ),
    }),
  });
});

test('reuses admission when the same durable job is redelivered', async () => {
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: `budget-redelivery-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev2',
  });
  const jobId = randomUUID();
  const input = {
    jobId,
    operation: 'investigate' as const,
    trigger: {
      reason: 'new_episode' as const,
      automatic: true,
      monitorKey: `alertmanager:redelivery-${randomUUID()}`,
    },
    limits: {
      tenantRunLimit: 0,
      monitorRunLimit: 0,
      tenantConfiguredCostLimitUsd: 0,
      monitorConfiguredCostLimitUsd: 0,
      configuredCostReady: true,
    },
  };

  const first = await admitInvestigationRun(app.db, tenantId, incident.id, input);
  const second = await admitInvestigationRun(app.db, tenantId, incident.id, input);

  expect(second).toEqual(first);
  const rows = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(investigationRuns).where(eq(investigationRuns.jobId, jobId)),
  );
  expect(rows).toHaveLength(1);
});

test('reuses a terminal denied admission when the same job is redelivered', async () => {
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: `budget-denied-redelivery-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev2',
  });
  const jobId = randomUUID();
  const input = {
    jobId,
    operation: 'investigate' as const,
    trigger: {
      reason: 'new_episode' as const,
      automatic: true,
      monitorKey: `alertmanager:denied-${randomUUID()}`,
    },
    limits: {
      tenantRunLimit: 0,
      monitorRunLimit: 0,
      tenantConfiguredCostLimitUsd: 1,
      monitorConfiguredCostLimitUsd: 0,
      configuredCostReady: false,
    },
  };

  const first = await admitInvestigationRun(app.db, tenantId, incident.id, input);
  const second = await admitInvestigationRun(app.db, tenantId, incident.id, input);

  expect(first).toMatchObject({ admitted: false });
  expect(second).toEqual(first);
  const rows = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(investigationRuns).where(eq(investigationRuns.jobId, jobId)),
  );
  expect(rows).toHaveLength(1);
});
