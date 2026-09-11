// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Deployment, GitOpsApplication, Incident } from '../../lib/types';

// the deploy panel paginates older history. Mirrors the IncidentsPanel closed-archive Load-more
// wiring: useDeployments returns a nextCursor, the panel offers "Load older" while one exists, fetches the
// next page with that cursor, and APPENDS it (page one stays on screen). The button disappears once
// nextCursor is null. RED before the panel wiring: there is no Load-older button and only page one renders.
import { DeploymentsPanel } from '../DeploymentsPanel';

// The shared auth boundary is a hard dependency of the panel; stub it so the hook wiring doesn't run.
vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));

// Swappable, cursor-aware hook impl. The Load-older test swaps in a page source keyed on the cursor arg
// the panel passes; the default returns an empty first page.
let useDeploymentsMock: (opts: { cursor?: string; limit?: number }) => {
  deployments: Deployment[];
  loading: boolean;
  error: boolean;
  nextCursor?: string | null;
  // the panel re-fires a same-cursor "Load older" (a failed retry) through the hook's refetch.
  refetch?: () => void;
} = () => ({ deployments: [], loading: false, error: false, nextCursor: null });
vi.mock('../../lib/useDeployments', () => ({
  useDeployments: (opts: { cursor?: string; limit?: number }) => useDeploymentsMock(opts),
}));
let gitOpsApplications: GitOpsApplication[] = [];
vi.mock('../../lib/useGitOps', () => ({
  useGitOps: () => ({
    applications: gitOpsApplications,
    loading: false,
    error: false,
    backgroundError: false,
    refetch: vi.fn(),
  }),
}));
let incidentFeed: Incident[] = [];
vi.mock('../../lib/useIncidents', () => ({
  useIncidents: () => ({
    incidents: incidentFeed,
    counts: null,
    nextCursor: null,
    loading: false,
    error: false,
    backgroundError: false,
  }),
}));

function dep(sha: string, repo: string): Deployment {
  return {
    dataSourceName: 'Primary GitHub',
    source: 'github',
    repo,
    ref: 'main',
    sha,
    status: 'success',
    transientEnvironment: false,
    deployedAt: new Date().toISOString(),
  };
}

afterEach(() => {
  cleanup();
  gitOpsApplications = [];
  incidentFeed = [];
});

test('shows live ArgoCD state above completed deployment history', () => {
  gitOpsApplications = [
    {
      dataSourceId: '00000000-0000-4000-8000-000000000001',
      dataSourceName: 'Primary Argo CD',
      source: 'argocd',
      entityId: 'application:payments/argocd/orders',
      applicationId: 'payments/argocd/orders',
      applicationName: 'orders',
      applicationNamespace: 'argocd',
      project: 'payments',
      syncStatus: 'Synced',
      healthStatus: 'Healthy',
      operationPhase: 'Succeeded',
      revisions: ['healthy-head'],
      conditions: [],
      observedAt: new Date().toISOString(),
    },
    {
      dataSourceId: '00000000-0000-4000-8000-000000000001',
      dataSourceName: 'Primary Argo CD',
      source: 'argocd',
      entityId: 'application:payments/argocd/checkout',
      applicationId: 'payments/argocd/checkout',
      applicationName: 'checkout',
      applicationNamespace: 'argocd',
      project: 'payments',
      syncStatus: 'OutOfSync',
      healthStatus: 'Degraded',
      operationPhase: 'Running',
      revisions: ['head-app', 'head-config'],
      destinationNamespace: 'payments',
      conditions: [{ type: 'ComparisonError', message: 'render failed' }],
      observedAt: new Date().toISOString(),
    },
  ];
  useDeploymentsMock = () => ({
    deployments: [dep('release-app', 'payments/argocd/checkout')],
    loading: false,
    error: false,
    nextCursor: null,
  });
  render(<DeploymentsPanel />);

  const liveHeading = screen.getByRole('heading', { name: 'Application health' });
  const history = screen.getByText('Evidence ledger');
  expect(
    liveHeading.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByText('Sync: OutOfSync')).toBeDefined();
  expect(screen.getByText('Health: Degraded')).toBeDefined();
  expect(screen.getByText(/ComparisonError: render failed/)).toBeDefined();
  const degraded = screen.getByRole('article', { name: 'checkout' });
  expect(within(degraded).getByText('Health: Degraded').className).toMatch(/bg-critical/);
  expect(within(degraded).getByText('Sync: OutOfSync').className).toMatch(/bg-warning/);
  expect(screen.getByText('Show 1 healthy application')).toBeDefined();
  expect(screen.queryByRole('article', { name: 'orders' })).toBeNull();
  expect(within(degraded).getByText(/Observed/)).toBeDefined();
});

test('orders error, unknown or pending, then healthy ArgoCD applications', () => {
  const application = (name: string, overrides: Partial<GitOpsApplication>): GitOpsApplication => ({
    dataSourceId: '00000000-0000-4000-8000-000000000001',
    dataSourceName: 'Primary Argo CD',
    source: 'argocd',
    entityId: `application:payments/argocd/${name}`,
    applicationId: `payments/argocd/${name}`,
    applicationName: name,
    applicationNamespace: 'argocd',
    project: 'payments',
    revisions: [],
    conditions: [],
    observedAt: new Date().toISOString(),
    ...overrides,
  });
  gitOpsApplications = [
    application('healthy', { syncStatus: 'Synced', healthStatus: 'Healthy' }),
    application('pending', { operationPhase: 'Pending' }),
    application('unknown', { syncStatus: 'Unknown', healthStatus: 'Unknown' }),
    application('comparison-error', {
      conditions: [{ type: 'ComparisonError', message: 'comparison failed' }],
    }),
  ];
  render(<DeploymentsPanel />);

  const articles = screen
    .getAllByRole('article')
    .map((article) => article.getAttribute('aria-label'));
  expect(articles).toEqual(['comparison-error', 'pending', 'unknown']);
  expect(screen.getByText('Show 1 healthy application')).toBeDefined();
});

describe('DeploymentsPanel older-history Load older', () => {
  // [regression guard] — the first load MUST request the keyset shape (a `limit`), else the
  // route falls to the legacy windowed branch, returns no nextCursor, and "Load older" can never render.
  test('first load requests the keyset shape with a positive limit', () => {
    let firstOpts: { cursor?: string; limit?: number } | undefined;
    useDeploymentsMock = (opts) => {
      firstOpts ??= opts;
      return { deployments: [], loading: false, error: false, nextCursor: null };
    };

    render(<DeploymentsPanel />);

    expect(firstOpts?.cursor).toBeUndefined(); // first load has no cursor
    expect(firstOpts?.limit).toBeGreaterThan(0); // ...but always a limit, so the route paginates
  });

  test('pages older deploys via nextCursor, appending rows; the button disappears on the last page', () => {
    const page1 = [dep('a1b2c3d', 'acme/checkout')];
    const page2 = [dep('e4f5a6b', 'acme/orders')];
    // Page one carries nextCursor='CUR2'; page two (fetched with that cursor) is the last page.
    useDeploymentsMock = ({ cursor }) =>
      cursor
        ? { deployments: page2, loading: false, error: false, nextCursor: null }
        : { deployments: page1, loading: false, error: false, nextCursor: 'CUR2' };

    render(<DeploymentsPanel />);

    // Page one is shown, page two is not, and Load older is offered.
    expect(screen.getAllByText('acme/checkout').length).toBeGreaterThan(0);
    expect(screen.queryByText('acme/orders')).toBeNull();
    expect(screen.getByRole('button', { name: 'Load older' })).toBeDefined();

    // Load older: the next page is fetched with the cursor and APPENDED — page one stays, page two joins,
    // and with no further cursor the button disappears.
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(screen.getAllByText('acme/checkout').length).toBeGreaterThan(0);
    expect(screen.getAllByText('acme/orders').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
  });
});

// CHARACTERIZATION: pins the panel's CURRENT loading/error semantics before the shared page-accumulation
// hook is extracted. The two tests above both pass `loading:false, error:false` always, so they cannot detect
// a regression in any of the behaviours the extract touches. These are GREEN against today's code by design —
// they are the refactor's safety net, not a spec for new behaviour, and must stay GREEN after the extract.
//
// The error-retention gate below is the load-bearing one: DeploymentsPanel is NON-destructive (rows stay under
// the banner, `DeploymentsPanel.tsx:48-51`) where IncidentsPanel is DESTRUCTIVE (any error unmounts rows,
// pinned by `IncidentsPanel.test.tsx:189`). A hook owning error semantics for both would silently break one.
describe('DeploymentsPanel loading/error characterization', () => {
  test('characterization: the first load blanks the panel — Loading… shows and no list renders', () => {
    // `firstLoad = loading && !hasRows` (:42): nothing accumulated yet, so there is nothing to keep on screen.
    useDeploymentsMock = () => ({ deployments: [], loading: true, error: false, nextCursor: null });

    const { unmount } = render(<DeploymentsPanel />);

    expect(screen.getByText('Loading…')).toBeDefined();
    // The list subtree is gated off entirely — not merely rendered empty.
    expect(screen.queryByText('No deployments yet.')).toBeNull();

    unmount(); // documented trap: unmount in the body, not only via afterEach cleanup
  });

  test('uses one reserved, accessible first-load state without duplicating pagination status (C1, C6)', () => {
    useDeploymentsMock = () => ({ deployments: [], loading: true, error: false, nextCursor: null });

    const { container, unmount } = render(<DeploymentsPanel />);

    expect(container.querySelector('[data-page-state="loading"]')?.className).toMatch(/min-h-/);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading deployments/i);

    unmount();
  });

  test('uses one page heading and retries a foreground failure through the existing hook (C3, C7)', () => {
    const refetch = vi.fn();
    useDeploymentsMock = () => ({
      deployments: [],
      loading: false,
      error: true,
      nextCursor: null,
      refetch,
    });

    const { unmount } = render(<DeploymentsPanel />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Deployments' })).toBeDefined();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);

    unmount();
  });

  test('characterization: a failed Load older keeps the accumulated rows mounted under the banner', () => {
    // THE non-destructive semantic (:51 `hasRows || (!error && !firstLoad)`). Page one settles, then the
    // page-two fetch fails: the human must keep the history they have already read, with the banner above it.
    //
    // The error branch models what useFetchResource actually does: it never calls setData on a failure
    // (useFetchResource.ts:55), so the whole last-good body survives, both the rows AND its nextCursor. An
    // error branch returning `{deployments: [], nextCursor: null}` is a state the real hook cannot produce.
    const page1 = [dep('a1b2c3d', 'acme/checkout')];
    useDeploymentsMock = ({ cursor }) =>
      cursor
        ? { deployments: page1, loading: false, error: true, nextCursor: 'CUR2' }
        : { deployments: page1, loading: false, error: false, nextCursor: 'CUR2' };

    const { unmount } = render(<DeploymentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    expect(screen.getByText('Failed to load deployments.')).toBeDefined();
    expect(screen.getAllByText('acme/checkout').length).toBeGreaterThan(0); // rows RETAINED
    expect(screen.queryByText('No deployments yet.')).toBeNull(); // ...and not blanked to the empty state

    unmount();
  });

  test('characterization: a first-load error with nothing accumulated shows the banner alone', () => {
    // The other side of the same gate: hasRows is false, so there is no retained history to sit under the
    // banner and the list must not render an "empty" state that reads as "no deployments exist".
    useDeploymentsMock = () => ({ deployments: [], loading: false, error: true, nextCursor: null });

    const { unmount } = render(<DeploymentsPanel />);

    expect(screen.getByText('Failed to load deployments.')).toBeDefined();
    expect(screen.queryByText('No deployments yet.')).toBeNull();

    unmount();
  });

  test('characterization: Load older is hidden while a page is in flight, rows stay mounted', () => {
    // `nextCursor && !loading` (:56). Page two is left IN FLIGHT and still reports a FURTHER cursor, so the
    // button's absence is attributable to `!loading` alone — not to nextCursor being null, and not to the
    // subtree being unmounted (the retained rows below prove it is mounted).
    const page1 = [dep('a1b2c3d', 'acme/checkout')];
    useDeploymentsMock = ({ cursor }) =>
      cursor
        ? { deployments: [], loading: true, error: false, nextCursor: 'CUR3' }
        : { deployments: page1, loading: false, error: false, nextCursor: 'CUR2' };

    const { unmount } = render(<DeploymentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull(); // cannot be re-fired in flight
    expect(screen.getAllByText('acme/checkout').length).toBeGreaterThan(0); // subtree mounted
    expect(screen.queryByText('Loading…')).toBeNull(); // not a firstLoad — the panel does not blank

    unmount();
  });
});

// [RED]: the failed-load banner is a plain <p> (DeploymentsPanel.tsx), invisible to assistive tech —
// a screen-reader user never learns the panel failed. It must carry role="alert" so AT announces it. RED
// today: there is no role on the banner, so getByRole('alert') throws.
describe('DeploymentsPanel error banner accessibility', () => {
  test('the failed-load banner is exposed as an alert region', () => {
    useDeploymentsMock = () => ({ deployments: [], loading: false, error: true, nextCursor: null });

    const { unmount } = render(<DeploymentsPanel />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').toMatch(/failed to load deployments/i);

    unmount();
  });

  test('a successful render exposes no alert — a false failure is never announced', () => {
    // The other half of the criterion: the banner is conditionally rendered, so dropping the `error &&`
    // guard would announce a failure that never happened. This fails if the guard is removed.
    useDeploymentsMock = () => ({
      deployments: [dep('a1b2c3d', 'acme/checkout')],
      loading: false,
      error: false,
      nextCursor: null,
    });

    const { unmount } = render(<DeploymentsPanel />);

    expect(screen.queryByRole('alert')).toBeNull();

    unmount();
  });
});

// [RED]: a failed "Load older" cannot be retried. On failure useFetchResource retains the last-good body
// (useFetchResource.ts:55), so nextCursor still holds the SAME cursor already in the panel's state; clicking
// Load older calls setCursor(sameValue), which React bails out of via Object.is, so no fetch ever starts. The
// panel must re-fire the load via the hook's refetch when the cursor would not advance.
describe('DeploymentsPanel failed Load older is retryable', () => {
  test('retrying a failed Load older re-fires the fetch even though the cursor is unchanged', () => {
    const page1 = [dep('a1b2c3d', 'acme/checkout')];
    const refetch = vi.fn();
    // First load carries nextCursor='CUR2'. The page-two fetch fails: the hook retains page1 AND its
    // nextCursor='CUR2' (the value the click already set the cursor to), and the button stays offered.
    useDeploymentsMock = ({ cursor }) =>
      cursor
        ? { deployments: page1, loading: false, error: true, nextCursor: 'CUR2', refetch }
        : { deployments: page1, loading: false, error: false, nextCursor: 'CUR2', refetch };

    const { unmount } = render(<DeploymentsPanel />);

    // First click ADVANCES the cursor (undefined→CUR2); that is a real setCursor, no refetch needed.
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(screen.getByText('Failed to load deployments.')).toBeDefined(); // the page-two fetch failed
    expect(refetch).not.toHaveBeenCalled();

    // Retry: nextCursor === cursor === 'CUR2', so setCursor(sameValue) bails. The only way a new fetch can
    // start is refetch(). Today the panel does not call it, so this stays uncalled → RED.
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(refetch).toHaveBeenCalled();

    unmount();
  });
});

// [RED]: pagination is silent to a screen reader — "Load older" UNMOUNTS on click (:56) and the next page
// is appended with no announcement, so a non-sighted human cannot tell "loading", "5 more arrived" and "that
// was the last page" apart. The panel must own a polite live region. RED today: there is no `role="status"`
// anywhere in either panel, so every getByRole('status') below throws. Mirrors IncidentsPanel exactly.
describe('DeploymentsPanel pagination live region', () => {
  const page1 = [dep('a1b2c3d', 'acme/checkout')];
  const page2 = [dep('e4f5a6b', 'acme/orders'), dep('b7c8d9e', 'acme/search')];

  test('activating Load older announces the action in a polite live region', () => {
    // Page two is left IN FLIGHT so the in-progress announcement is observable before the result replaces it.
    useDeploymentsMock = ({ cursor }) =>
      cursor
        ? { deployments: [], loading: true, error: false, nextCursor: null }
        : { deployments: page1, loading: false, error: false, nextCursor: 'CUR2' };

    const { unmount } = render(<DeploymentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    const region = screen.getByRole('status');
    // role="status" is an implicitly polite region; the explicit attribute is asserted too because the
    // announcement must never interrupt what the human is reading, and explicit beats implicit across AT.
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent ?? '').toMatch(/loading older/i);

    unmount();
  });

  test('a settled page announces the row delta of the page just appended, not a running total', () => {
    // Page two carries a FURTHER cursor, isolating the delta message from the last-page message.
    useDeploymentsMock = ({ cursor }) =>
      cursor
        ? { deployments: page2, loading: false, error: false, nextCursor: 'CUR3' }
        : { deployments: page1, loading: false, error: false, nextCursor: 'CUR2' };

    const { unmount } = render(<DeploymentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    // Prove the fixture really appended page two before asserting what is announced about it: 2 new rows
    // joined the 1 retained one. Without this the delta below could be asserted against a no-op.
    expect(screen.getAllByText('acme/checkout').length).toBeGreaterThan(0);
    expect(screen.getAllByText('acme/orders').length).toBeGreaterThan(0);
    expect(screen.getAllByText('acme/search').length).toBeGreaterThan(0);

    // Read the REGION's text only: the rows' shas are full of digits and would make a document-wide numeric
    // assertion meaningless.
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(/\b2\b/); // the just-appended page's rows.length (DeploymentsPanel.tsx:35)
    expect(text).toMatch(/more deployments loaded/i);
    expect(text).not.toMatch(/\b3\b/); // NOT the accumulated total (page1 + page2)

    unmount();
  });

  test('the last page announces that there are no more rows', () => {
    useDeploymentsMock = ({ cursor }) =>
      cursor
        ? { deployments: page2, loading: false, error: false, nextCursor: null }
        : { deployments: page1, loading: false, error: false, nextCursor: 'CUR2' };

    const { unmount } = render(<DeploymentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    // The button is gone (nextCursor null). Without an announcement a screen-reader user cannot tell
    // "no more history" from "the control vanished".
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
    expect(screen.getByRole('status').textContent ?? '').toMatch(/no more/i);

    unmount();
  });

  test('a last page that landed empty announces the terminal clause alone, not "0 more"', () => {
    // "0 more deployments loaded. No more deployments to load." states one fact twice, the first half in
    // the least useful phrasing available. Reachable when the rows behind the cursor stop matching between
    // the two requests: page one reported a further page, so the cursor was offered, but nothing came back.
    useDeploymentsMock = ({ cursor }) =>
      cursor
        ? { deployments: [], loading: false, error: false, nextCursor: null }
        : { deployments: page1, loading: false, error: false, nextCursor: 'CUR2' };

    const { unmount } = render(<DeploymentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    expect(screen.getAllByText('acme/checkout').length).toBeGreaterThan(0); // page one is retained
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(/no more deployments to load/i);
    expect(text).not.toMatch(/\b0\b/); // never "0 more deployments loaded"

    unmount();
  });

  test('a last page that brought rows announces the delta AND the terminal clause', () => {
    // Guards the empty-page case above from over-correcting into dropping the delta whenever the archive
    // ends. A last page that carried rows still owes the human both halves.
    useDeploymentsMock = ({ cursor }) =>
      cursor
        ? { deployments: page2, loading: false, error: false, nextCursor: null }
        : { deployments: page1, loading: false, error: false, nextCursor: 'CUR2' };

    const { unmount } = render(<DeploymentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(/\b2\b/);
    expect(text).toMatch(/more deployments loaded/i);
    expect(text).toMatch(/no more deployments to load/i);

    unmount();
  });

  test('retrying a failed Load older keeps the live region silent at the start; the result is announced, not the action', () => {
    // On failure useFetchResource retains the last-good body (useFetchResource.ts:55), so nextCursor still
    // holds the cursor ALREADY in state and the button stays mounted: a failed page keeps rows and chrome. The retry
    // branch fires a REAL refetch (nonce bump) rather than a setCursor-to-identical no-op, but it
    // announces nothing to the polite region at the START. The retry OUTCOME is what reaches the
    // human: a delta once the page lands, or the role="alert" banner on another failure. A start-ping
    // here would only restate that, and this static fixture wires no refetch, so it also could not clear it.
    useDeploymentsMock = ({ cursor }) =>
      cursor
        ? { deployments: page1, loading: false, error: true, nextCursor: 'CUR2' }
        : { deployments: page1, loading: false, error: false, nextCursor: 'CUR2' };

    const { unmount } = render(<DeploymentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older' })); // this page fails

    // The banner is up and the button is still offered, which is what makes the retry clickable.
    expect(screen.getByText('Failed to load deployments.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' })); // retry: fires a real refetch, but no start-ping

    expect(screen.getByRole('status').textContent).toBe('');

    unmount();
  });

  test('a first load announces nothing — the region is mounted and empty', () => {
    // A first load is not pagination; the panel already blanks visibly, so announcing it is noise. The region
    // must still be MOUNTED and empty: AT observes MUTATIONS of an existing region, so one that appears only
    // when it has text is announced unreliably.
    useDeploymentsMock = () => ({
      deployments: page1,
      loading: false,
      error: false,
      nextCursor: 'CUR2',
    });

    const { unmount } = render(<DeploymentsPanel />);

    expect(screen.getByRole('status').textContent).toBe('');

    unmount();
  });
});
