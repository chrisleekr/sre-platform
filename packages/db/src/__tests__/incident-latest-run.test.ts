import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  beginInvestigationRun,
  completeInvestigationRun,
  createIncident,
  getIncidentDetail,
  incidents,
  investigationRuns,
  makeDb,
  tenants,
  type DbHandle,
} from '..';
import { inArray } from 'drizzle-orm';

let admin: DbHandle;
let app: DbHandle;
const tenantIds: string[] = [];

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(investigationRuns).where(inArray(investigationRuns.tenantId, tenantIds));
    await admin.db.delete(incidents).where(inArray(incidents.tenantId, tenantIds));
    await admin.db.delete(tenants).where(inArray(tenants.id, tenantIds));
    await admin.close();
  }
  if (app) await app.close();
});

async function incidentWithTenant() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Latest run projection' });
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: `latest-run-${randomUUID()}`,
    alertSource: 'alertmanager',
    service: 'checkout',
    severity: 'sev3',
  });
  return { tenantId, incidentId: incident!.id };
}

async function failedRun(tenantId: string, incidentId: string, result: Record<string, unknown>) {
  const id = await beginInvestigationRun(app.db, tenantId, incidentId, {
    operation: 'investigate',
  });
  await completeInvestigationRun(app.db, tenantId, incidentId, {
    id,
    provider: 'fake',
    engineModel: 'fake',
    engineSessionId: null,
    turnBudget: 0,
    outcome: 'failed',
    result,
    evidenceIds: [],
  });
  return id;
}

test('a failed run without a reason key is the latest run and needs attention', async () => {
  const { tenantId, incidentId } = await incidentWithTenant();
  // Engine failures persist only a summary; this is the shape that used to vanish.
  const runId = await failedRun(tenantId, incidentId, { summary: 'Engine execution failed.' });

  const detail = await getIncidentDetail(app.db, tenantId, incidentId);

  expect(detail?.latestInvestigationRun).toMatchObject({ id: runId, outcome: 'failed' });
  expect(detail?.attentionReason).toBe('investigation_failed');
});

test('a run superseded by its successor stays hidden behind the earlier run', async () => {
  const { tenantId, incidentId } = await incidentWithTenant();
  const earlier = await failedRun(tenantId, incidentId, { summary: 'Engine execution failed.' });
  await failedRun(tenantId, incidentId, { reason: 'superseded_pending_run' });

  const detail = await getIncidentDetail(app.db, tenantId, incidentId);

  expect(detail?.latestInvestigationRun).toMatchObject({ id: earlier });
});
