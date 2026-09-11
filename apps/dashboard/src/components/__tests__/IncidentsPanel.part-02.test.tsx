// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { MemoryRouter } from 'react-router-dom';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Incident } from '../../lib/types';

// The terminal split follows lifecycle, independent of investigation progress.
import { IncidentsPanel } from '../IncidentsPanel';

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

// the closed archive is keyset-paginated. The closed tab must offer "Load more" while the server
// reports a nextCursor, fetch the next page with that cursor, and APPEND it (page one stays on screen).
// The button disappears once nextCursor is null. RED before the panel wiring: no Load-more button exists
// and the closed tab shows only page one, so 'charlie' never appears.
describe('IncidentsPanel closed archive Load more', () => {
  test('pages the closed archive via nextCursor, appending rows; the button disappears on the last page', () => {
    const page1 = [mk('ca', 'resolved', 'alpha'), mk('cb', 'closed', 'bravo')];
    const page2 = [mk('cc', 'resolved', 'charlie')];
    // Cursor-aware page source: open scope is empty here; closed page one carries nextCursor='CUR2',
    // closed page two (fetched with that cursor) is the last page (nextCursor null).
    useIncidentsMock = ({ state, cursor }) => {
      if (state !== 'closed') {
        return {
          incidents: [],
          loading: false,
          error: false,
          counts: { open: 0, closed: 3 },
          nextCursor: null,
        };
      }
      return cursor
        ? {
            incidents: page2,
            loading: false,
            error: false,
            counts: { open: 0, closed: 3 },
            nextCursor: null,
          }
        : {
            incidents: page1,
            loading: false,
            error: false,
            counts: { open: 0, closed: 3 },
            nextCursor: 'CUR2',
          };
    };

    render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );

    // Enter the closed tab: page one is shown, page two is not, and Load more is offered.
    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('bravo')).toBeDefined();
    expect(screen.queryByText('charlie')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDefined();

    // Load more: the next page is fetched with the cursor and APPENDED — page one stays, page two joins,
    // and with no further cursor the button disappears.
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('bravo')).toBeDefined();
    expect(screen.getByText('charlie')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  test('isolates cursors, rows, and announcements when switching between Closed and All', () => {
    const closedFirst = [mk('closed-a', 'resolved', 'closed-alpha')];
    const closedSecond = [mk('closed-b', 'closed', 'closed-bravo')];
    const allFirst = [mk('all-a', 'closed', 'all-alpha')];
    const allSecond = [mk('all-b', 'open', 'all-bravo')];
    const calls: Array<{ state?: 'open' | 'closed' | 'all'; cursor?: string }> = [];
    useIncidentsMock = ({ state, cursor }) => {
      calls.push({ state, cursor });
      if (state === 'closed') {
        return {
          incidents: cursor ? closedSecond : closedFirst,
          loading: false,
          error: false,
          counts: { all: 4, open: 1, closed: 2 },
          nextCursor: cursor ? null : 'CLOSED-2',
        };
      }
      if (state === 'all') {
        return {
          incidents: cursor ? allSecond : allFirst,
          loading: false,
          error: false,
          counts: { all: 4, open: 1, closed: 2 },
          nextCursor: cursor ? null : 'ALL-2',
        };
      }
      return {
        incidents: [],
        loading: false,
        error: false,
        counts: { all: 4, open: 1, closed: 2 },
        nextCursor: null,
      };
    };

    render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getByText('closed-alpha')).toBeDefined();
    expect(screen.getByText('closed-bravo')).toBeDefined();
    expect(screen.getByRole('status').textContent).toMatch(/1 more incident loaded/i);

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(calls.at(-1)).toEqual({ state: 'all', cursor: undefined });
    expect(screen.queryByText('closed-alpha')).toBeNull();
    expect(screen.queryByText('closed-bravo')).toBeNull();
    expect(screen.getByText('all-alpha')).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(calls.at(-1)).toEqual({ state: 'all', cursor: 'ALL-2' });
    expect(screen.getByText('all-alpha')).toBeDefined();
    expect(screen.getByText('all-bravo')).toBeDefined();

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(calls.at(-1)).toEqual({ state: 'closed', cursor: undefined });
    expect(screen.queryByText('all-alpha')).toBeNull();
    expect(screen.queryByText('all-bravo')).toBeNull();
    expect(screen.getByText('closed-alpha')).toBeDefined();
    expect(screen.queryByText('closed-bravo')).toBeNull();
  });
});

// "Load more" is a PAGINATION fetch, not a scope switch. Keyset paging is meant to GROW the list,
// but the row region is gated on `loading` alone, so advancing the cursor blanks the already-accumulated
// archive to "Loading…" and flashes it back grown. Mirrors DeploymentsPanel's settled `firstLoad =
// loading &&!hasRows`: blank only when there is nothing accumulated to keep.
//
// The gate must key off the ACCUMULATED closed pages, not off `shown` generally: on the OPEN tab `shown`
// derives from the live `incidents` slice, which still holds the PREVIOUS scope's rows mid-switch, and
// above pins that those stale rows must not be shown.
describe('IncidentsPanel closed archive pagination keeps the list mounted', () => {
  // Closed page one settles and offers a cursor; the page-two fetch (cursor set) is left IN FLIGHT.
  function inFlightSecondPage() {
    const page1 = [mk('ca', 'resolved', 'alpha'), mk('cb', 'closed', 'bravo')];
    useIncidentsMock = ({ state, cursor }) => {
      if (state !== 'closed') {
        return {
          incidents: [],
          loading: false,
          error: false,
          counts: { open: 0, closed: 3 },
          nextCursor: null,
        };
      }
      return cursor
        ? {
            incidents: [],
            loading: true,
            error: false,
            counts: { open: 0, closed: 3 },
            nextCursor: null,
          }
        : {
            incidents: page1,
            loading: false,
            error: false,
            counts: { open: 0, closed: 3 },
            nextCursor: 'CUR2',
          };
    };
    return render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );
  }

  test('the accumulated page-one rows stay mounted while a Load more fetch is in flight', () => {
    const { unmount } = inFlightSecondPage();

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('bravo')).toBeDefined();

    // Page two in flight: the archive the human has already read must NOT flash away and back.
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('bravo')).toBeDefined();
    expect(screen.queryByText('Loading…')).toBeNull(); // the row region is not blanked

    unmount(); // documented trap: unmount in the body, not only via afterEach cleanup
  });

  test('a first closed load with nothing accumulated still blanks the row region', () => {
    // The other side of the gate. With no accumulated pages there is nothing to keep mounted, so the
    // loading state must still show — an empty list would read as "no closed incidents".
    useIncidentsMock = () => ({
      incidents: [],
      loading: true,
      error: false,
      counts: { open: 0, closed: 3 },
      nextCursor: null,
    });
    const { unmount } = render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(screen.getByText('Loading…')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();

    unmount();
  });
});

// [RED]: pagination is silent to a screen reader. "Load more" UNMOUNTS on click (:131) and the next page
// is appended into the list with no announcement, so a non-sighted human cannot tell "loading", "3 more
// arrived" and "that was the last page" apart — the control simply vanishes. The panel must own a polite live
// region announcing the ACTION on activation and the RESULT (with the row delta) when the page settles.
//
// RED today: there is no `role="status"`/`aria-live` anywhere in either panel, so every getByRole('status')
// below throws. Nothing else would catch this either — `.oxlintrc.json` has no jsx-a11y and CI has no
// axe/pa11y, so these tests are the ONLY proof the region exists and says the right thing.
describe('IncidentsPanel pagination live region', () => {
  const page1 = [mk('ca', 'resolved', 'alpha'), mk('cb', 'closed', 'bravo')];
  // Three rows, chosen so the delta (3) differs from the accumulated total (5) AND from the server's closed
  // total (42) — the two plausible wrong sources. A one-row page would let all three collide.
  const page2 = [
    mk('cc', 'resolved', 'charlie'),
    mk('cd', 'resolved', 'delta'),
    mk('ce', 'resolved', 'echo'),
  ];
  // `counts` are per-scope TOTALS from the server (useIncidents.ts:6), NOT a page delta. 42 closed rows exist;
  // only 3 just arrived. Announcing 42 would be wrong, which is exactly what the announcement test below pins.
  const counts = { open: 0, closed: 42 };

  // Closed page one always settles with a cursor; the caller decides what the page-two fetch does.
  function renderClosedArchive(pageTwo: {
    incidents: Incident[];
    loading: boolean;
    nextCursor: string | null;
  }) {
    useIncidentsMock = ({ state, cursor }) => {
      if (state !== 'closed') {
        return { incidents: [], loading: false, error: false, counts, nextCursor: null };
      }
      return cursor
        ? {
            incidents: pageTwo.incidents,
            loading: pageTwo.loading,
            error: false,
            counts,
            nextCursor: pageTwo.nextCursor,
          }
        : { incidents: page1, loading: false, error: false, counts, nextCursor: 'CUR2' };
    };
    return render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );
  }

  test('activating Load more announces the action in a polite live region', () => {
    // Page two is left IN FLIGHT so the in-progress announcement is observable before the result replaces it.
    const { unmount } = renderClosedArchive({ incidents: [], loading: true, nextCursor: null });

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    const region = screen.getByRole('status');
    // role="status" is an implicitly polite region; the explicit attribute is asserted too because the
    // announcement must never interrupt what the human is reading, and explicit beats implicit across AT.
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent ?? '').toMatch(/loading more/i);

    unmount(); // documented trap: unmount in the body, not only via afterEach cleanup
  });

  test('a settled page announces the row delta of the page just appended, not a total', () => {
    // Page two carries a FURTHER cursor, isolating the delta message from the last-page message.
    const { unmount } = renderClosedArchive({
      incidents: page2,
      loading: false,
      nextCursor: 'CUR3',
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    // Prove the fixture really appended page two before asserting what is announced about it: 3 new rows
    // joined the 2 retained ones. Without this the delta below could be asserted against a no-op.
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('charlie')).toBeDefined();
    expect(screen.getByText('echo')).toBeDefined();

    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(/\b3\b/); // the just-appended page's rows.length (IncidentsPanel.tsx:54)
    expect(text).toMatch(/more incidents loaded/i);
    expect(text).not.toMatch(/\b5\b/); // NOT the accumulated total
    expect(text).not.toMatch(/\b42\b/); // NOT counts.closed, the server's scope total

    unmount();
  });

  test('the last page announces that there are no more rows', () => {
    const { unmount } = renderClosedArchive({ incidents: page2, loading: false, nextCursor: null });

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    // The button is gone (nextCursor null). Without an announcement a screen-reader user cannot tell
    // "the archive ends here" from "the control vanished".
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByRole('status').textContent ?? '').toMatch(/no more/i);

    unmount();
  });

  test('a first load announces nothing — the region is mounted and empty', () => {
    // A first load is not pagination; the panel already blanks visibly and the tab badges carry the counts,
    // so announcing it is noise. The region must still be MOUNTED and empty: AT observes MUTATIONS of an
    // existing region, so one that appears only once it has text is announced unreliably.
    const { unmount } = renderClosedArchive({ incidents: [], loading: false, nextCursor: null });

    expect(screen.getByRole('status').textContent).toBe('');
    // Entering Closed is a first load of that scope (no cursor), not a pagination step: still silent.
    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    expect(screen.getByRole('status').textContent).toBe('');

    unmount();
  });

  test('the result is cleared when idle, so a re-render cannot re-announce it', () => {
    const { unmount } = renderClosedArchive({
      incidents: page2,
      loading: false,
      nextCursor: 'CUR3',
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.getByRole('status').textContent ?? '').toMatch(/\b3\b/);

    // A scope switch is not a pagination result. If the message were DERIVED from render state rather than
    // set by the pagination event, the stale "3 more…" would survive here and be re-announced on re-render.
    fireEvent.click(screen.getByRole('tab', { name: 'Needs human' }));
    expect(screen.getByRole('status').textContent).toBe('');

    unmount();
  });
});

// [RED]: the failed-load banner is a plain <p> (IncidentsPanel.tsx), invisible to assistive tech — a
// screen-reader user never learns the panel failed. It must carry role="alert" so AT announces it. RED
// today: there is no role on the banner, so getByRole('alert') throws.
describe('IncidentsPanel error banner accessibility', () => {
  test('the failed-load banner is exposed as an alert region', () => {
    renderPanel({ incidents: [], error: true });

    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').toMatch(/failed to load incidents/i);
  });

  test('a successful render exposes no alert — a false failure is never announced', () => {
    // The other half of the criterion: the banner is conditionally rendered, so dropping the `error &&`
    // guard would announce a failure that never happened. This fails if the guard is removed.
    renderPanel({ incidents: [openThread], error: false });

    expect(screen.queryByRole('alert')).toBeNull();
  });
});
