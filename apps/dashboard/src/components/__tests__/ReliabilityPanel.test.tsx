// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));
vi.mock('../../config', () => ({ config: { apiBaseUrl: 'http://api.test' } }));

const report = (service: string, nextCursor: string | null) => ({
  period: {
    kind: 'week',
    current: { start: '2026-08-31T00:00:00.000Z', end: '2026-09-07T00:00:00.000Z' },
    previous: { start: '2026-08-24T00:00:00.000Z', end: '2026-08-31T00:00:00.000Z' },
    comparison: {
      current: {
        start: '2026-08-31T00:00:00.000Z',
        end: '2026-09-02T00:00:00.000Z',
      },
      previous: {
        start: '2026-08-24T00:00:00.000Z',
        end: '2026-08-26T00:00:00.000Z',
      },
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
    current: {
      incidentCount: 1,
      alertCount: 1,
      alertsPerIncident: {
        value: 1,
        numerator: 1,
        denominator: 1,
        alertDefinition: 'terminal classified signal records',
        incidentDefinition: 'incidents opened in the UTC period',
      },
    },
    previous: {
      incidentCount: 0,
      alertCount: 0,
      alertsPerIncident: {
        value: null,
        numerator: 0,
        denominator: 0,
        alertDefinition: 'terminal classified signal records',
        incidentDefinition: 'incidents opened in the UTC period',
      },
    },
    ticketFlow: {
      current: {
        ticketCount: 0,
        promotedCount: 0,
        promotionRate: null,
        averagePromotionAgeSeconds: null,
        averageOpenAgeSeconds: null,
      },
      previous: {
        ticketCount: 0,
        promotedCount: 0,
        promotionRate: null,
        averagePromotionAgeSeconds: null,
        averageOpenAgeSeconds: null,
      },
      definitions: { promotionRate: 'promotion definition', age: 'age definition' },
    },
    byService: [
      {
        service,
        currentIncidents: 1,
        previousIncidents: 0,
        currentAlerts: 1,
        previousAlerts: 0,
        currentAlertsPerIncident: 1,
        previousAlertsPerIncident: null,
      },
    ],
    byServiceNextCursor: nextCursor,
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
});

vi.mock('../../lib/useFetchResource', () => ({
  useFetchResource: ({ path }: { path: string }) => ({
    data: path.includes('serviceAfter=checkout')
      ? report('payments', null)
      : report('checkout', 'checkout'),
    loading: false,
    error: false,
  }),
}));

import { ReliabilityPanel } from '../ReliabilityPanel';

describe('ReliabilityPanel', () => {
  test('connects every period tab to the active reliability panel', () => {
    render(
      <MemoryRouter>
        <ReliabilityPanel />
      </MemoryRouter>,
    );

    const panel = screen.getByRole('tabpanel', { name: 'Week' });
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    }
  });

  test('appends the next stable service page', async () => {
    render(
      <MemoryRouter>
        <ReliabilityPanel />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('row', { name: /checkout 1 0/i })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Load more services' }));
    expect(await screen.findByRole('row', { name: /payments 1 0/i })).toBeDefined();
    expect(screen.getByRole('row', { name: /checkout 1 0/i })).toBeDefined();
  });
});
