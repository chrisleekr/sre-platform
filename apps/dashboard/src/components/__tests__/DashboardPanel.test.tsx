// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Incident } from '../../lib/types';
import { DashboardPanel } from '../DashboardPanel';

const hooks = vi.hoisted(() => ({
  useIncidents: vi.fn(),
  useInfrastructure: vi.fn(),
  useDeployments: vi.fn(),
  useChanges: vi.fn(),
  useConnectors: vi.fn(),
  useMe: vi.fn(),
}));

vi.mock('../../auth', () => ({
  useSession: () => ({
    status: 'authenticated',
    sessionKey: 'session-a',
    getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }),
  }),
}));
vi.mock('../../lib/me-store', () => ({ useMe: hooks.useMe }));
vi.mock('../../lib/useIncidents', () => ({ useIncidents: hooks.useIncidents }));
vi.mock('../../lib/useInfrastructure', () => ({ useInfrastructure: hooks.useInfrastructure }));
vi.mock('../../lib/useDeployments', () => ({ useDeployments: hooks.useDeployments }));
vi.mock('../../lib/useChanges', () => ({ useChanges: hooks.useChanges }));
vi.mock('../../lib/useConnectors', () => ({ useConnectors: hooks.useConnectors }));

const now = new Date().toISOString();
const unavailableIncidentFreeStatus = {
  state: 'unavailable',
  asOf: null,
  startedAt: null,
  qualifyingActiveCount: 0,
  scope: { severities: ['sev1', 'sev2'] },
  lastIncident: null,
};
const incident = (over: Partial<Incident> = {}): Incident => ({
  id: 'incident-1',
  service: 'checkout',
  severity: 'sev2',
  status: 'open',
  investigationStatus: 'degraded',
  lifecycleVersion: 0,
  alertSource: 'prometheus',
  title: 'Checkout latency is elevated',
  rcaSummary: 'Database connection saturation is the leading hypothesis.',
  confidence: 0.72,
  signalCount: 1,
  activeSignalCount: 1,
  pendingApprovalCount: 0,
  requiresHumanAttention: true,
  attentionReason: 'investigation_degraded',
  createdAt: now,
  updatedAt: now,
  ...over,
});

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPanel />
    </MemoryRouter>,
  );
}

test('uses opening context instead of transport-only incident labels', () => {
  hooks.useIncidents.mockReturnValue({
    ...hooks.useIncidents(),
    incidents: [
      incident({
        title: '<@U12345678>',
        displayTitle: 'Check checkout latency',
        titleSource: 'opening_request',
      }),
    ],
  });
  const view = renderDashboard();
  expect(view.getAllByText(/Check checkout latency/).length).toBeGreaterThan(0);
  expect(view.container.textContent).not.toContain('<@U12345678>');
});

test('health checks count as response work without counting as active incidents', () => {
  hooks.useIncidents.mockReturnValue({
    ...hooks.useIncidents(),
    incidents: [incident({ purpose: 'health_check' })],
    counts: { open: 1, needsHuman: 1, automation: 0 },
    operationalCounts: { open: 0, needsHuman: 0, automation: 0 },
  });
  renderDashboard();
  expect(
    screen.getByLabelText('No active incidents. 1 evidence blind spots. 1 need human attention'),
  ).toBeTruthy();
  expect(screen.queryByText('No active response ownership')).toBeNull();
});

beforeEach(() => {
  hooks.useMe.mockReturnValue({
    data: {
      welcome: { shown: true, dismissed: true },
      domain: null,
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  hooks.useIncidents.mockReturnValue({
    incidents: [
      incident(),
      incident({
        id: 'incident-2',
        service: 'search',
        title: 'Search recovered but is unverified',
        status: 'mitigated',
        investigationStatus: 'assessed',
        activeSignalCount: 0,
        recoveryState: 'not_verified',
        attentionReason: 'recovery_not_verified',
      }),
    ],
    counts: { open: 2, needsHuman: 2, automation: 0, closed: 4 },
    nextCursor: null,
    incidentFreeStatus: unavailableIncidentFreeStatus,
    loading: false,
    error: false,
    backgroundError: false,
  });
  hooks.useInfrastructure.mockReturnValue({
    snapshots: [
      {
        dataSourceId: 'kubernetes-1',
        dataSourceName: 'Homelab cluster',
        source: 'kubernetes',
        entityId: 'checkout-api-123',
        namespace: 'checkout',
        kind: 'pod',
        phase: 'Running',
        metrics: { ready: 0 },
        observedAt: now,
      },
    ],
    loading: false,
    error: false,
    backgroundError: false,
  });
  hooks.useDeployments.mockReturnValue({
    deployments: [
      {
        dataSourceId: 'argocd-1',
        dataSourceName: 'Production Argo CD',
        source: 'argocd',
        providerId: 'deploy-1',
        service: 'checkout',
        repo: 'platform/checkout',
        ref: 'main',
        transientEnvironment: false,
        sha: 'abc123',
        status: 'failed',
        deployedAt: now,
      },
    ],
    summary: { total: 1, failed: 1, active: 0, environmentMissing: 0, latestAt: now },
    nextCursor: null,
    loading: false,
    error: false,
    refetch: vi.fn(),
  });
  hooks.useChanges.mockReturnValue({
    changes: [],
    nextCursor: null,
    summary: { total: 3, failing: 2, succeeded: 1, latestAt: now },
    sources: [],
    loading: false,
    error: false,
    refetch: vi.fn(),
  });
  hooks.useConnectors.mockReturnValue({
    connectors: [
      {
        id: 'github-1',
        name: 'GitHub production',
        type: 'github',
        settings: {},
        enabled: false,
      },
    ],
    loading: false,
    error: false,
    refetch: vi.fn(),
  });
});

describe('DashboardPanel', () => {
  test('keeps an incomplete welcome checklist on the workspace home after its first presentation', () => {
    hooks.useMe.mockReturnValue({
      data: {
        welcome: {
          workspaceCreated: true,
          domainVerified: false,
          observabilityConnected: true,
          slackConnected: false,
          shown: false,
          dismissed: false,
        },
        domain: { id: 'domain-1' },
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    renderDashboard();

    expect(screen.getByRole('heading', { name: /finish setting up/i })).toBeDefined();
    expect(
      screen
        .getAllByRole('link', { name: /verify domain/i })
        .some((link) => link.getAttribute('href') === '/w/settings/domains/domain-1'),
    ).toBe(true);
  });

  test('uses one live announcement and geometry-matched skeletons while feeds first load', () => {
    hooks.useIncidents.mockReturnValue({
      incidents: [],
      counts: null,
      nextCursor: null,
      incidentFreeStatus: unavailableIncidentFreeStatus,
      loading: true,
      error: false,
      backgroundError: false,
    });
    hooks.useInfrastructure.mockReturnValue({
      snapshots: [],
      loading: true,
      error: false,
      backgroundError: false,
    });
    hooks.useDeployments.mockReturnValue({
      deployments: [],
      summary: null,
      nextCursor: null,
      loading: true,
      error: false,
      refetch: vi.fn(),
    });
    hooks.useChanges.mockReturnValue({
      changes: [],
      nextCursor: null,
      summary: { total: 0, failing: 0, succeeded: 0, latestAt: null },
      sources: [],
      loading: true,
      error: false,
      refetch: vi.fn(),
    });
    hooks.useConnectors.mockReturnValue({
      connectors: [],
      loading: true,
      error: false,
      refetch: vi.fn(),
    });

    const { container } = renderDashboard();

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading operational dashboard/i);
    expect(container.querySelectorAll('.sre-skeleton').length).toBeGreaterThan(20);
    expect(screen.queryByText('—')).toBeNull();
  });

  test('shows action-oriented incident, infrastructure, change, and coverage evidence', () => {
    renderDashboard();

    expect(screen.getByRole('heading', { name: 'Operational dashboard' })).toBeDefined();
    expect(screen.getByText('Checkout latency is elevated')).toBeDefined();
    expect(screen.getByText('Investigation needs human help')).toBeDefined();
    expect(screen.getByText('Human decisions')).toBeDefined();
    expect(screen.getByText('Automation')).toBeDefined();
    expect(screen.getByText('checkout-api-123')).toBeDefined();
    expect(screen.getByText('Needs attention')).toBeDefined();
    expect(screen.getByRole('list', { name: 'Changes near active incidents' })).toBeDefined();
    expect(screen.getByText(/2 failing CI events/)).toBeDefined();
    expect(screen.getByText('GitHub production')).toBeDefined();
    expect(screen.getByText('Disabled')).toBeDefined();

    const queue = screen.getByRole('list', { name: 'Highest-priority active incidents' });
    expect(
      within(queue)
        .getByRole('link', { name: /Checkout latency is elevated/ })
        .getAttribute('href'),
    ).toBe('/w/incidents/incident-1');
    expect(screen.getByRole('link', { name: 'Open incident queue' }).getAttribute('href')).toBe(
      '/w/incidents',
    );
  });

  test('treats an empty connector inventory as a diagnostic blind spot', () => {
    hooks.useConnectors.mockReturnValue({
      connectors: [],
      loading: false,
      error: false,
      refetch: vi.fn(),
    });

    renderDashboard();

    expect(screen.getByRole('img', { name: /No evidence sources configured/i })).toBeDefined();
    expect(screen.getByText('Not configured')).toBeDefined();
    expect(screen.queryByText('Evidence sources healthy')).toBeNull();
  });

  test('keeps independent failures visible without reporting false all-clear states', () => {
    hooks.useIncidents.mockReturnValue({
      incidents: [],
      counts: null,
      nextCursor: null,
      incidentFreeStatus: unavailableIncidentFreeStatus,
      loading: false,
      error: true,
      backgroundError: false,
    });
    hooks.useInfrastructure.mockReturnValue({
      snapshots: [],
      loading: false,
      error: true,
      backgroundError: false,
    });
    hooks.useDeployments.mockReturnValue({
      deployments: [],
      summary: { total: 0, failed: 0, active: 0, environmentMissing: 0, latestAt: null },
      nextCursor: null,
      loading: false,
      error: true,
      refetch: vi.fn(),
    });
    hooks.useChanges.mockReturnValue({
      changes: [],
      nextCursor: null,
      summary: { total: 0, failing: 0, succeeded: 0, latestAt: null },
      sources: [],
      loading: false,
      error: true,
      refetch: vi.fn(),
    });
    hooks.useConnectors.mockReturnValue({
      connectors: [],
      loading: false,
      error: true,
      refetch: vi.fn(),
    });

    renderDashboard();

    for (const message of [
      'The active incident queue is unavailable.',
      'Infrastructure evidence is unavailable.',
      'Some recent change evidence is unavailable.',
      'Connector health is unavailable.',
    ]) {
      expect(screen.getByText(message)).toBeDefined();
    }
    expect(screen.queryByText('No active incidents.')).toBeNull();
    expect(screen.queryByText('No current infrastructure exceptions.')).toBeNull();
    expect(screen.queryByText('No connector blind spots are currently reported.')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(
      screen.getByRole('img', {
        name: /Incident summary unavailable\. Evidence source status unavailable\. Response ownership unavailable/i,
      }),
    ).toBeDefined();
  });
});
