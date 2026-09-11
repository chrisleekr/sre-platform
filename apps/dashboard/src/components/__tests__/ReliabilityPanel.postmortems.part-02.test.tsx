// @vitest-environment jsdom
import type { PostmortemReport, RcaCalibrationReport } from '@sre/contracts';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));
vi.mock('../../config', () => ({ config: { apiBaseUrl: 'http://api.test' } }));

import { ReliabilityPanel } from '../ReliabilityPanel';

const INCIDENT_ID = '11111111-1111-4111-8111-111111111111';
const POSTMORTEM_ID = '22222222-2222-4222-8222-222222222222';

// The comparison report the panel already fetches; same shape as ReliabilityPanel.test.tsx.
const alertsPerIncident = (value: number | null, n: number) => ({
  value,
  numerator: n,
  denominator: n,
  alertDefinition: 'terminal classified signal records',
  incidentDefinition: 'incidents opened in the UTC period',
});
const ticketFlow = {
  ticketCount: 0,
  promotedCount: 0,
  promotionRate: null,
  averagePromotionAgeSeconds: null,
  averageOpenAgeSeconds: null,
};
const report = {
  period: {
    kind: 'week',
    current: { start: '2026-08-31T00:00:00.000Z', end: '2026-09-07T00:00:00.000Z' },
    previous: { start: '2026-08-24T00:00:00.000Z', end: '2026-08-31T00:00:00.000Z' },
    comparison: {
      current: { start: '2026-08-31T00:00:00.000Z', end: '2026-09-02T00:00:00.000Z' },
      previous: { start: '2026-08-24T00:00:00.000Z', end: '2026-08-26T00:00:00.000Z' },
      asOf: '2026-09-02T00:00:00.000Z',
    },
  },
  outages: {
    signalCoverage: {
      retainedFrom: '2026-08-01T00:00:00.000Z',
      measurementStartedAt: '2026-08-01T00:00:00.000Z',
      currentComplete: true,
      previousComplete: true,
    },
    current: { incidentCount: 1, alertCount: 1, alertsPerIncident: alertsPerIncident(1, 1) },
    previous: { incidentCount: 0, alertCount: 0, alertsPerIncident: alertsPerIncident(null, 0) },
    ticketFlow: {
      current: ticketFlow,
      previous: ticketFlow,
      definitions: { promotionRate: 'promotion definition', age: 'age definition' },
    },
    byService: [],
    byServiceNextCursor: null,
    topCauses: [],
    topCausesTruncated: false,
    topCauseCaveat: 'Counts reflect monitoring sensitivity.',
  },
  toil: {
    created: {
      approvalDemands: 0,
      clarificationRequests: 0,
      degradedReasks: 0,
      findingCorrections: 0,
    },
    removed: {
      averageFirstHypothesisSeconds: null,
      humanTurnsPerProviderIncident: { numerator: 0, denominator: 1, value: 0 },
      citedRunbookAdoption: { numerator: 0, denominator: 0, rate: 0 },
      resolvedWithoutResponderOrApprovedAction: { numerator: 0, denominator: 1, rate: 0 },
    },
    definitions: [],
  },
};

// Typed against the wire contract so a renamed field fails here, not in production.
const postmortems: PostmortemReport = {
  asOf: '2026-09-02T00:00:00.000Z',
  postmortems: { draft: 1, published: 2 },
  actionItems: {
    open: 3,
    openByAge: [
      { label: 'under_7_days', lowerDays: 0, upperDays: 7, open: 2 },
      { label: '7_to_30_days', lowerDays: 7, upperDays: 30, open: 0 },
      { label: 'over_30_days', lowerDays: 30, upperDays: null, open: 1 },
    ],
    untracked: 1,
    pastDue: 1,
  },
  postmortemsWithPastDueItems: [
    { incidentId: INCIDENT_ID, postmortemId: POSTMORTEM_ID, pastDue: 1 },
  ],
  definitions: [],
};

const calibration: RcaCalibrationReport = {
  floor: 10,
  coverage: { assessmentsWithConfidence: 30, graded: 24, gradedRate: 0.8 },
  overall: { graded: 24, correct: 15, partial: 3, incorrect: 6, accuracy: 0.75 },
  byConfidenceBucket: [
    { lower: 80, upper: 101, graded: 12, observedAccuracy: 0.75, claimedMean: 88.5 },
  ],
  runbookAdoption: { cited: { graded: 10, accuracy: 0.9 }, uncited: { graded: 14, accuracy: 0.5 } },
  judgeAgreement: { bothGraded: 8, agreed: 6, rate: 0.75 },
  verdict: 'informative',
  definitions: [],
};

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function renderPanel() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/reliability/rca-calibration')) return response(calibration);
    if (url.includes('/reliability/postmortems')) return response(postmortems);
    if (url.includes('/reliability?period=week')) return response(report);
    return response({ error: 'not found' }, 404);
  });
  return render(
    <MemoryRouter>
      <ReliabilityPanel />
    </MemoryRouter>,
  );
}

const rowTexts = (table: HTMLElement): string[][] =>
  within(table)
    .getAllByRole('row')
    .map((row) =>
      within(row)
        .queryAllByRole('cell')
        .map((cell) => cell.textContent ?? ''),
    );

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ReliabilityPanel postmortem sections (populated reports)', () => {
  test('renders untracked and past-due action items with the age table and a postmortem link', async () => {
    renderPanel();
    const section = await screen.findByRole('region', { name: 'Postmortem action items' });
    expect(section.textContent).toContain('1 draft · 2 published · 3 open action items');
    expect(section.textContent).toContain(
      '1 open action item is untracked (no owner or no tracker link).',
    );
    const table = within(section).getByRole('table', { name: 'Open action items by age' });
    expect(rowTexts(table)).toEqual([[], ['0–7 days', '2'], ['7–30 days', '0'], ['30+ days', '1']]);
    expect(section.textContent).toContain('1 past due');
    const link = within(section).getByRole('link', {
      name: `Postmortem ${POSTMORTEM_ID.slice(0, 8)}`,
    });
    expect(link.getAttribute('href')).toBe(`/w/incidents/${INCIDENT_ID}/postmortem`);
    expect(link.parentElement?.textContent).toContain('· 1 past due');
  });

  test('renders the informative calibration verdict with its confidence bucket row', async () => {
    renderPanel();
    const section = await screen.findByRole('region', { name: 'RCA calibration' });
    expect(section.textContent).toContain(
      'Claimed confidence is informative: higher claims are more often right. Overall accuracy 75% over 24 graded.',
    );
    const table = within(section).getByRole('table', { name: 'Accuracy by claimed confidence' });
    expect(rowTexts(table)).toEqual([[], ['80–100', '12', '75%', '88.5']]);
    expect(section.textContent).toContain(
      'Runbook cited: 90% accuracy over 10 graded · uncited: 50% over 14 graded.',
    );
    expect(section.textContent).toContain(
      'Judge agreement: 75% of 8 assessments graded by both a responder and the model.',
    );
    expect(section.textContent).not.toContain('Not enough graded assessments');
  });
});
