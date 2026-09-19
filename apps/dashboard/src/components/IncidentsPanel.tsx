import { useMemo, useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { useIncidents } from '../lib/useIncidents';
import { useKeysetPages } from '../lib/useKeysetPages';
import { usePaginationAnnouncer } from '../lib/usePaginationAnnouncer';
import type { Incident } from '../lib/types';
import { CreateIncidentAction } from './CreateIncidentAction';
import { IncidentsList } from './IncidentsList';
import { PageHeader } from './PageHeader';
import { StatePanel } from './PageState';
import { SkeletonRows } from './LoadingSkeleton';
import { SegmentedTabs } from './SegmentedTabs';

const CLOSED_STATUSES = new Set(['resolved', 'closed']);

// Module-level so its identity is stable and the announcer effect does not re-run every render.
const NOUN = { one: 'incident', many: 'incidents' };
const OPEN_POLL_MS = 30_000;
const OPEN_QUEUE_LIMIT = 100;
type IncidentTab = 'needs-human' | 'automation' | 'closed' | 'all';
type SeverityFilter = '' | 'sev1' | 'sev2' | 'sev3';

/** Partition the server-prioritized rows into the two active attention lanes and terminal history. */
export function partitionIncidentQueue(incidents: Incident[]): {
  needsHuman: Incident[];
  automation: Incident[];
  closed: Incident[];
} {
  const needsHuman: Incident[] = [];
  const automation: Incident[] = [];
  const closed: Incident[] = [];
  for (const incident of incidents) {
    if (CLOSED_STATUSES.has(incident.status)) closed.push(incident);
    else if (incident.requiresHumanAttention ?? true) needsHuman.push(incident);
    else automation.push(incident);
  }
  return { needsHuman, automation, closed };
}

/** The incident queue: active work first, with a paginated resolved archive. */
export function IncidentsPanel() {
  const { getCredentials } = useSession();
  const [tab, setTab] = useState<IncidentTab>('needs-human');
  const [searchDraft, setSearchDraft] = useState('');
  const [query, setQuery] = useState('');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [severity, setSeverity] = useState<SeverityFilter>('');
  // Historical scopes are paginated by keyset. This is the cursor of the page being requested;
  // "Load more" advances it to APPEND the next page (accumulated by useKeysetPages below). It rides the
  // request path, so it is declared ahead of the fetch. The open (active) set is bounded, so it is shown
  // as a single page, not paginated.
  const [historyCursor, setHistoryCursor] = useState<string | undefined>(undefined);

  const state = tab === 'closed' ? 'closed' : tab === 'all' ? 'all' : 'open';
  const historical = state !== 'open';

  // The active scope is filtered server-side; on the closed tab, `cursor` selects which keyset page to pull.
  const { incidents, loading, error, backgroundError, counts, nextCursor } = useIncidents({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    state,
    attention: tab === 'needs-human' ? 'human' : tab === 'automation' ? 'automation' : undefined,
    query: query || undefined,
    severity: severity || undefined,
    cursor: historical ? historyCursor : undefined,
    limit: historical ? undefined : OPEN_QUEUE_LIMIT,
    pollMs: historical ? undefined : OPEN_POLL_MS,
  });

  // partition ONCE, ahead of accumulation, so the announced delta equals the rendered closed count by
  // construction — the closed page fed to useKeysetPages is already closed-only, so a mixed page's still-open
  // rows are dropped before they can inflate the delta. The memo gives it a stable identity so useKeysetPages'
  // accumulation effect (dep on `page`) does not re-run on every render. The defensive partition is
  // preserved, just moved ahead of accumulation.
  const partitioned = useMemo(() => partitionIncidentQueue(incidents), [incidents]);

  // page accumulation, dedupe-by-cursor and flattening are shared with DeploymentsPanel. `enabled`
  // keeps the open tab's fetches out of historical accumulation. Everything below stays here because the two
  // panels diverge deliberately; see useKeysetPages for which and why.
  const historyPage = tab === 'all' ? incidents : partitioned.closed;
  const { pages: historyPages, rows: historyRows } = useKeysetPages({
    cursor: historyCursor,
    page: historyPage,
    loading,
    error,
    enabled: historical,
    resetKey: `${tab}:${query}:${severity}`,
  });
  const { announcement, announce } = usePaginationAnnouncer({
    pages: historyPages,
    nextCursor,
    error,
    noun: NOUN,
    resetKey: `${tab}:${query}:${severity}`,
  });

  const { needsHuman, automation, closed } = partitioned;
  const shown =
    tab === 'needs-human' ? needsHuman : tab === 'automation' ? automation : historyRows;
  // "Load more" is a PAGINATION fetch, not a scope switch, and keyset paging exists to GROW the list.
  // Gating the rows on `loading` alone blanked the archive the human had already read and flashed it back
  // grown. Key off the ACCUMULATED pages, mirroring DeploymentsPanel's `firstLoad = loading && !hasRows`.
  //
  // It must be historyPages, NOT `shown.length > 0`: on the OPEN tab `shown` derives from the live
  // `incidents` slice, which still holds the PREVIOUS scope's rows mid-switch, so keying off `shown` would
  // keep stale rows on screen during an Open↔Closed switch, which is exactly what forbids.
  const paginatingHistory = historical && historyPages.length > 0;
  // Badges reflect the server's true per-scope totals, not the length of the current page; fall
  // back to the fetched partition lengths on the legacy no-counts path.
  const needsHumanCount = counts?.needsHuman ?? needsHuman.length;
  const automationCount = counts?.automation ?? automation.length;
  const closedCount = counts?.closed ?? closed.length;
  const allCount = counts?.all ?? incidents.length;
  const activeLaneCount = tab === 'needs-human' ? needsHumanCount : automationCount;

  // the server returns per-scope counts on every settled load, so switching Open↔Closed refetches
  // with the counts still in hand. Blank the whole panel only on the FIRST load (loading with no counts
  // known yet); once loaded, a tab-switch refetch keeps the tab bar mounted and blanks ONLY the row region,
  // so the chrome no longer flashes/unmounts mid-switch. Mirrors DeploymentsPanel's firstLoad pattern.
  const firstLoad = loading && counts == null;
  // Only a failed interval refresh after a successful load of the same Open path is non-blocking.
  // Scope switches and historical pagination are one-shot requests, so their failures still own the panel.
  const blockingError = error && !backgroundError;

  const filtersActive = Boolean(query || severity);

  function selectTab(next: string) {
    setTab(next as IncidentTab);
    setHistoryCursor(undefined);
    announce('');
  }

  return (
    <section>
      <PageHeader
        title="Incidents"
        description="Exception-driven response: human decisions first, routine investigation handled by SRE Platform."
        action={<CreateIncidentAction />}
      />
      {/* paging is otherwise silent to a screen reader, because "Load more" unmounts on click and the
          rows below simply grow. Mounted even when empty: assistive tech announces MUTATIONS of a region it
          is already watching, so one that appears only once it has text is announced unreliably. */}
      <p role="status" aria-live="polite" className="sr-only">
        {firstLoad && !blockingError ? 'Loading incidents…' : announcement}
      </p>
      {firstLoad && !blockingError && (
        <StatePanel state="loading" title="Loading…" skeleton="list" announce={false} />
      )}
      {/* Foreground failures replace the panel and announce; a failed Open background poll keeps the
          last-good rows mounted. */}
      {blockingError && (
        <StatePanel
          state="error"
          title="Failed to load incidents."
          description="The incident list could not be retrieved."
        />
      )}
      {!firstLoad && !blockingError && (
        <>
          <div className="mb-4">
            <SegmentedTabs
              label="Incident handling"
              value={tab}
              panelId="thread-list-panel"
              onChange={selectTab}
              items={[
                {
                  id: 'needs-human',
                  label: 'Needs human',
                  compactLabel: 'Human',
                  count: needsHumanCount,
                },
                {
                  id: 'automation',
                  label: 'Automation handling',
                  compactLabel: 'Auto',
                  count: automationCount,
                },
                { id: 'closed', label: 'Closed', count: closedCount },
                { id: 'all', label: 'All', count: allCount },
              ]}
            />
          </div>
          <form
            className="sre-filter-shell mb-4 rounded-lg border border-line bg-surface p-3"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              const normalizedQuery = searchDraft.trim();
              if (normalizedQuery && normalizedQuery.length < 3) {
                setSearchError('Enter at least 3 non-space characters.');
                return;
              }
              if (normalizedQuery.length > 200) {
                setSearchError('Search is limited to 200 characters.');
                return;
              }
              setSearchError(null);
              setQuery(normalizedQuery);
              setHistoryCursor(undefined);
              announce('');
            }}
          >
            <div className="sre-filter-grid">
              <label className="text-xs font-medium text-ink-secondary">
                Search incidents
                <input
                  type="search"
                  maxLength={200}
                  value={searchDraft}
                  onChange={(event) => {
                    setSearchDraft(event.target.value);
                    setSearchError(null);
                  }}
                  aria-invalid={searchError ? 'true' : undefined}
                  aria-describedby={searchError ? 'incident-search-error' : undefined}
                  placeholder="Title, service, source, channel, or ID"
                  className="sre-field sre-hit-target mt-1 w-full min-w-0"
                />
                {searchError && (
                  <span
                    id="incident-search-error"
                    role="alert"
                    className="mt-1 block text-critical"
                  >
                    {searchError}
                  </span>
                )}
              </label>
              <label className="text-xs font-medium text-ink-secondary">
                Severity
                <select
                  value={severity}
                  onChange={(event) => {
                    setSeverity(event.target.value as SeverityFilter);
                    setHistoryCursor(undefined);
                  }}
                  className="sre-field sre-hit-target mt-1 w-full"
                >
                  <option value="">All severities</option>
                  <option value="sev1">SEV1</option>
                  <option value="sev2">SEV2</option>
                  <option value="sev3">SEV3</option>
                </select>
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className="sre-action sre-action-primary sre-hit-target">
                  Search
                </button>
                <button
                  type="button"
                  disabled={!filtersActive && !searchDraft}
                  onClick={() => {
                    setSearchDraft('');
                    setQuery('');
                    setSearchError(null);
                    setSeverity('');
                    setHistoryCursor(undefined);
                  }}
                  className="sre-action sre-hit-target"
                >
                  Clear
                </button>
              </div>
            </div>
          </form>
          <div
            role="tabpanel"
            id="thread-list-panel"
            aria-labelledby={`thread-list-panel-tab-${tab}`}
          >
            {!historical && !filtersActive && activeLaneCount > shown.length && !loading && (
              <p className="mb-3 rounded-md border border-warning-line bg-warning-soft p-3 text-sm text-warning">
                Showing the {shown.length} highest-priority of {activeLaneCount}{' '}
                {tab === 'needs-human' ? 'human exceptions' : 'automation-handled incidents'}.
              </p>
            )}
            {loading && !paginatingHistory ? (
              // A per-scope refetch with nothing accumulated to keep: blank only the rows so the chrome
              // stays put. A closed-tab pagination fetch keeps its rows mounted instead.
              <SkeletonRows label="Loading…" rows={3} announce={false} />
            ) : (
              <>
                <IncidentsList incidents={shown} />
                {/* Historical scopes are keyset-paginated; advance the cursor to append the next page.
                    Hidden once the server reports no further page (nextCursor null), and while a page is
 in flight so it cannot be re-fired (DeploymentsPanel). Open is not paginated. */}
                {historical && nextCursor && !loading && (
                  <button
                    type="button"
                    onClick={() => {
                      // Announce the action now; the announcer reports the result once the page lands.
                      announce('Loading more incidents…');
                      setHistoryCursor(nextCursor);
                    }}
                    className="mt-3 w-full rounded-md border border-line py-2 text-sm font-medium text-ink-muted hover:bg-surface-subtle"
                  >
                    Load more
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
