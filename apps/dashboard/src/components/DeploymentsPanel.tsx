import { useMemo, useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { useDeployments } from '../lib/useDeployments';
import { useGitOps } from '../lib/useGitOps';
import { useIncidents } from '../lib/useIncidents';
import { useKeysetPages } from '../lib/useKeysetPages';
import { usePaginationAnnouncer } from '../lib/usePaginationAnnouncer';
import type { Deployment } from '../lib/types';
import { DeploymentsList } from './DeploymentsList';
import { applicationNeedsAttention, GitOpsApplicationsList } from './GitOpsApplicationsList';
import { DeploymentOverview } from './DeploymentOverview';
import {
  deploymentKey,
  DeploymentEvidenceTimeline,
  relatedIncidentsFor,
} from './DeploymentEvidenceTimeline';
import { PageHeader } from './PageHeader';
import { InlineAlert, StatePanel } from './PageState';
import { declareInvestigation, type InvestigationSubject } from '../lib/investigations';
import { useInvestigationWorkspaces } from '../lib/useInvestigationWorkspaces';
import { SkeletonRows } from './LoadingSkeleton';

// the panel always requests the KEYSET shape (an explicit `limit`, not the bare windowed read) so the
// route returns a `nextCursor` and the "Load older" button can appear when more history remains. Mirrors how
// IncidentsPanel always requests the keyset shape via `?state=`.
const PAGE_SIZE = 20;

// Module-level so its identity is stable and the announcer effect does not re-run every render.
const NOUN = { one: 'deployment', many: 'deployments' };

/** The Deployments panel: live GitOps state plus durable deployment history. */
export function DeploymentsPanel() {
  const { getCredentials } = useSession();
  const [range, setRange] = useState('24h');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<Deployment | null>(null);
  // deploy history is keyset-paginated. The cursor of the page being requested; "Load older" advances
  // it to APPEND the next page. It rides the request path, so it is declared ahead of the fetch.
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const filters = useMemo(() => {
    const rangeMs =
      range === '24h'
        ? 24 * 60 * 60 * 1_000
        : range === '7d'
          ? 7 * 24 * 60 * 60 * 1_000
          : range === '30d'
            ? 30 * 24 * 60 * 60 * 1_000
            : null;
    return {
      ...(rangeMs ? { from: new Date(Date.now() - rangeMs).toISOString() } : {}),
      ...(search ? { search } : {}),
      ...(source ? { source } : {}),
      ...(status ? { status } : {}),
    };
  }, [range, search, source, status]);
  const filterKey = JSON.stringify(filters);
  const {
    deployments,
    summary: loadedSummary,
    loading,
    error,
    nextCursor,
    refetch,
  } = useDeployments({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    cursor,
    limit: PAGE_SIZE,
    filters,
  });
  const gitops = useGitOps({ apiBaseUrl: config.apiBaseUrl, getCredentials });
  const incidentFeed = useIncidents({ apiBaseUrl: config.apiBaseUrl, getCredentials });
  const summary = loadedSummary ?? {
    total: 0,
    failed: 0,
    active: 0,
    environmentMissing: 0,
    latestAt: null,
  };

  // page accumulation, dedupe-by-cursor and flattening are shared with IncidentsPanel. Everything
  // below stays here because the two panels diverge deliberately; see useKeysetPages for which and why.
  const { pages, rows: shown } = useKeysetPages({
    cursor,
    page: deployments,
    loading,
    error,
    resetKey: filterKey,
  });
  const hasRows = pages.length > 0;
  // Only blank the panel for the FIRST load; a "Load older" fetch keeps the accumulated list on screen.
  const firstLoad = loading && !hasRows;
  const { announcement, announce } = usePaginationAnnouncer({
    pages,
    nextCursor,
    error,
    noun: NOUN,
  });
  const now = Date.now();
  const applicationAttentionCount = gitops.applications.filter((application) =>
    applicationNeedsAttention(application, now),
  ).length;
  const gitOpsObservedAt =
    gitops.applications
      .map((application) => application.observedAt)
      .filter((value) => Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const gitOpsStale = gitOpsObservedAt ? now - Date.parse(gitOpsObservedAt) > 90_000 : false;
  const relatedIncidentIds = new Set(
    shown.flatMap((deployment) =>
      relatedIncidentsFor(deployment, incidentFeed.incidents).map((incident) => incident.id),
    ),
  );
  const investigationSubjects = useMemo<InvestigationSubject[]>(
    () =>
      shown.flatMap((deployment) =>
        deployment.id && ['failed', 'failure', 'error', 'canceled'].includes(deployment.status)
          ? [{ kind: 'deployment' as const, deploymentId: deployment.id }]
          : [],
      ),
    [shown],
  );
  const activeInvestigations = useInvestigationWorkspaces({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    subjects: investigationSubjects,
  });

  const resetPagination = () => {
    setCursor(undefined);
    setSelected(null);
    announce('');
  };

  return (
    <section>
      <PageHeader
        title="Deployments"
        description="Investigate actual deployment records, GitOps exceptions, and incident proximity. Code, review, and CI activity lives in Changes."
      />
      {gitops.error && (
        <InlineAlert
          message={
            gitops.backgroundError
              ? 'Live Argo CD refresh failed; showing the last successful state.'
              : 'Failed to load live Argo CD state.'
          }
          onRetry={gitops.refetch}
        />
      )}
      {incidentFeed.error && (
        <InlineAlert message="Incident correlation is unavailable; deployment evidence remains visible." />
      )}
      {!firstLoad && (
        <>
          <DeploymentOverview
            summary={summary}
            range={range}
            searchDraft={searchDraft}
            source={source}
            status={status}
            applicationCount={gitops.applications.length}
            applicationAttentionCount={applicationAttentionCount}
            relatedIncidentCount={relatedIncidentIds.size}
            gitOpsObservedAt={gitOpsObservedAt}
            gitOpsStale={gitOpsStale}
            onRangeChange={(value) => {
              setRange(value);
              resetPagination();
            }}
            onSearchDraftChange={setSearchDraft}
            onSourceChange={(value) => {
              setSource(value);
              resetPagination();
            }}
            onStatusChange={(value) => {
              setStatus(value);
              resetPagination();
            }}
            onApplySearch={() => {
              setSearch(searchDraft.trim());
              resetPagination();
            }}
            onClear={() => {
              setRange('24h');
              setSearchDraft('');
              setSearch('');
              setSource('');
              setStatus('');
              resetPagination();
            }}
          />
          {!gitops.loading && (
            <GitOpsApplicationsList applications={gitops.applications} search={search} now={now} />
          )}
          {gitops.loading && (
            <div className="mb-4">
              <SkeletonRows label="Loading GitOps applications…" rows={2} />
            </div>
          )}
        </>
      )}
      {/* paging is otherwise silent to a screen reader, because "Load older" unmounts on click and the
          rows below simply grow. Mounted even when empty: assistive tech announces MUTATIONS of a region it
          is already watching, so one that appears only once it has text is announced unreliably. */}
      <p role="status" aria-live="polite" className="sr-only">
        {firstLoad && !error ? 'Loading deployments…' : announcement}
      </p>
      {firstLoad && !error && (
        <StatePanel state="loading" title="Loading…" skeleton="table" announce={false} />
      )}
      {/* A failed "Load older" fetch is a NON-destructive banner above the retained rows (useFetchResource
          keeps the last-good data); only a first-load failure with nothing accumulated stands alone.
          role="alert" (conditionally rendered so it announces on appear): the panel never polls, so every
 error is a foreground load a screen-reader user must hear (IncidentConversation.tsx:262). */}
      {error &&
        (hasRows ? (
          <InlineAlert message="Failed to load deployments." onRetry={refetch} />
        ) : (
          <StatePanel
            state="error"
            title="Failed to load deployments."
            description="Deployment history could not be retrieved."
            onRetry={refetch}
          />
        ))}
      {(hasRows || (!error && !firstLoad)) && (
        <>
          <DeploymentEvidenceTimeline
            deployments={shown}
            incidents={incidentFeed.incidents}
            applications={gitops.applications}
            selected={selected}
            onSelect={setSelected}
          />
          <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-ink">Evidence ledger</h2>
              <p className="text-sm text-ink-muted">
                Provider records, newest first. Select a row to inspect the complete evidence.
              </p>
            </div>
            <p className="text-xs text-ink-muted">
              Showing {shown.length} of {summary.total} matching deployments
            </p>
          </div>
          <DeploymentsList
            deployments={shown}
            selectedKey={selected ? deploymentKey(selected) : undefined}
            onSelect={setSelected}
            activeInvestigations={activeInvestigations}
            declareInvestigation={(subject) =>
              declareInvestigation(config.apiBaseUrl, getCredentials, subject)
            }
          />
          {/* Keyset-paginated older history; advance the cursor to append the next page. Hidden once the
              server reports no further page (nextCursor null) or while a page is in flight. */}
          {nextCursor && !loading && (
            <button
              type="button"
              onClick={() => {
                // a failed page retains the last-good body AND its nextCursor, so cursor ===
                // nextCursor and setCursor would bail via Object.is — refetch() bumps the nonce to re-run
                // the load instead. That branch stays SILENT (silent-retry): the announcer keys on the
                // fetch settling, and only the panel can observe the refetch land, so a message set here
                // would have nothing to clear it. The advancing branch announces; the announcer reports the
                // result once the page lands.
                if (cursor === nextCursor) {
                  refetch?.();
                } else {
                  announce('Loading older deployments…');
                  setCursor(nextCursor);
                }
              }}
              className="mt-3 w-full rounded-md border border-line py-2 text-sm font-medium text-ink-muted hover:bg-surface-subtle"
            >
              Load older
            </button>
          )}
        </>
      )}
    </section>
  );
}
