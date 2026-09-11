// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

const reliabilityViewModule = ['..', 'ReliabilityReportView'].join('/');

const loadReliabilityView = () => import(/* @vite-ignore */ reliabilityViewModule);

const report = {
  period: {
    kind: 'week',
    current: { start: '2026-08-31T00:00:00.000Z', end: '2026-09-07T00:00:00.000Z' },
    previous: { start: '2026-08-24T00:00:00.000Z', end: '2026-08-31T00:00:00.000Z' },
    comparison: {
      current: { start: '2026-08-31T00:00:00.000Z', end: '2026-09-02T12:00:00.000Z' },
      previous: { start: '2026-08-24T00:00:00.000Z', end: '2026-08-26T12:00:00.000Z' },
      asOf: '2026-09-02T12:00:00.000Z',
    },
  },
  outages: {
    signalCoverage: {
      retainedFrom: '2026-08-24T00:00:00.000Z',
      measurementStartedAt: '2026-08-24T00:00:00.000Z',
      currentComplete: true,
      previousComplete: true,
    },
    current: {
      incidentCount: 2,
      alertCount: 4,
      alertsPerIncident: {
        value: 2,
        numerator: 4,
        denominator: 2,
        alertDefinition: 'terminal classified signal records',
        incidentDefinition: 'incidents opened in the UTC period',
      },
    },
    previous: {
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
    ticketFlow: {
      current: {
        ticketCount: 2,
        promotedCount: 1,
        promotionRate: 0.5,
        averagePromotionAgeSeconds: 300,
        averageOpenAgeSeconds: 600,
      },
      previous: {
        ticketCount: 1,
        promotedCount: 0,
        promotionRate: 0,
        averagePromotionAgeSeconds: null,
        averageOpenAgeSeconds: 300,
      },
      definitions: {
        promotionRate: 'tickets created in the UTC period that were promoted to an incident',
        age: 'mean seconds from ticket creation to promotion, or current age while still open',
      },
    },
    byService: [
      {
        service: 'checkout',
        currentIncidents: 1,
        previousIncidents: 1,
        currentAlerts: 2,
        previousAlerts: 1,
        currentAlertsPerIncident: 2,
        previousAlertsPerIncident: 1,
      },
      {
        service: 'payments',
        currentIncidents: 1,
        previousIncidents: 0,
        currentAlerts: 2,
        previousAlerts: 0,
        currentAlertsPerIncident: 2,
        previousAlertsPerIncident: null,
      },
    ],
    byServiceNextCursor: null,
    topCauses: [{ tag: 'cause:deployment', incidentCount: 2 }],
    topCausesTruncated: false,
    topCauseCaveat:
      'Incident counts may reflect monitoring sensitivity and do not indicate severity or repair difficulty.',
  },
  toil: {
    created: {
      approvalDemands: 1,
      clarificationRequests: 1,
      degradedReasks: 1,
      findingCorrections: 1,
    },
    removed: {
      averageFirstHypothesisSeconds: 300,
      humanTurnsPerProviderIncident: { numerator: 2, denominator: 2, value: 1 },
      citedRunbookAdoption: { numerator: 1, denominator: 1, rate: 1 },
      resolvedWithoutResponderOrApprovedAction: { numerator: 1, denominator: 2, rate: 0.5 },
    },
    definitions: [
      'Responder turns and approval decisions are the disclosed human-tool-work proxy.',
      'Runbook adoption means a cited search_runbooks evidence receipt in the trusted assessment.',
    ],
  },
} as const;

describe('ReliabilityReportView', () => {
  test('shows current/prior load, explicit denominators, causes, and the caveat', async () => {
    const { ReliabilityReportView } = await loadReliabilityView();
    render(<ReliabilityReportView report={report} mode="dashboard" />);

    const incidents = screen.getByRole('group', { name: 'Incidents opened' });
    expect(within(incidents).getByText('2')).toBeDefined();
    expect(within(incidents).getByText(/previous: 1/i)).toBeDefined();
    const signals = screen.getByRole('group', { name: 'Classified signals' });
    expect(within(signals).getByText('4')).toBeDefined();
    expect(within(signals).getByText(/terminal classified signal records/i)).toBeDefined();
    const concentration = screen.getByRole('group', { name: 'Signals per incident' });
    expect(within(concentration).getByText('2.00')).toBeDefined();
    expect(within(concentration).getByText(/previous: 1.00/i)).toBeDefined();

    const load = screen.getByRole('region', { name: 'Outage load' });
    expect(screen.getByText('cause:deployment')).toBeDefined();
    expect(screen.getByText(/monitoring sensitivity/i)).toBeDefined();
    expect(screen.getByText(/do not indicate severity or repair difficulty/i)).toBeDefined();
    const serviceTable = within(load).getByRole('table', { name: 'Reliability by service' });
    expect(serviceTable.parentElement?.className).toContain('overflow-x-auto');

    const ticketFlow = screen.getByRole('region', { name: 'Ticket flow' });
    expect(within(ticketFlow).getByText(/1 of 2 promoted/i)).toBeDefined();
    expect(within(ticketFlow).getByText(/tickets created in the UTC period/i)).toBeDefined();
    const promotionAge = within(ticketFlow).getByRole('group', { name: 'Mean time to promotion' });
    expect(within(promotionAge).getByText('5 min')).toBeDefined();
    expect(within(promotionAge).getByText(/previous: no data/i)).toBeDefined();
    const openAge = within(ticketFlow).getByRole('group', { name: 'Mean age while unpromoted' });
    expect(within(openAge).getByText('10 min')).toBeDefined();
    expect(within(openAge).getByText(/previous: 5 min/i)).toBeDefined();
  });

  test('shows toil created and removed together with disclosed proxy definitions', async () => {
    const { ReliabilityReportView } = await loadReliabilityView();
    render(<ReliabilityReportView report={report} mode="dashboard" />);

    const toil = screen.getByRole('region', { name: 'Human toil' });
    expect(within(toil).getByRole('heading', { name: 'Toil created' })).toBeDefined();
    expect(
      within(within(toil).getByRole('group', { name: 'Approval demands' })).getByText('1'),
    ).toBeDefined();
    expect(
      within(within(toil).getByRole('group', { name: 'Clarification requests' })).getByText('1'),
    ).toBeDefined();
    expect(within(toil).getByRole('heading', { name: 'Toil removed' })).toBeDefined();
    expect(
      within(within(toil).getByRole('group', { name: 'Time to first hypothesis' })).getByText(
        '5 min',
      ),
    ).toBeDefined();
    expect(
      within(
        within(toil).getByRole('group', { name: 'Resolved without responder or approved action' }),
      ).getByText('50%'),
    ).toBeDefined();
    const responderTurns = within(toil).getByRole('group', { name: 'Responder turns' });
    expect(within(responderTurns).getByText('2')).toBeDefined();
    expect(within(responderTurns).getByText(/across 2 provider incidents/i)).toBeDefined();
    expect(
      within(within(toil).getByRole('group', { name: 'Cited runbook adoption' })).getByText('100%'),
    ).toBeDefined();
    expect(within(toil).getByText(/human-tool-work proxy/i)).toBeDefined();
    expect(within(toil).getByText(/cited search_runbooks evidence receipt/i)).toBeDefined();
  });

  test('renders weekly mode from the exact same reliability DTO', async () => {
    const { ReliabilityReportView } = await loadReliabilityView();
    render(<ReliabilityReportView report={report} mode="weekly" />);

    expect(screen.getByRole('region', { name: 'Weekly reliability report data' })).toBeDefined();
    expect(screen.getByText('cause:deployment')).toBeDefined();
    expect(screen.getByRole('region', { name: 'Outage load' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Human toil' })).toBeDefined();
  });

  test('renders unavailable ratios instead of false zeroes', async () => {
    const { ReliabilityReportView } = await loadReliabilityView();
    const emptyDenominators = structuredClone(report) as unknown as typeof report;
    (emptyDenominators.outages.current.alertsPerIncident as { value: number | null }).value = null;
    (emptyDenominators.toil.removed.citedRunbookAdoption as { rate: number | null }).rate = null;
    render(<ReliabilityReportView report={emptyDenominators} mode="dashboard" />);
    expect(
      within(screen.getByRole('group', { name: 'Signals per incident' })).getByText('N/A'),
    ).toBeDefined();
    expect(
      within(screen.getByRole('group', { name: 'Cited runbook adoption' })).getByText('N/A'),
    ).toBeDefined();
  });

  test('explains incomplete coverage and empty service and cause data', async () => {
    const { ReliabilityReportView } = await loadReliabilityView();
    const sparseReport = {
      ...report,
      outages: {
        ...report.outages,
        signalCoverage: { ...report.outages.signalCoverage, currentComplete: false },
        byService: [],
        topCauses: [],
      },
    } as const;

    render(<ReliabilityReportView report={sparseReport} mode="dashboard" />);

    expect(screen.getByText(/signal ratios have incomplete coverage/i)).toBeDefined();
    expect(screen.getByText(/retained signal history begins/i)).toBeDefined();
    expect(screen.getByText('No service activity in this period.')).toBeDefined();
    expect(screen.getByText('No accepted cause tags in this period.')).toBeDefined();
  });
});
