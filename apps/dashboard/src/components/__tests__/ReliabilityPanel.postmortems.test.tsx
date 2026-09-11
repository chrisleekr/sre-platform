// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));
vi.mock('../../config', () => ({ config: { apiBaseUrl: 'http://api.test' } }));

import { ReliabilityPanel } from '../ReliabilityPanel';

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

// with no graded assessments the calibration section says so instead of showing a number
// with no measurement behind it. Minimal DTOs; the section reads only `verdict` on this path.
const postmortems = { items: [], nextCursor: null };
const calibration = { verdict: 'insufficient_data', gradedRuns: 0, buckets: [] };

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ReliabilityPanel postmortem sections', () => {
  test('renders the RCA calibration section with the insufficient-data verdict', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/reliability/rca-calibration')) return response(calibration);
      if (url.includes('/reliability/postmortems')) return response(postmortems);
      if (url.includes('/reliability?period=week')) return response(report);
      return response({ error: 'not found' }, 404);
    });

    render(
      <MemoryRouter>
        <ReliabilityPanel />
      </MemoryRouter>,
    );

    // RED now: the panel has no calibration section, so the region query times out.
    const section = await screen.findByRole('region', { name: 'RCA calibration' });
    expect(section.textContent).toContain('Not enough graded assessments');
  });
});
