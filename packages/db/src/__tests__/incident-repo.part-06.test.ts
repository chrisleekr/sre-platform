import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  applySignalObservation,
  approvals,
  createApproval,
  createIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
  setInvestigationStatus,
  transitionIncidentTx,
  withTenant,
} from '../index';
import * as incidentRepo from '../incident-repo';
import { createFixture } from './incident-repo.fixture';
const __fixture = createFixture();
describe('incident archival guards', () => {
  test('idle archive lookup returns old terminal incidents and never active work', async () => {
    const { id: activeId } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `idle-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    const { id: resolvedId } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `resolved-idle-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'worker',
      severity: 'sev3',
    });
    const { id: closedId } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `closed-idle-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'closed-worker',
      severity: 'sev3',
    });
    const { id: archivedId } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `archived-idle-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'archived-worker',
      severity: 'sev3',
    });
    const { id: recentMessageId } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `recent-message-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'recent-worker',
      severity: 'sev3',
    });
    const { id: boundaryId } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `boundary-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'boundary-worker',
      severity: 'sev3',
    });
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, resolvedId, 'resolved');
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, closedId, 'closed');
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, archivedId, 'resolved');
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, recentMessageId, 'resolved');
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, boundaryId, 'resolved');
    await __fixture.admin.db
      .update(incidents)
      .set({ updatedAt: new Date('2026-08-20T00:00:00.000Z') })
      .where(
        inArray(incidents.id, [
          activeId,
          resolvedId,
          closedId,
          archivedId,
          recentMessageId,
          boundaryId,
        ]),
      );
    await __fixture.admin.db
      .update(incidents)
      .set({ archivedAt: new Date('2026-08-20T12:00:00.000Z') })
      .where(eq(incidents.id, archivedId));
    await __fixture.admin.db
      .update(incidents)
      .set({ updatedAt: new Date('2026-08-21T00:00:00.000Z') })
      .where(eq(incidents.id, boundaryId));
    await __fixture.admin.db.insert(incidentMessages).values({
      tenantId: __fixture.tenantA,
      incidentId: recentMessageId,
      author: 'human',
      kind: 'reply',
      content: 'Recent follow-up',
      createdAt: new Date('2026-08-21T00:00:01.000Z'),
    });

    const candidates = await incidentRepo.listIdleTerminalIncidentCandidates(
      __fixture.app.db,
      __fixture.tenantA,
      new Date('2026-08-21T00:00:00.000Z'),
    );

    expect(candidates).toEqual(
      expect.arrayContaining([
        { id: resolvedId, lifecycleVersion: 1 },
        { id: closedId, lifecycleVersion: 1 },
      ]),
    );
    expect(candidates).toHaveLength(2);
  });

  test('deletion is irreversible and refuses active work, firing signals, or pending approvals', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `archive-guard-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'archive-guard',
      severity: 'sev3',
    });
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        incidentRepo.setIncidentArchivedTx(tx, id, true, { expectedVersion: 0 }),
      ),
    ).toMatchObject({ outcome: 'active' });

    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, id, 'resolved');
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantA, id, 'gathering');
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        incidentRepo.setIncidentArchivedTx(tx, id, true, { expectedVersion: 1 }),
      ),
    ).toMatchObject({ outcome: 'work_in_progress' });
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantA, id, 'assessed');
    const queuedJob = await __fixture.admin.db
      .insert(jobs)
      .values({
        tenantId: __fixture.tenantA,
        type: 'resume',
        payload: { incidentId: id, humanMessageId: randomUUID() },
        status: 'queued',
        stream: `archive-test-${randomUUID()}`,
      })
      .returning({ id: jobs.id });
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        incidentRepo.setIncidentArchivedTx(tx, id, true, { expectedVersion: 1 }),
      ),
    ).toMatchObject({ outcome: 'work_in_progress' });
    await __fixture.admin.db
      .update(jobs)
      .set({ status: 'done' })
      .where(eq(jobs.id, queuedJob[0]!.id));
    await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-archive',
      externalMessageId: `archive-${randomUUID()}`,
      state: 'firing',
      summary: 'Still firing',
      contentHash: randomUUID(),
      eventKey: `archive-${randomUUID()}`,
      eventAt: new Date(),
    });
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        incidentRepo.setIncidentArchivedTx(tx, id, true, { expectedVersion: 1 }),
      ),
    ).toMatchObject({ outcome: 'active_signals' });
    await __fixture.admin.db
      .update(incidentSignals)
      .set({ state: 'resolved', resolvedAt: new Date() })
      .where(eq(incidentSignals.incidentId, id));

    const approval = await createApproval(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      actionId: `archive-approval-${randomUUID()}`,
      prompt: 'Approve cleanup?',
      options: [{ id: 'approve', label: 'Approve' }],
    });
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        incidentRepo.setIncidentArchivedTx(tx, id, true, { expectedVersion: 1 }),
      ),
    ).toMatchObject({ outcome: 'pending_approvals' });
    await __fixture.admin.db
      .update(approvals)
      .set({ decision: 'approve', decidedAt: new Date() })
      .where(eq(approvals.id, approval.row.id));

    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        incidentRepo.setIncidentArchivedTx(tx, id, true, { expectedVersion: 1 }),
      ),
    ).toMatchObject({ outcome: 'applied', archivedAt: expect.any(Date) });
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        transitionIncidentTx(tx, id, 'open'),
      ),
    ).toMatchObject({ outcome: 'archived' });
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        incidentRepo.setIncidentArchivedTx(tx, id, false, { expectedVersion: 1 }),
      ),
    ).toMatchObject({ outcome: 'noop', archivedAt: expect.any(Date) });
  });
});
