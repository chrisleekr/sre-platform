import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { expect, onTestFinished, test } from 'vitest';
import {
  applySignalObservation,
  approvals,
  connectorConfigs,
  createApproval,
  createIncident,
  getIncident,
  incidentSignals,
  jobs,
} from '@sre/db';
import { applyApprovalDecision } from '../approval-decision';
import { createFixture } from './incidents.fixture';

const fixture = createFixture();

test('a connector write during an approval commits the decision and queues provider recovery', async () => {
  const dataSourceId = randomUUID();
  // Fixture cleanup deletes connectors before signals, so drop the referencing signal first.
  onTestFinished(async () => {
    await fixture.admin.db
      .delete(incidentSignals)
      .where(eq(incidentSignals.dataSourceId, dataSourceId));
  });
  await fixture.admin.db.insert(connectorConfigs).values({
    id: dataSourceId,
    tenantId: fixture.tenantC,
    type: 'statuscake',
    name: `approval-lock-${dataSourceId}`,
    settings: {},
    enabled: true,
  });
  const incident = await createIncident(fixture.app.db, fixture.tenantC, {
    fingerprint: `approval-lock-${randomUUID()}`,
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
    resolutionPolicy: 'provider_clear',
  });
  await applySignalObservation(fixture.app.db, fixture.tenantC, {
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
    channel: 'C_APPROVAL_LOCK',
    externalMessageId: randomUUID(),
    state: 'resolved',
    clearProvenance: 'provider',
    eventKey: randomUUID(),
    eventAt: new Date(),
    summary: 'Monitor recovered',
    contentHash: randomUUID(),
  });
  const approval = await createApproval(fixture.app.db, fixture.tenantC, {
    incidentId: incident.id,
    actionId: randomUUID(),
    prompt: 'Apply change?',
    options: [{ id: 'approve', label: 'Approve' }],
  });

  // A connector write (health, poll cursor, outcome) holds this row lock while the responder decides.
  const outcome = await fixture.admin.db.transaction(async (holder) => {
    await holder.execute(
      sql`select id from connector_configs where id = ${dataSourceId} for no key update`,
    );
    return applyApprovalDecision(
      {
        adminDb: fixture.admin.db,
        appDb: fixture.app.db,
        hub: fixture.hub,
        queue: fixture.declarationQueue,
      },
      {
        tenantId: fixture.tenantC,
        approvalId: approval.row.id,
        optionId: 'approve',
        decidedBy: 'lock-responder',
        originSurface: 'dashboard',
      },
    );
  });

  expect(outcome).toEqual({ status: 'decided', label: 'Approve' });
  const decided = await fixture.admin.db
    .select({ decision: approvals.decision })
    .from(approvals)
    .where(eq(approvals.id, approval.row.id));
  expect(decided[0]?.decision).toBe('approve');
  const recovery = await fixture.admin.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, fixture.tenantC),
        eq(jobs.type, 'recovery.verify'),
        sql`${jobs.payload}->>'incidentId' = ${incident.id}`,
      ),
    );
  expect(recovery).toHaveLength(1);
  expect((await getIncident(fixture.app.db, fixture.tenantC, incident.id))?.status).toBe('open');
});
