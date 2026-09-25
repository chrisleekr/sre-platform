import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import {
  applySignalObservation,
  applyTriageResult,
  createApproval,
  createIncident,
  degradeIncidentWithMessages,
  getIncident,
  incidentSignals,
  incidents,
  jobs,
  listIncidentsPage,
  setInvestigationStatus,
  withTenant,
} from '../index';

import { startInvestigatingWithMessages } from '../incident-repo';

// active-set query + occurrence bump. Namespace access so a not-yet-exported symbol
// reads as `undefined` (a per-assertion RED: "not a function") instead of an ESM link error that
// would break the existing passing tests in this module.
import * as incidentRepo from '../incident-repo';

import { createFixture } from './incident-repo.fixture';

const __fixture = createFixture();

describe('incident lifecycle + RLS', () => {
  test('create and read an incident', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    const inc = await getIncident(__fixture.app.db, __fixture.tenantA, id);
    expect(inc?.status).toBe('open');
    expect(inc?.service).toBe('api');
  });

  test('active queue prioritizes severity and ownership and reports live signal counts', async () => {
    const sev3Open = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `queue-sev3-${randomUUID()}`,
      alertSource: 'slack',
      service: 'low-priority',
      severity: 'sev3',
    });
    const sev1Mitigated = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `queue-sev1-mitigated-${randomUUID()}`,
      alertSource: 'slack',
      service: 'owned-critical',
      severity: 'sev1',
    });
    const sev1Open = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `queue-sev1-open-${randomUUID()}`,
      alertSource: 'slack',
      service: 'unowned-critical',
      severity: 'sev1',
    });
    const sev2Older = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `queue-sev2-older-${randomUUID()}`,
      alertSource: 'slack',
      service: 'older-sev2',
      severity: 'sev2',
    });
    const sev2Recent = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `queue-sev2-recent-${randomUUID()}`,
      alertSource: 'slack',
      service: 'recent-sev2',
      severity: 'sev2',
    });
    await __fixture.admin.db.insert(jobs).values({
      tenantId: __fixture.tenantA,
      type: 'triage',
      payload: { incidentId: sev3Open.id },
      status: 'queued',
      stream: `queue-ownership-${randomUUID()}`,
    });
    await __fixture.setLifecycle(
      __fixture.app.db,
      __fixture.tenantA,
      sev1Mitigated.id,
      'mitigated',
    );
    await withTenant(__fixture.app.db, __fixture.tenantA, async (tx) => {
      await tx
        .update(incidents)
        .set({ updatedAt: new Date('2026-08-23T00:00:00.000Z') })
        .where(eq(incidents.id, sev2Older.id));
      await tx
        .update(incidents)
        .set({ updatedAt: new Date('2026-08-23T01:00:00.000Z') })
        .where(eq(incidents.id, sev2Recent.id));
    });

    await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: sev1Open.id,
      surface: 'slack',
      channel: 'C-alerts',
      externalMessageId: `firing-${randomUUID()}`,
      state: 'firing',
      summary: 'Critical service is firing',
      contentHash: randomUUID(),
      eventKey: `event-${randomUUID()}`,
      eventAt: new Date(),
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: sev3Open.id,
      surface: 'slack',
      channel: 'C-alerts',
      externalMessageId: `sev3-firing-${randomUUID()}`,
      state: 'firing',
      summary: 'Low-risk service alert is firing',
      contentHash: randomUUID(),
      eventKey: `event-${randomUUID()}`,
      eventAt: new Date(),
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: sev1Open.id,
      surface: 'slack',
      channel: 'C-alerts',
      externalMessageId: `resolved-${randomUUID()}`,
      state: 'resolved',
      summary: 'A second alert has resolved',
      contentHash: randomUUID(),
      eventKey: `event-${randomUUID()}`,
      eventAt: new Date(),
    });

    const rows = await listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
      scope: 'open',
      limit: 1_000,
    });
    const ids = new Set([sev1Open.id, sev1Mitigated.id, sev2Older.id, sev2Recent.id, sev3Open.id]);
    const queue = rows.incidents.filter((row) => ids.has(row.id));

    expect(queue.map((row) => row.id)).toEqual([
      sev1Open.id,
      sev1Mitigated.id,
      sev2Recent.id,
      sev2Older.id,
      sev3Open.id,
    ]);
    expect(queue[0]).toMatchObject({ signalCount: 2, activeSignalCount: 1 });
    expect(queue.at(-1)).toMatchObject({
      id: sev3Open.id,
      requiresHumanAttention: false,
      attentionReason: null,
      pendingApprovalCount: 0,
    });

    const humanLane = await listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
      scope: 'open',
      attention: 'human',
      limit: 1_000,
    });
    const automationLane = await listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
      scope: 'open',
      attention: 'automation',
      limit: 1_000,
    });
    expect(humanLane.incidents.filter((row) => ids.has(row.id)).map((row) => row.id)).toEqual([
      sev1Open.id,
      sev1Mitigated.id,
      sev2Recent.id,
      sev2Older.id,
    ]);
    expect(automationLane.incidents.filter((row) => ids.has(row.id)).map((row) => row.id)).toEqual([
      sev3Open.id,
    ]);

    await __fixture.admin.db
      .update(incidents)
      .set({ recoveryState: 'verified' })
      .where(eq(incidents.id, sev3Open.id));
    const stalledResolution = await listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
      scope: 'open',
      attention: 'human',
      limit: 1_000,
    });
    expect(stalledResolution.incidents.find((row) => row.id === sev3Open.id)).toMatchObject({
      requiresHumanAttention: true,
      attentionReason: 'resolution_required',
    });
    await __fixture.admin.db
      .update(incidents)
      .set({ recoveryState: null })
      .where(eq(incidents.id, sev3Open.id));

    await createApproval(__fixture.app.db, __fixture.tenantA, {
      incidentId: sev3Open.id,
      actionId: `queue-approval-${randomUUID()}`,
      prompt: 'Restart the low-risk service?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'deny', label: 'Deny' },
      ],
    });
    const afterApproval = await listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
      scope: 'open',
      attention: 'human',
      limit: 1_000,
    });
    expect(afterApproval.incidents.find((row) => row.id === sev3Open.id)).toMatchObject({
      pendingApprovalCount: 1,
      requiresHumanAttention: true,
      attentionReason: 'approval_pending',
    });
  });

  test('keeps a manual sev3 investigation in automation until its assessment needs review', async () => {
    const manual = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `manual-${randomUUID()}`,
      alertSource: 'manual',
      service: 'checkout-api',
      severity: 'sev3',
    });

    await __fixture.admin.db.insert(jobs).values({
      tenantId: __fixture.tenantA,
      type: 'triage',
      payload: { incidentId: manual.id },
      status: 'queued',
      stream: `manual-ownership-${randomUUID()}`,
    });
    const queued = await listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
      scope: 'open',
      attention: 'automation',
      limit: 1_000,
    });
    expect(queued.incidents.find((row) => row.id === manual.id)).toMatchObject({
      signalCount: 0,
      requiresHumanAttention: false,
      attentionReason: null,
    });

    await __fixture.admin.db
      .update(incidents)
      .set({ investigationStatus: 'assessed' })
      .where(eq(incidents.id, manual.id));
    const assessed = await listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
      scope: 'open',
      attention: 'human',
      limit: 1_000,
    });
    expect(assessed.incidents.find((row) => row.id === manual.id)).toMatchObject({
      signalCount: 0,
      requiresHumanAttention: true,
      attentionReason: 'manual_review',
    });
  });

  test('an explicit override archives only a closed incident with an active signal', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `archive-closed-active-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'archive-closed-active',
      severity: 'sev3',
    });
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, id, 'resolved');
    await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-archive',
      externalMessageId: `archive-closed-active-${randomUUID()}`,
      state: 'firing',
      summary: 'Provider signal remains active',
      contentHash: randomUUID(),
      eventKey: `archive-closed-active-${randomUUID()}`,
      eventAt: new Date(),
    });

    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        incidentRepo.setIncidentArchivedTx(tx, id, true, {
          expectedVersion: 1,
          allowActiveSignalsForClosed: true,
        }),
      ),
    ).toMatchObject({ outcome: 'active_signals' });

    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, id, 'closed');
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        incidentRepo.setIncidentArchivedTx(tx, id, true, { expectedVersion: 2 }),
      ),
    ).toMatchObject({ outcome: 'active_signals' });
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        incidentRepo.setIncidentArchivedTx(tx, id, true, {
          expectedVersion: 2,
          allowActiveSignalsForClosed: true,
        }),
      ),
    ).toMatchObject({ outcome: 'applied', archivedAt: expect.any(Date) });
    expect(
      await __fixture.admin.db
        .select({ state: incidentSignals.state })
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, id)),
    ).toEqual([{ state: 'firing' }]);
  });

  test('status transition to resolved stamps resolvedAt', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'prometheus',
      service: 'db',
      severity: 'sev1',
    });
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantA, id, 'gathering');
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, id))?.investigationStatus).toBe(
      'gathering',
    );
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, id, 'resolved');
    const inc = await getIncident(__fixture.app.db, __fixture.tenantA, id);
    expect(inc?.status).toBe('resolved');
    expect(inc?.resolvedAt).not.toBeNull();
  });

  test('startInvestigatingWithMessages transitions queued->gathering exactly once', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    // Wins on the first attempt (status is 'open'): transitions and returns the inserted opener rows.
    expect(
      await startInvestigatingWithMessages(__fixture.app.db, __fixture.tenantA, id, [
        { author: 'system', kind: 'text', content: 'Triage started.' },
      ]),
    ).toHaveLength(1);
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, id))?.investigationStatus).toBe(
      'gathering',
    );
    // A redelivery loses the CAS (status is no longer 'open'), so "Triage started" posts once.
    expect(
      await startInvestigatingWithMessages(__fixture.app.db, __fixture.tenantA, id, [
        { author: 'system', kind: 'text', content: 'Triage started.' },
      ]),
    ).toBeNull();
  });

  test('degradeIncidentWithMessages atomically degrades + posts once, then applyTriageResult clears it', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    await setInvestigationStatus(__fixture.app.db, __fixture.tenantA, id, 'gathering');
    // First degrade wins the CAS: status flips and both messages are inserted in one transaction.
    const rows = await degradeIncidentWithMessages(__fixture.app.db, __fixture.tenantA, id, [
      { author: 'system', kind: 'finding', content: 'evidence brief' },
      { author: 'system', kind: 'text', content: 'escalation' },
    ]);
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows![0]!.id).toBeTruthy();
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, id))?.investigationStatus).toBe(
      'degraded',
    );
    // A redelivery during the same outage loses the CAS: null, and no duplicate messages inserted.
    expect(
      await degradeIncidentWithMessages(__fixture.app.db, __fixture.tenantA, id, [
        { author: 'system', kind: 'finding', content: 'dupe brief' },
      ]),
    ).toBeNull();
    // A successful assessment clears degraded progress without changing the lifecycle.
    await applyTriageResult(__fixture.app.db, __fixture.tenantA, id, {
      provider: 'claude',
      sessionId: 'claude:x',
      summary: 'root cause found',
      confidence: 80,
    });
    expect(await getIncident(__fixture.app.db, __fixture.tenantA, id)).toMatchObject({
      status: 'open',
      investigationStatus: 'assessed',
    });
  });

  test('degradeIncidentWithMessages refuses to reopen a resolved incident', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'api',
      severity: 'sev2',
    });
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, id, 'resolved');
    // Terminal lifecycle refuses new degraded work and inserts nothing.
    expect(
      await degradeIncidentWithMessages(__fixture.app.db, __fixture.tenantA, id, [
        { author: 'system', kind: 'finding', content: 'late brief' },
      ]),
    ).toBeNull();
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, id))?.status).toBe('resolved');
  });
});

describe('recorded responder ownership', () => {
  test.each([
    ['idle', null, null, null, true],
    ['queued', 'queued', null, null, false],
    ['processing', 'processing', null, null, false],
    ['completed job', 'done', null, null, true],
    ['scheduled monitor', null, 'monitoring', new Date('2026-09-21T00:00:00Z'), false],
    ['unscheduled monitor', null, 'monitoring', null, true],
    ['stale verification status', null, 'verifying', null, true],
  ] as const)(
    'list, detail and counts agree for %s',
    async (_name, jobStatus, recoveryState, recoveryNextCheckAt, needsHuman) => {
      const before = await incidentRepo.countIncidentsByScope(__fixture.app.db, __fixture.tenantA);
      const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `ownership-${randomUUID()}`,
        alertSource: 'manual',
        service: 'checkout-api',
        severity: 'sev3',
      });
      await __fixture.admin.db
        .update(incidents)
        .set({ recoveryState, recoveryNextCheckAt })
        .where(eq(incidents.id, id));
      if (jobStatus)
        await __fixture.admin.db.insert(jobs).values({
          tenantId: __fixture.tenantA,
          type: 'triage',
          payload: { incidentId: id },
          status: jobStatus,
          stream: `ownership-${randomUUID()}`,
        });
      const detail = await incidentRepo.getIncidentDetail(__fixture.app.db, __fixture.tenantA, id);
      const page = await listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
        scope: 'open',
        limit: 1_000,
      });
      expect(detail?.requiresHumanAttention).toBe(needsHuman);
      expect(page.incidents.find((row) => row.id === id)?.requiresHumanAttention).toBe(needsHuman);
      const lane = await listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
        scope: 'open',
        attention: needsHuman ? 'human' : 'automation',
        limit: 1_000,
      });
      expect(lane.incidents.some((row) => row.id === id)).toBe(true);
      const after = await incidentRepo.countIncidentsByScope(__fixture.app.db, __fixture.tenantA);
      expect(after.needsHuman - before.needsHuman).toBe(needsHuman ? 1 : 0);
      expect(after.automation - before.automation).toBe(needsHuman ? 0 : 1);
    },
  );

  test('terminal incidents do not need a human solely because work ended', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `terminal-idle-${randomUUID()}`,
      alertSource: 'manual',
      service: 'checkout-api',
      severity: 'sev3',
    });
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, id, 'closed');
    expect(
      (await incidentRepo.getIncidentDetail(__fixture.app.db, __fixture.tenantA, id))
        ?.requiresHumanAttention,
    ).toBe(false);
  });

  const decisionGaps = [
    {
      question: 'Must capacity survive losing one node?',
      category: 'operator_decision',
      evidenceKind: null,
      attemptedEvidenceIds: [],
    },
  ] as const;
  const assessedAt = new Date('2026-09-20T00:00:00Z');
  const recoveredAt = new Date('2026-09-20T01:00:00Z');

  test.each([
    ['current decision', decisionGaps, assessedAt, null, null, 'incident', true],
    ['superseded decision', decisionGaps, assessedAt, recoveredAt, 'monitoring', 'incident', false],
    [
      'health-check decision',
      decisionGaps,
      assessedAt,
      recoveredAt,
      'monitoring',
      'health_check',
      true,
    ],
    [
      'blank question',
      [{ ...decisionGaps[0], question: '  ' }],
      assessedAt,
      null,
      null,
      'incident',
      false,
    ],
    [
      'legacy text',
      ['Must capacity survive losing one node?'],
      assessedAt,
      null,
      null,
      'incident',
      false,
    ],
    ['no gaps', null, assessedAt, null, null, 'incident', false],
    ['equal timestamps', decisionGaps, assessedAt, assessedAt, 'monitoring', 'incident', false],
    ['older recovery', decisionGaps, recoveredAt, assessedAt, 'monitoring', 'incident', true],
    ['undated assessment', decisionGaps, null, recoveredAt, 'monitoring', 'incident', false],
    ['undated recovery', decisionGaps, assessedAt, null, 'monitoring', 'incident', true],
    ['both undated', decisionGaps, null, null, 'monitoring', 'incident', false],
    [
      'recovery timestamp without state',
      decisionGaps,
      assessedAt,
      recoveredAt,
      null,
      'incident',
      true,
    ],
    [
      'equal health-check timestamps',
      decisionGaps,
      assessedAt,
      assessedAt,
      'monitoring',
      'health_check',
      true,
    ],
    ['undated health check', decisionGaps, null, null, 'monitoring', 'health_check', true],
  ] as const)(
    '%s controls human attention without inferring legacy intent',
    async (
      _name,
      unknowns,
      assessmentUpdatedAt,
      recoveryUpdatedAt,
      recoveryState,
      purpose,
      expected,
    ) => {
      const { id } = await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `decision-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout-api',
        severity: 'sev3',
      });
      await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
        incidentId: id,
        surface: 'slack',
        channel: 'C_DECISIONS',
        externalMessageId: randomUUID(),
        state: 'firing',
        summary: 'Capacity warning',
        contentHash: randomUUID(),
        eventKey: randomUUID(),
        eventAt: new Date(),
      });
      await __fixture.admin.db
        .update(incidents)
        .set({
          purpose,
          unknowns: unknowns as never,
          assessmentUpdatedAt,
          recoveryUpdatedAt,
          recoveryState,
          recoveryNextCheckAt: recoveryUpdatedAt ? new Date('2026-09-21T00:00:00Z') : null,
        })
        .where(eq(incidents.id, id));
      await __fixture.admin.db.insert(jobs).values({
        tenantId: __fixture.tenantA,
        type: 'triage',
        payload: { incidentId: id },
        status: 'processing',
        stream: `decision-${randomUUID()}`,
      });
      const detail = await incidentRepo.getIncidentDetail(__fixture.app.db, __fixture.tenantA, id);
      const page = await listIncidentsPage(__fixture.app.db, __fixture.tenantA, {
        scope: 'open',
        limit: 1_000,
      });
      expect(detail?.requiresHumanAttention).toBe(expected);
      expect(page.incidents.find((row) => row.id === id)?.requiresHumanAttention).toBe(expected);
      const question = expected ? decisionGaps[0].question : null;
      expect(detail?.operatorDecision).toBe(question);
      expect(page.incidents.find((row) => row.id === id)?.operatorDecision).toBe(question);
      if (expected) {
        expect(detail).toMatchObject({
          attentionReason: 'operator_decision',
          operatorDecision: 'Must capacity survive losing one node?',
        });
      }
    },
  );
});
