// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IncidentsList } from '../IncidentsList';
import type { Incident } from '../../lib/types';

const incident: Incident = {
  id: 'abc',
  service: 'checkout',
  severity: 'sev2',
  status: 'mitigated',
  investigationStatus: 'gathering',
  lifecycleVersion: 1,
  alertSource: 'datadog',
  rcaSummary: null,
  confidence: null,
  createdAt: 't',
};

describe('IncidentsList', () => {
  afterEach(() => vi.useRealTimers());

  test('renders a row that links to the incident conversation', () => {
    render(
      <MemoryRouter>
        <IncidentsList incidents={[incident]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('checkout')).toBeDefined();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/w/incidents/abc');
  });

  test('renders the incident title so the inbox identifies the actual alert', () => {
    render(
      <MemoryRouter>
        <IncidentsList incidents={[{ ...incident, title: 'System saturated on homelab node' }]} />
      </MemoryRouter>,
    );

    expect(screen.getByText('System saturated on homelab node')).toBeDefined();
  });

  test('separates operational lifecycle from investigation progress', () => {
    render(
      <MemoryRouter>
        <IncidentsList
          incidents={[
            {
              ...incident,
              status: 'mitigated',
              investigationStatus: 'assessed',
              rcaSummary: 'The liveness probe triggered the restart.',
            },
          ]}
        />
      </MemoryRouter>,
    );

    const row = screen.getByRole('link');
    expect(within(row).getByText('Mitigated')).toBeDefined();
    expect(within(row).getByText('Assessment ready')).toBeDefined();
  });

  test('shows an empty state', () => {
    render(
      <MemoryRouter>
        <IncidentsList incidents={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No incidents.')).toBeDefined();
  });

  test('explains what an empty incident list means to an operator (C2)', () => {
    render(
      <MemoryRouter>
        <IncidentsList incidents={[]} />
      </MemoryRouter>,
    );

    expect(screen.getByText('No incidents.')).toBeDefined();
    expect(screen.getByText(/create an incident.*automatic detection/i)).toBeDefined();
  });

  // Channel provenance stays readable on each priority-ordered incident. The raw Slack id means nothing
  // to an operator and is never rendered when a channel name is known.
  const withOrigin = (
    over: Partial<Incident> & { originChannel: string; originChannelName: string },
  ): Incident => ({ ...incident, ...over }) as Incident;

  test('shows readable channel provenance without letting channels split the priority queue', () => {
    const rows = [
      withOrigin({
        id: 'i1',
        service: 'checkout',
        originChannel: 'C07EWAS8132',
        originChannelName: '#homelab-notification',
      }),
      withOrigin({
        id: 'i2',
        service: 'billing',
        originChannel: 'C07EWAS8132',
        originChannelName: '#homelab-notification',
      }),
      withOrigin({
        id: 'i3',
        service: 'api',
        originChannel: 'C0999OPS',
        originChannelName: '#ops',
      }),
    ];
    render(
      <MemoryRouter>
        <IncidentsList incidents={rows} />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('#homelab-notification')).toHaveLength(2);
    expect(screen.getByText('#ops')).toBeDefined();
    expect(screen.queryByText(/C07EWAS8132/)).toBeNull();
    // Every incident still renders under its group.
    for (const s of ['checkout', 'billing', 'api']) expect(screen.getByText(s)).toBeDefined();
  });

  test('renders every operational queue field, a semantic age, and preserves input order', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const rows = [
      withOrigin({
        id: 'newer',
        service: 'checkout',
        severity: 'sev1',
        status: 'mitigated',
        investigationStatus: 'gathering',
        alertSource: 'datadog',
        originChannel: 'C258',
        originChannelName: '#checkout-alerts',
        createdAt: fiveMinutesAgo,
      }),
      withOrigin({
        id: 'older',
        service: 'billing',
        severity: 'sev3',
        status: 'closed',
        alertSource: 'prometheus',
        originChannel: 'C258',
        originChannelName: '#checkout-alerts',
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    ];
    const { container } = render(
      <MemoryRouter>
        <IncidentsList incidents={rows} />
      </MemoryRouter>,
    );

    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/w/incidents/newer',
      '/w/incidents/older',
    ]);
    const first = links[0]!;
    for (const value of ['sev1', 'checkout', 'Mitigated', 'datadog', '#checkout-alerts']) {
      expect(within(first).getByText(value)).toBeDefined();
    }
    const time = first.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(fiveMinutesAgo);
    expect(time?.textContent).toMatch(/ago|just now/i);
    expect(container.querySelectorAll('time')).toHaveLength(2);
  });

  test('distinguishes an automation-owned open incident from a human exception', () => {
    render(
      <MemoryRouter>
        <IncidentsList
          incidents={[
            {
              ...incident,
              id: 'automation',
              status: 'open',
              severity: 'sev3',
              requiresHumanAttention: false,
              attentionReason: null,
            },
            {
              ...incident,
              id: 'human',
              status: 'open',
              requiresHumanAttention: true,
              attentionReason: 'approval_pending',
            },
          ]}
        />
      </MemoryRouter>,
    );

    const [automation, human] = screen.getAllByRole('link');
    expect(within(automation!).getByText('SRE Platform handling')).toBeDefined();
    expect(within(human!).getByText('Needs human')).toBeDefined();
    expect(within(human!).getByText('Approval requested')).toBeDefined();
  });

  test('allows long queue identity and metadata to wrap in a compact row', () => {
    const service = 'checkout-edge-router-with-an-uninterrupted-operator-visible-identity';
    const { container } = render(
      <MemoryRouter>
        <IncidentsList
          incidents={[
            withOrigin({
              id: 'long',
              service,
              originChannel: 'C258LONG',
              originChannelName: '#checkout-alerts-with-a-very-long-name',
            }),
          ]}
        />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link');
    expect(link.className).toMatch(/flex-wrap|min-w-0|grid/);
    expect(screen.getByText(service).className).toMatch(/break-words|break-all/);
    expect(container.querySelector('.overflow-x-auto')).toBeNull();
  });

  test('surfaces signal clearance, the assessment, and the next diagnostic action', () => {
    render(
      <MemoryRouter>
        <IncidentsList
          incidents={[
            {
              ...incident,
              title: 'Checkout saturation',
              rcaSummary: 'The database connection pool is exhausted.',
              nextStep: 'Compare pool usage with the last deployment.',
              signalCount: 1,
              activeSignalCount: 0,
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('All signals clear')).toBeDefined();
    expect(screen.getByText('The database connection pool is exhausted.')).toBeDefined();
    expect(screen.getByText(/Compare pool usage with the last deployment/)).toBeDefined();
  });

  test('shows the latest run outcome separately without replacing the trusted assessment', () => {
    const trustedSummary = 'The database connection pool is exhausted.';
    render(
      <MemoryRouter>
        <IncidentsList
          incidents={[
            {
              ...incident,
              investigationStatus: 'assessed',
              rcaSummary: trustedSummary,
              nextStep: 'Review the trusted pool-sizing recommendation.',
              latestInvestigationRun: {
                id: '11111111-1111-4111-8111-111111111111',
                operation: 'investigate',
                outcome: 'budget_exhausted',
                triggerReason: 'new_episode',
                triggerAutomatic: true,
                triggerMonitorKey: null,
                triggerMonitorKeys: [],
                triggerBudget: null,
                completedAt: '2026-08-31T00:02:00.000Z',
              },
            } as Incident,
          ]}
        />
      </MemoryRouter>,
    );

    const row = screen.getByRole('link');
    expect(within(row).getByText(trustedSummary)).toBeDefined();
    expect(within(row).getByText('Latest investigation run')).toBeDefined();
    expect(within(row).getByText(/budget exhausted/i)).toBeDefined();
    expect(within(row).getByText(/Investigate · Budget exhausted/i)).toBeDefined();
    expect(within(row).getByText(/New alert episode/i)).toBeDefined();
    expect(within(row).getByText('Trusted assessment next step:')).toBeDefined();
    expect(within(row).getByText(/Review the trusted pool-sizing recommendation/)).toBeDefined();
    expect(within(row).queryByText('Next check:')).toBeNull();
  });

  test('does not color missing signal tracking as healthy', () => {
    render(
      <MemoryRouter>
        <IncidentsList incidents={[{ ...incident, signalCount: 0, activeSignalCount: 0 }]} />
      </MemoryRouter>,
    );

    const badge = screen.getByText('Signal tracking unavailable');
    expect(badge.className).toMatch(/text-ink-secondary/);
    expect(badge.className).not.toMatch(/bg-success/);
    expect(screen.getByRole('img', { name: /signal tracking unavailable/i })).toBeDefined();
  });

  test('presents a manual investigation as a human report without a missing-signal warning', () => {
    render(
      <MemoryRouter>
        <IncidentsList
          incidents={[
            {
              ...incident,
              alertSource: 'manual',
              status: 'open',
              investigationStatus: 'assessed',
              signalCount: 0,
              activeSignalCount: 0,
              requiresHumanAttention: true,
              attentionReason: 'manual_review',
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Human report')).toBeDefined();
    expect(screen.getByText('Review requested investigation')).toBeDefined();
    expect(screen.queryByText('Signal tracking unavailable')).toBeNull();
  });

  test('distinguishes verified and unverified recovery after provider signals clear', () => {
    render(
      <MemoryRouter>
        <IncidentsList
          incidents={[
            {
              ...incident,
              id: 'verified',
              signalCount: 1,
              activeSignalCount: 0,
              recoveryState: 'verified',
            },
            {
              ...incident,
              id: 'unverified',
              signalCount: 1,
              activeSignalCount: 0,
              recoveryState: 'not_verified',
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Recovery verified').className).toMatch(/text-success/);
    expect(screen.getByText('Recovery not verified').className).toMatch(/text-warning/);
  });

  test('shows scheduled recovery monitoring as automation-owned work', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T03:10:00.000Z'));
    render(
      <MemoryRouter>
        <IncidentsList
          incidents={[
            {
              ...incident,
              status: 'open',
              severity: 'sev3',
              investigationStatus: 'assessed',
              requiresHumanAttention: false,
              signalCount: 1,
              activeSignalCount: 0,
              recoveryState: 'monitoring',
              recoveryAttempt: 1,
              recoveryMaxChecks: 3,
              recoveryNextCheckAt: '2026-08-28T03:15:00.000Z',
              recoveryScheduleReason: 'Wait for the rollout to settle.',
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('SRE Platform handling')).toBeDefined();
    expect(screen.getByText('Monitoring recovery 1/3').className).toMatch(/text-info/);
    expect(screen.getByText('in 5m')).toBeDefined();
    expect(screen.getByText(/Wait for the rollout to settle/)).toBeDefined();
    expect(document.querySelector('time[datetime="2026-08-28T03:15:00.000Z"]')).not.toBeNull();
  });

  test('shows the exact human handoff in the queue', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    render(
      <MemoryRouter>
        <IncidentsList
          incidents={[
            {
              ...incident,
              status: 'open',
              requiresHumanAttention: true,
              attentionReason: 'investigation_blocked',
              attentionDecision: 'Connect a log source or inspect the service manually.',
              responsibleOwner: 'checkout-on-call',
              nextAutomation: null,
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Connect a log source or inspect the service manually.')).toBeDefined();
    expect(screen.getByText('checkout-on-call')).toBeDefined();
    expect(screen.getByText('No automation remains.')).toBeDefined();
  });

  test('nests downstream symptoms directly after their causal response root', () => {
    render(
      <MemoryRouter>
        <IncidentsList
          incidents={[
            { ...incident, id: 'unrelated', title: 'Unrelated alert' },
            {
              ...incident,
              id: 'symptom',
              title: 'Checkout failures',
              causalParentId: 'root',
            },
            { ...incident, id: 'root', title: 'Database saturation' },
          ]}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/w/incidents/unrelated',
      '/w/incidents/root',
      '/w/incidents/symptom',
    ]);
    expect(screen.getByText('Downstream symptom of Database saturation')).toBeDefined();
  });
});
