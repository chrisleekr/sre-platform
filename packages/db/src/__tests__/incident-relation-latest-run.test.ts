import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, test } from 'vitest';
import { inArray } from 'drizzle-orm';

import {
  createIncident,
  incidentRelations,
  incidents,
  investigationRuns,
  listIncidentRelations,
  makeDb,
  recordIncidentRelation,
  tenants,
  type DbHandle,
} from '..';

let admin: DbHandle;
let app: DbHandle;
const tenantIds: string[] = [];

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentRelations).where(inArray(incidentRelations.tenantId, tenantIds));
    await admin.db.delete(investigationRuns).where(inArray(investigationRuns.tenantId, tenantIds));
    await admin.db.delete(incidents).where(inArray(incidents.tenantId, tenantIds));
    await admin.db.delete(tenants).where(inArray(tenants.id, tenantIds));
    await admin.close();
  }
  if (app) await app.close();
});

async function recurrence() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Relation latest run' });
  const make = async (title: string) =>
    (
      await createIncident(app.db, tenantId, {
        fingerprint: `relation-latest-run-${randomUUID()}`,
        alertSource: 'prometheus',
        service: 'checkout',
        severity: 'sev2',
        title,
      })
    ).id;
  const current = await make('Recurrence');
  const prior = await make('Prior episode');
  await recordIncidentRelation(app.db, tenantId, {
    sourceIncidentId: current,
    targetIncidentId: prior,
    type: 'recurrence_of',
    rationale: 'Same monitor.',
    evidence: [],
    decidedBy: 'system',
  });
  const run = (
    minute: number,
    values: Partial<typeof investigationRuns.$inferInsert>,
  ): typeof investigationRuns.$inferInsert => ({
    tenantId,
    incidentId: prior,
    operation: 'investigate',
    startedAt: new Date(Date.UTC(2026, 7, 26, 1, minute)),
    completedAt: new Date(Date.UTC(2026, 7, 26, 1, minute, 30)),
    ...values,
  });
  const priorLatestRun = async () =>
    (await listIncidentRelations(app.db, tenantId, current))[0]!.targetIncident.latestRun;
  return { run, priorLatestRun };
}

test('a recurrence reads the prior investigation, not its later recovery check or superseded run', async () => {
  const { run, priorLatestRun } = await recurrence();
  await admin.db.insert(investigationRuns).values([
    run(0, { outcome: 'conclusive', result: { summary: 'older', nextStep: 'older step' } }),
    run(1, { outcome: 'inconclusive', result: { summary: 'latest', nextStep: 'latest step' } }),
    run(2, {
      operation: 'verify-recovery',
      outcome: 'conclusive',
      result: { summary: 'Alert cleared.', nextStep: 'None.' },
    }),
    run(3, { outcome: 'failed', result: { reason: 'superseded_pending_run' } }),
  ]);

  expect(await priorLatestRun()).toEqual({
    outcome: 'inconclusive',
    summary: 'latest',
    nextStep: 'latest step',
  });
});

test('a failed run without a reason key is the latest run', async () => {
  const { run, priorLatestRun } = await recurrence();
  await admin.db
    .insert(investigationRuns)
    .values([
      run(0, { outcome: 'inconclusive', result: { summary: 'earlier', nextStep: 'earlier step' } }),
      run(1, { outcome: 'failed', result: { summary: 'Engine execution failed.' } }),
    ]);

  expect(await priorLatestRun()).toEqual({
    outcome: 'failed',
    summary: 'Engine execution failed.',
    nextStep: null,
  });
});

test('an incident with no completed run has no latest run', async () => {
  const { run, priorLatestRun } = await recurrence();
  await admin.db.insert(investigationRuns).values(run(0, { completedAt: null }));

  expect(await priorLatestRun()).toBeNull();
});
