import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { expect, test } from 'vitest';
import {
  applySignalObservation,
  createApproval,
  createIncident,
  getIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  recordIncidentRelation,
} from '@sre/db';
import { applyApprovalDecision } from '../approval-decision';
import { createFixture } from './incidents.fixture';

const fixture = createFixture();

async function decide(approvalId: string) {
  return applyApprovalDecision(
    {
      adminDb: fixture.admin.db,
      appDb: fixture.app.db,
      hub: fixture.hub,
      queue: fixture.declarationQueue,
    },
    {
      tenantId: fixture.tenantC,
      approvalId,
      optionId: 'approve',
      decidedBy: 'causal-responder',
      originSurface: 'dashboard',
    },
  );
}

test('the last approval across a causal response group resolves its root and symptoms', async () => {
  const root = await createIncident(fixture.app.db, fixture.tenantC, {
    fingerprint: `approval-root-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'database',
    severity: 'sev2',
  });
  const child = await createIncident(fixture.app.db, fixture.tenantC, {
    fingerprint: `approval-child-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'checkout',
    severity: 'sev2',
  });
  await recordIncidentRelation(fixture.app.db, fixture.tenantC, {
    sourceIncidentId: child.id,
    targetIncidentId: root.id,
    type: 'caused_by',
    rationale: 'Checkout is a verified symptom of database saturation.',
    evidence: ['responder:causal-approval'],
    decidedBy: 'human',
    decidedByUserId: randomUUID(),
  });
  await fixture.admin.db
    .update(incidents)
    .set({ recoveryState: 'verified' })
    .where(eq(incidents.id, root.id));
  await fixture.admin.db.insert(incidentSignals).values(
    [root.id, child.id].map((incidentId) => ({
      tenantId: fixture.tenantC,
      incidentId,
      surface: 'alertmanager',
      channel: 'causal-approval',
      externalMessageId: `resolved-${incidentId}`,
      state: 'resolved' as const,
      lastEventType: 'resolved' as const,
      summary: 'Recovered',
      contentHash: randomUUID(),
      lastEventKey: `resolved:${incidentId}`,
      lastEventAt: new Date(),
      resolvedAt: new Date(),
    })),
  );
  const rootApproval = (
    await createApproval(fixture.app.db, fixture.tenantC, {
      incidentId: root.id,
      actionId: `root-${randomUUID()}`,
      prompt: 'Approve root follow-up?',
      options: [{ id: 'approve', label: 'Approve' }],
    })
  ).row.id;
  const childApproval = (
    await createApproval(fixture.app.db, fixture.tenantC, {
      incidentId: child.id,
      actionId: `child-${randomUUID()}`,
      prompt: 'Approve child follow-up?',
      options: [{ id: 'approve', label: 'Approve' }],
    })
  ).row.id;

  await decide(rootApproval);
  expect(await getIncident(fixture.app.db, fixture.tenantC, root.id)).toMatchObject({
    status: 'open',
  });
  await decide(childApproval);

  expect(await getIncident(fixture.app.db, fixture.tenantC, root.id)).toMatchObject({
    status: 'resolved',
  });
  expect(await getIncident(fixture.app.db, fixture.tenantC, child.id)).toMatchObject({
    status: 'resolved',
  });
  const lifecycle = await fixture.admin.db
    .select({ incidentId: incidentMessages.incidentId })
    .from(incidentMessages)
    .where(inArray(incidentMessages.incidentId, [root.id, child.id]));
  expect(lifecycle.filter((message) => [root.id, child.id].includes(message.incidentId))).toEqual(
    expect.arrayContaining([{ incidentId: root.id }, { incidentId: child.id }]),
  );
});

test('a child refire invalidates root verification before an approval can resolve the group', async () => {
  const root = await createIncident(fixture.app.db, fixture.tenantC, {
    fingerprint: `approval-refire-root-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'database',
    severity: 'sev2',
  });
  const child = await createIncident(fixture.app.db, fixture.tenantC, {
    fingerprint: `approval-refire-child-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'checkout',
    severity: 'sev2',
  });
  await recordIncidentRelation(fixture.app.db, fixture.tenantC, {
    sourceIncidentId: child.id,
    targetIncidentId: root.id,
    type: 'caused_by',
    rationale: 'Checkout is a symptom of database saturation.',
    evidence: ['responder:causal-refire'],
    decidedBy: 'human',
    decidedByUserId: randomUUID(),
  });
  await fixture.admin.db
    .update(incidents)
    .set({ recoveryState: 'verified' })
    .where(eq(incidents.id, root.id));
  const externalMessageId = `refire-${randomUUID()}`;
  await fixture.admin.db.insert(incidentSignals).values([
    {
      tenantId: fixture.tenantC,
      incidentId: root.id,
      surface: 'alertmanager',
      channel: 'causal-refire',
      externalMessageId: `root-${externalMessageId}`,
      state: 'resolved',
      lastEventType: 'resolved',
      summary: 'Root recovered',
      contentHash: randomUUID(),
      lastEventKey: `root-resolved:${externalMessageId}`,
      lastEventAt: new Date(),
      resolvedAt: new Date(),
    },
    {
      tenantId: fixture.tenantC,
      incidentId: child.id,
      surface: 'alertmanager',
      channel: 'causal-refire',
      externalMessageId,
      state: 'resolved',
      lastEventType: 'resolved',
      summary: 'Child recovered',
      contentHash: randomUUID(),
      lastEventKey: `child-resolved:${externalMessageId}`,
      lastEventAt: new Date(),
      resolvedAt: new Date(),
    },
  ]);
  const approvalId = (
    await createApproval(fixture.app.db, fixture.tenantC, {
      incidentId: child.id,
      actionId: `refire-${randomUUID()}`,
      prompt: 'Approve follow-up?',
      options: [{ id: 'approve', label: 'Approve' }],
    })
  ).row.id;

  await applySignalObservation(fixture.app.db, fixture.tenantC, {
    incidentId: child.id,
    surface: 'alertmanager',
    channel: 'causal-refire',
    externalMessageId,
    state: 'firing',
    summary: 'Child refired',
    contentHash: randomUUID(),
    eventKey: `child-refired:${externalMessageId}`,
    eventAt: new Date(Date.now() + 1_000),
  });
  expect(await getIncident(fixture.app.db, fixture.tenantC, root.id)).toMatchObject({
    recoveryState: null,
  });
  await applySignalObservation(fixture.app.db, fixture.tenantC, {
    incidentId: child.id,
    surface: 'alertmanager',
    channel: 'causal-refire',
    externalMessageId,
    state: 'resolved',
    summary: 'Child recovered again',
    contentHash: randomUUID(),
    eventKey: `child-reresolved:${externalMessageId}`,
    eventAt: new Date(Date.now() + 2_000),
  });
  await decide(approvalId);

  expect(await getIncident(fixture.app.db, fixture.tenantC, root.id)).toMatchObject({
    status: 'open',
    recoveryState: null,
  });
  expect(await getIncident(fixture.app.db, fixture.tenantC, child.id)).toMatchObject({
    status: 'open',
  });
});
