// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPanel } from '../DashboardPanel';

const hooks = vi.hoisted(() => ({
  useIncidents: vi.fn(),
  useInfrastructure: vi.fn(),
  useDeployments: vi.fn(),
  useChanges: vi.fn(),
  useConnectors: vi.fn(),
}));

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));
vi.mock('../../lib/useIncidents', () => ({ useIncidents: hooks.useIncidents }));
vi.mock('../../lib/useInfrastructure', () => ({ useInfrastructure: hooks.useInfrastructure }));
vi.mock('../../lib/useDeployments', () => ({ useDeployments: hooks.useDeployments }));
vi.mock('../../lib/useChanges', () => ({ useChanges: hooks.useChanges }));
vi.mock('../../lib/useConnectors', () => ({ useConnectors: hooks.useConnectors }));

const statusBase = {
  asOf: '2026-09-02T12:00:00.000Z',
  startedAt: null,
  qualifyingActiveCount: 0,
  scope: { severities: ['sev1', 'sev2'] },
  lastIncident: null,
};

function setIncidentFreeStatus(status: Record<string, unknown>) {
  hooks.useIncidents.mockReturnValue({
    incidents: [],
    counts: { all: 0, open: 0, needsHuman: 0, automation: 0, closed: 1 },
    nextCursor: null,
    loading: false,
    error: false,
    backgroundError: false,
    incidentFreeStatus: { ...statusBase, ...status },
  });
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPanel />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  hooks.useInfrastructure.mockReturnValue({
    snapshots: [],
    loading: false,
    error: false,
    backgroundError: false,
  });
  hooks.useDeployments.mockReturnValue({
    deployments: [],
    summary: { total: 0, failed: 0, active: 0, environmentMissing: 0, latestAt: null },
    nextCursor: null,
    loading: false,
    error: false,
    refetch: vi.fn(),
  });
  hooks.useChanges.mockReturnValue({
    changes: [],
    nextCursor: null,
    summary: { total: 0, failing: 0, succeeded: 0, latestAt: null },
    sources: [],
    loading: false,
    error: false,
    refetch: vi.fn(),
  });
  hooks.useConnectors.mockReturnValue({
    connectors: [],
    loading: false,
    error: false,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DashboardPanel incident-free status', () => {
  test('C5/C7 renders a stable accessible second timer and ticks only its child', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T15:00:00.000Z'));
    setIncidentFreeStatus({
      state: 'running',
      startedAt: '2026-09-02T11:59:50.000Z',
      lastIncident: { id: 'resolved-1', title: 'Checkout recovered', severity: 'sev2' },
    });

    renderDashboard();
    const timer = screen.getByRole('timer');
    const rail = screen.getByRole('group', { name: 'Incident-free status' });
    expect(timer.textContent).toBe('0d 00:00:10');
    expect(timer.getAttribute('aria-label')).toMatch(/No SEV1\/SEV2 incidents for 10 seconds/i);
    expect(timer.getAttribute('aria-live')).toBeNull();
    expect(timer.className).toMatch(/tabular-nums/);
    expect(timer.className).toMatch(/whitespace-nowrap/);
    expect(rail.className).toMatch(/min-w-0/);
    expect(rail.className).toMatch(/flex-wrap/);
    expect(screen.getByText(/Covers SEV1 and SEV2 incidents/i)).toBeDefined();
    expect(hooks.useIncidents).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1_000));
    expect(timer.textContent).toBe('0d 00:00:11');
    expect(hooks.useIncidents).toHaveBeenCalledTimes(1);
  });

  test('C6 suspends while hidden and recalculates from server-authoritative time on resume', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T15:00:00.000Z'));
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    setIncidentFreeStatus({
      state: 'running',
      startedAt: '2026-09-02T11:59:50.000Z',
    });

    renderDashboard();
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toBe('0d 00:00:10');

    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => vi.advanceTimersByTime(5_000));
    expect(timer.textContent).toBe('0d 00:00:10');

    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(timer.textContent).toBe('0d 00:00:15');
  });

  test('C2/C3/C4/C10 distinguishes paused, never-observed, and unavailable without a false timer', () => {
    setIncidentFreeStatus({ state: 'paused', qualifyingActiveCount: 2 });
    const paused = renderDashboard();
    expect(screen.getByText(/Incident-free streak paused/i)).toBeDefined();
    expect(screen.getByText(/2 active SEV1\/SEV2 incidents/i)).toBeDefined();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryByText(/No SEV1\/SEV2 incidents for/i)).toBeNull();
    paused.unmount();

    setIncidentFreeStatus({ state: 'never_observed' });
    const neverObserved = renderDashboard();
    expect(screen.getByText(/No SEV1\/SEV2 incident has been recorded/i)).toBeDefined();
    expect(screen.queryByRole('timer')).toBeNull();
    neverObserved.unmount();

    setIncidentFreeStatus({ state: 'unavailable' });
    renderDashboard();
    expect(screen.getByText(/Incident-free time unavailable/i)).toBeDefined();
    expect(screen.queryByRole('timer')).toBeNull();
  });
});
