import { describe, expect, test } from 'vitest';
import { createActionItem, saveGeneratedPostmortem } from '@sre/db';
import type { PostmortemReport, RcaCalibrationReport } from '@sre/contracts';
import { createFixture } from './incidents.fixture';

// reliability read models over HTTP. Both are per-tenant reads; the fixture tenants are
// fresh per file, so the counts below are exact.
const __fixture = createFixture();

async function get<T>(path: string): Promise<T> {
  const res = await __fixture.api.request(
    path,
    __fixture.auth(await __fixture.sign(__fixture.orgC)),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe('GET /reliability/postmortems', () => {
  test('counts drafts and open action items, flagging untracked ones as defects', async () => {
    await saveGeneratedPostmortem(
      __fixture.app.db,
      __fixture.tenantC,
      __fixture.postmortemIncidentId,
      {
        trigger: 'monitoring_failure',
        assessmentRunId: __fixture.postmortemRunId,
        requestedByUserId: null,
        summary: 'Checkout degraded.',
        impact: 'Payments failed.',
        contributingCauses: [{ cause: 'No pool alert.', evidenceIds: [] }],
        triggerNarrative: 'Traffic spike.',
        resolution: 'Pool raised.',
        detection: 'Customer reports.',
        lessons: { wentWell: [], wentWrong: ['No pool alert'], lucky: [] },
        timeline: [],
        supportingInformation: null,
        actionItems: [{ type: 'prevent', title: 'Add a pool saturation alert' }],
      },
    );
    await createActionItem(__fixture.app.db, __fixture.tenantC, __fixture.postmortemIncidentId, {
      type: 'process',
      title: 'Tracked and overdue',
      owner: 'payments-team',
      trackerUrl: 'https://tracker.example.com/9',
      dueAt: new Date('2026-01-01T00:00:00Z'),
    });
    const report = await get<PostmortemReport>('/reliability/postmortems');
    expect(report.postmortems).toEqual({ draft: 1, published: 0 });
    expect(report.actionItems).toMatchObject({ open: 2, untracked: 1, pastDue: 1 });
    expect(report.actionItems.openByAge.map((b) => b.label)).toEqual([
      'under_7_days',
      '7_to_30_days',
      'over_30_days',
    ]);
    expect(report.postmortemsWithPastDueItems).toEqual([
      expect.objectContaining({ incidentId: __fixture.postmortemIncidentId, pastDue: 1 }),
    ]);
    expect(report.definitions.some((line) => line.includes('untracked'))).toBe(true);
  });
});

describe('GET /reliability/rca-calibration', () => {
  test('reports insufficient data below the floor, never a made-up accuracy', async () => {
    const report = await get<RcaCalibrationReport>('/reliability/rca-calibration');
    expect(report.floor).toBe(10);
    expect(report.verdict).toBe('insufficient_data');
    expect(report.overall).toMatchObject({ graded: 0, accuracy: null });
    // The fixture's one confident run is counted as gradable but ungraded.
    expect(report.coverage).toMatchObject({
      assessmentsWithConfidence: 1,
      graded: 0,
      gradedRate: 0,
    });
    expect(report.byConfidenceBucket.map((b) => [b.lower, b.upper])).toEqual([
      [0, 50],
      [50, 80],
      [80, 101],
    ]);
    expect(report.byConfidenceBucket.every((b) => b.observedAccuracy === null)).toBe(true);
    expect(report.judgeAgreement).toEqual({ bothGraded: 0, agreed: 0, rate: null });
  });
});
