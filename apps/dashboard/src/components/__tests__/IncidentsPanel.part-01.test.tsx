// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { MemoryRouter } from 'react-router-dom';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Incident } from '../../lib/types';

// The terminal split follows lifecycle, independent of investigation progress.
import { IncidentsPanel, partitionIncidentQueue } from '../IncidentsPanel';

// The shared auth boundary is a hard dependency of the panel; stub it so the hook wiring doesn't run.
vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));

function mk(id: string, status: string, service: string): Incident {
  return {
    id,
    service,
    severity: 'sev2',
    status,
    investigationStatus: status === 'open' ? 'queued' : 'assessed',
    lifecycleVersion: 0,
    alertSource: 'datadog',
    rcaSummary: null,
    confidence: null,
    createdAt: 't',
    requiresHumanAttention: !['resolved', 'closed'].includes(status),
    attentionReason: !['resolved', 'closed'].includes(status) ? 'severity_requires_human' : null,
  };
}

const openThread = mk('o1', 'open', 'checkout');

const investigatingThread = mk('i1', 'mitigated', 'payments');

const degradedThread = {
  ...mk('d1', 'open', 'search'),
  investigationStatus: 'degraded' as const,
};

const resolvedThread = mk('r1', 'resolved', 'billing');

const closedThread = mk('c1', 'closed', 'gateway');

const archivedThread = {
  ...mk('x1', 'closed', 'retired-test'),
  archivedAt: '2026-08-26T00:00:00.000Z',
};

// Each test sets what the mocked hook returns before rendering.
let hookState: {
  incidents: Incident[];
  loading: boolean;
  error: boolean;
  backgroundError?: boolean;
  // true per-scope counts from the server, independent of the (paginated) incidents slice.
  counts?: {
    all?: number;
    open: number;
    needsHuman?: number;
    automation?: number;
    closed: number;
  };
};

// Swappable hook impl: defaults to returning hookState (args ignored). The Load-more test swaps in a
// cursor-aware page source; renderPanel resets it to the default so the other tests are unaffected.
let useIncidentsMock: (opts: {
  state?: 'open' | 'closed' | 'all';
  attention?: 'human' | 'automation';
  cursor?: string;
  query?: string;
  severity?: string;
  limit?: number;
  pollMs?: number;
}) => {
  incidents: Incident[];
  loading: boolean;
  error: boolean;
  backgroundError?: boolean;
  counts?: {
    all?: number;
    open: number;
    needsHuman?: number;
    automation?: number;
    closed: number;
  };
  nextCursor?: string | null;
} = () => hookState;

vi.mock('../../lib/useIncidents', () => ({
  useIncidents: (opts: {
    state?: 'open' | 'closed' | 'all';
    cursor?: string;
    query?: string;
    severity?: string;
  }) => useIncidentsMock(opts),
}));

function renderPanel(state: Partial<typeof hookState> & { incidents: Incident[] }) {
  hookState = { loading: false, error: false, backgroundError: false, ...state };
  useIncidentsMock = () => hookState;
  return render(
    <MemoryRouter>
      <IncidentsPanel />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('partitionIncidentQueue', () => {
  test('separates human exceptions, automation-owned work, and terminal history', () => {
    const automated = {
      ...mk('a1', 'open', 'automation'),
      severity: 'sev3',
      requiresHumanAttention: false,
      attentionReason: null,
    };
    const input = [openThread, resolvedThread, investigatingThread, degradedThread];
    const { needsHuman, automation, closed } = partitionIncidentQueue([...input, automated]);

    expect(needsHuman.map((incident) => incident.id)).toEqual(['o1', 'i1', 'd1']);
    expect(automation.map((incident) => incident.id)).toEqual(['a1']);
    expect(closed.map((i) => i.id)).toEqual(['r1']);
  });

  test('routes an auto-closed thread to closed too, not just resolved', () => {
    // 'closed' is terminal lifecycle history, so it must not land in either active lane.
    const { needsHuman, closed } = partitionIncidentQueue([
      openThread,
      closedThread,
      resolvedThread,
    ]);
    expect(needsHuman.map((incident) => incident.id)).toEqual(['o1']);
    expect(closed.map((i) => i.id)).toEqual(['c1', 'r1']);
  });

  test('empty input yields empty partitions', () => {
    expect(partitionIncidentQueue([])).toEqual({ needsHuman: [], automation: [], closed: [] });
  });
});

describe('IncidentsPanel handling tabs', () => {
  test('C1: Needs human is active on load and shows only human exceptions', () => {
    renderPanel({ incidents: [openThread, resolvedThread] });

    // non-resolved is visible, resolved is hidden
    expect(screen.getByText('checkout')).toBeDefined();
    expect(screen.queryByText('billing')).toBeNull();
  });

  test('C3→C2: clicking Closed shows only resolved; clicking Needs human restores', () => {
    renderPanel({ incidents: [openThread, resolvedThread] });

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(screen.getByText('billing')).toBeDefined();
    expect(screen.queryByText('checkout')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Needs human' }));
    expect(screen.getByText('checkout')).toBeDefined();
    expect(screen.queryByText('billing')).toBeNull();
  });

  test('submits trimmed search and severity filters, preserves them across tabs, and clears them', () => {
    const calls: Parameters<typeof useIncidentsMock>[0][] = [];
    hookState = {
      incidents: [openThread, resolvedThread],
      loading: false,
      error: false,
      counts: { open: 1, closed: 1 },
    };
    useIncidentsMock = (opts) => {
      calls.push(opts);
      return hookState;
    };
    render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Search incidents'), {
      target: { value: '  checkout  ' },
    });
    expect(calls.at(-1)?.query).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(calls.at(-1)?.query).toBe('checkout');

    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'sev1' } });
    expect(calls.at(-1)?.severity).toBe('sev1');
    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(calls.at(-1)).toMatchObject({ state: 'closed', query: 'checkout', severity: 'sev1' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(calls.at(-1)?.query).toBeUndefined();
    expect(calls.at(-1)?.severity).toBeUndefined();
  });

  test('validates the normalized search before requesting the API', () => {
    const calls: Parameters<typeof useIncidentsMock>[0][] = [];
    useIncidentsMock = (opts) => {
      calls.push(opts);
      return hookState;
    };
    render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' a ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('alert').textContent).toMatch(/at least 3 non-space characters/i);
    expect(calls.at(-1)?.query).toBeUndefined();

    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'x'.repeat(201) },
    });
    fireEvent.submit(screen.getByRole('search'));
    expect(screen.getByRole('alert').textContent).toMatch(/limited to 200 characters/i);
    expect(calls.at(-1)?.query).toBeUndefined();
  });

  test('does not describe filtered matches as a priority-truncated queue', () => {
    renderPanel({
      incidents: [openThread],
      counts: { open: 42, needsHuman: 42, automation: 0, closed: 0 },
    });

    fireEvent.change(screen.getByLabelText('Search incidents'), {
      target: { value: 'checkout' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(screen.queryByText(/highest-priority of 42/i)).toBeNull();
  });

  test('All hides archived records even if a stale client response contains one', () => {
    hookState = {
      incidents: [openThread],
      loading: false,
      error: false,
      counts: { all: 2, open: 1, closed: 1 },
    };
    useIncidentsMock = (opts) => ({
      ...hookState,
      incidents:
        opts.state === 'all'
          ? [openThread, resolvedThread, archivedThread]
          : opts.state === 'closed'
            ? [resolvedThread]
            : [openThread],
    });
    render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(screen.getByText('billing')).toBeDefined();
    expect(screen.queryByText('retired-test')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByText('checkout')).toBeDefined();
    expect(screen.getByText('billing')).toBeDefined();
    expect(screen.queryByText('retired-test')).toBeNull();
    expect(screen.queryByText('Archived')).toBeNull();
  });

  test('C17 polls only the mounted Open tab within 30 seconds and keeps Closed pagination one-shot', () => {
    const calls: {
      state?: 'open' | 'closed' | 'all';
      attention?: 'human' | 'automation';
      cursor?: string;
      limit?: number;
      pollMs?: number;
    }[] = [];
    hookState = {
      incidents: [openThread, resolvedThread],
      loading: false,
      error: false,
      counts: { open: 1, closed: 1 },
    };
    useIncidentsMock = (opts) => {
      calls.push(opts);
      return hookState;
    };
    render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );

    const openCall = calls.find((call) => call.state === 'open');
    expect(openCall?.attention).toBe('human');
    expect(openCall?.pollMs).toBeGreaterThan(0);
    expect(openCall?.pollMs).toBeLessThanOrEqual(30_000);
    expect(openCall?.limit).toBe(100);

    fireEvent.click(screen.getByRole('tab', { name: 'Automation handling' }));
    expect(calls.some((call) => call.attention === 'automation')).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    const closedCall = calls.filter((call) => call.state === 'closed').at(-1);
    expect(closedCall).toMatchObject({
      state: 'closed',
      cursor: undefined,
      limit: undefined,
      pollMs: undefined,
    });

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(calls.filter((call) => call.state === 'all').at(-1)).toMatchObject({
      state: 'all',
      cursor: undefined,
      limit: undefined,
      pollMs: undefined,
    });
  });

  test('tab badges show the per-partition counts', () => {
    renderPanel({ incidents: [openThread, investigatingThread, resolvedThread] });
    expect(within(screen.getByRole('tab', { name: 'Needs human' })).getByText('2')).toBeDefined();
    expect(within(screen.getByRole('tab', { name: 'Closed' })).getByText('1')).toBeDefined();
  });

  // B4 [RED]: the closed archive is paginated, so `incidents` is only the current page. The tab
  // badges must show the server's true per-scope counts, not the length of the fetched slice. Here the
  // slice has 1 open thread but the server reports 42 open / 7 closed — the badges must read 42 / 7.
  test('B4: tab badges bind to the server per-scope counts, not the truncated fetch', () => {
    renderPanel({
      incidents: [openThread],
      counts: { open: 42, needsHuman: 42, automation: 0, closed: 7 },
    });
    expect(within(screen.getByRole('tab', { name: 'Needs human' })).getByText('42')).toBeDefined();
    expect(within(screen.getByRole('tab', { name: 'Closed' })).getByText('7')).toBeDefined();
    expect(
      screen.getByText(/showing the 1 highest-priority of 42 human exceptions/i),
    ).toBeDefined();
  });

  test('C5: all-resolved incidents show an empty Open tab, and a populated Closed tab', () => {
    renderPanel({ incidents: [resolvedThread] });

    // Open tab active by default: no open threads → empty state, no rows.
    expect(screen.queryByText('billing')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(screen.getByText('billing')).toBeDefined();
  });

  test('C5: with no incidents at all, both tabs show empty states', () => {
    renderPanel({ incidents: [] });

    expect(screen.queryByRole('link')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('shows loading state while the hook is loading', () => {
    renderPanel({ incidents: [], loading: true });
    expect(screen.getByText('Loading…')).toBeDefined();
  });

  test('uses one reserved, accessible first-load state without duplicating pagination status (C1, C6)', () => {
    const { container } = renderPanel({ incidents: [], loading: true });

    expect(container.querySelector('[data-page-state="loading"]')?.className).toMatch(/min-h-/);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading incidents/i);
  });

  test('uses one page heading and exposes no retry for its one-shot request (C3, C7)', () => {
    renderPanel({ incidents: [], error: true });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Incidents' })).toBeDefined();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  // [RED]: switching Open↔Closed fires a per-scope refetch (loading:true) while the server's
  // per-scope counts are already known (retained across the refetch). The tab bar must stay mounted so
  // the chrome does not flash/unmount mid-switch — only the row region should show the loading state.
  // RED today: the panel gates the WHOLE tab bar behind !loading, so both tabs unmount during loading.
  test('keeps the tab bar mounted during a refetch when counts are known', () => {
    renderPanel({ incidents: [], loading: true, counts: { open: 5, closed: 3 } });
    expect(screen.getByRole('tab', { name: 'Needs human' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Automation handling' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Closed' })).toBeDefined();
  });

  // during a per-scope refetch the ROW region is skeletoned, not left showing the previous scope's
  // stale rows. Pins the `loading ? Loading : rows` branch: the tab bar stays mounted, the panel shows
  // 'Loading…', and no incident row is rendered. Guards a regression that leaked stale rows mid-switch.
  test('blanks only the row region during a refetch — tab bar stays, rows are not shown stale', () => {
    renderPanel({ incidents: [openThread], loading: true, counts: { open: 1, closed: 0 } });
    // Tab bar mounted.
    expect(screen.getByRole('tab', { name: 'Needs human' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Automation handling' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Closed' })).toBeDefined();
    // Row region skeletoned.
    expect(screen.getByText('Loading…')).toBeDefined();
    // The in-flight incident's identifying text is NOT rendered (no stale rows).
    expect(screen.queryByText('checkout')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('shows error state when the hook errors', () => {
    renderPanel({ incidents: [], error: true });
    expect(screen.getByText('Failed to load incidents.')).toBeDefined();
    // a first-load error hides the tab bar (nothing loaded to tab through) — only the banner shows.
    expect(screen.queryByRole('tab', { name: 'Needs human' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Closed' })).toBeNull();
  });

  test('C17 keeps last-good Open rows mounted only for a background poll failure', () => {
    renderPanel({
      incidents: [openThread],
      error: true,
      backgroundError: true,
      counts: { open: 1, closed: 0 },
    });

    expect(screen.getByText('checkout')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a settled Open-to-Closed scope-switch failure remains a foreground error', () => {
    useIncidentsMock = ({ state }) =>
      state === 'closed'
        ? {
            incidents: [resolvedThread],
            loading: false,
            error: true,
            backgroundError: false,
            counts: { open: 1, closed: 1 },
          }
        : {
            incidents: [openThread],
            loading: false,
            error: false,
            backgroundError: false,
            counts: { open: 1, closed: 1 },
          };
    render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(screen.getByRole('alert').textContent).toMatch(/failed to load incidents/i);
    expect(screen.queryByText('billing')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  test('a settled Closed pagination failure keeps the established foreground error', () => {
    useIncidentsMock = ({ state, cursor }) => {
      if (state !== 'closed') {
        return {
          incidents: [],
          loading: false,
          error: false,
          backgroundError: false,
          counts: { open: 0, closed: 1 },
          nextCursor: null,
        };
      }
      return cursor
        ? {
            incidents: [],
            loading: false,
            error: true,
            backgroundError: false,
            counts: { open: 0, closed: 1 },
            nextCursor: null,
          }
        : {
            incidents: [resolvedThread],
            loading: false,
            error: false,
            backgroundError: false,
            counts: { open: 0, closed: 1 },
            nextCursor: 'CUR2',
          };
    };
    render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getByRole('alert').textContent).toMatch(/failed to load incidents/i);
    expect(screen.queryByText('billing')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  // an error DURING a refetch (counts retained, loading still true) keeps the body hidden — the
  // error banner stands alone, no tab bar and no rows. The `!error` guard on the tab block owns this.
  test('an error during a refetch hides the tab bar and rows, showing only the banner', () => {
    renderPanel({ incidents: [], error: true, loading: true, counts: { open: 3, closed: 2 } });
    expect(screen.getByText('Failed to load incidents.')).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'Needs human' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Closed' })).toBeNull();
  });
});
