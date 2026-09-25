import type { DeadJob, QueueHealthRow } from '@sre/contracts';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { useKeysetPages } from '../lib/useKeysetPages';
import { usePaginationAnnouncer } from '../lib/usePaginationAnnouncer';
import { incidentPath } from '../lib/routes';
import { formatAbsoluteTime, relativeTime } from '../lib/time';
import { useDeadJobs, useQueueHealth } from '../lib/useWorkQueue';
import { PageHeader } from './PageHeader';
import { InlineAlert, StatePanel } from './PageState';

const PAGE_SIZE = 25;
// Module-level so the announcer effect keeps a stable dependency.
const NOUN = { one: 'dead job', many: 'dead jobs' };

function SummaryTable({ rows, now }: { rows: QueueHealthRow[]; now: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-ink-muted">
            <th className="py-2 font-medium">Type</th>
            <th className="font-medium">Queued</th>
            <th className="font-medium">Processing</th>
            <th className="font-medium">Dead</th>
            <th className="font-medium">Oldest waiting</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.type} className="border-b border-line">
              <td className="py-3 font-mono text-xs">{row.type}</td>
              <td>{row.queued}</td>
              <td>{row.processing}</td>
              <td className={row.dead > 0 ? 'font-semibold text-critical' : undefined}>
                {row.dead}
              </td>
              <td>
                {row.oldestDueAt ? (
                  <time dateTime={row.oldestDueAt} title={formatAbsoluteTime(row.oldestDueAt)}>
                    {relativeTime(row.oldestDueAt, now)}
                  </time>
                ) : (
                  <span className="text-ink-muted">Nothing waiting</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeadJobsTable({ jobs, now }: { jobs: DeadJob[]; now: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-ink-muted">
            <th className="py-2 font-medium">Type</th>
            <th className="font-medium">Incident</th>
            <th className="font-medium">Attempts</th>
            <th className="font-medium">Last error</th>
            <th className="font-medium">Failed</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-b border-line align-top">
              <td className="py-3 pr-3 font-mono text-xs">{job.type}</td>
              <td className="py-3 pr-3">
                {job.incidentId ? (
                  <Link
                    to={incidentPath(job.incidentId)}
                    className="break-words font-medium text-ink hover:underline"
                  >
                    {job.incidentTitle ?? 'Untitled incident'}
                  </Link>
                ) : (
                  <span className="text-ink-muted">No incident</span>
                )}
              </td>
              <td className="py-3 pr-3">{job.attempts}</td>
              <td className="max-w-md break-words py-3 pr-3 font-mono text-xs text-ink-muted">
                {job.lastError ?? 'No error recorded'}
              </td>
              <td className="py-3">
                <time dateTime={job.updatedAt} title={formatAbsoluteTime(job.updatedAt)}>
                  {relativeTime(job.updatedAt, now)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Read-only queue health for the workspace. Retrying stays on each incident page. */
export function WorkQueuePanel() {
  const { getCredentials } = useSession();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const health = useQueueHealth({ apiBaseUrl: config.apiBaseUrl, getCredentials });
  const dead = useDeadJobs({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    cursor,
    limit: PAGE_SIZE,
  });
  const { pages, rows } = useKeysetPages({
    cursor,
    page: dead.jobs,
    loading: dead.loading,
    error: dead.error,
  });
  const { announcement, announce } = usePaginationAnnouncer({
    pages,
    nextCursor: dead.nextCursor,
    error: dead.error,
    noun: NOUN,
  });
  const now = Date.now();
  const hasRows = pages.length > 0;
  const firstDeadLoad = dead.loading && !hasRows;

  return (
    <section>
      <PageHeader
        title="Work queue"
        description="Background work the platform is running for this workspace. Completed work is not shown. Retry a failed investigation from its incident page."
      />
      <h2 className="mb-2 text-base font-medium text-ink">By type</h2>
      {health.loading ? (
        <StatePanel state="loading" title="Loading queue health…" skeleton="table" />
      ) : health.error ? (
        <StatePanel
          state="error"
          title="Failed to load queue health."
          description="Queue counts could not be retrieved."
          onRetry={health.refetch}
        />
      ) : health.health.types.length === 0 ? (
        <StatePanel
          state="empty"
          title="Nothing queued, running or dead."
          description="The queue has no outstanding work for this workspace."
        />
      ) : (
        <SummaryTable rows={health.health.types} now={now} />
      )}

      <div className="mb-2 mt-8">
        <h2 className="text-base font-medium text-ink">Dead jobs</h2>
        <p className="text-sm text-ink-muted">
          Work that failed after its last allowed attempt, newest first.
        </p>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {firstDeadLoad && !dead.error && (
        <StatePanel state="loading" title="Loading dead jobs…" skeleton="table" />
      )}
      {dead.error &&
        (hasRows ? (
          <InlineAlert message="Failed to load more dead jobs." onRetry={dead.refetch} />
        ) : (
          <StatePanel
            state="error"
            title="Failed to load dead jobs."
            description="The dead-job list could not be retrieved."
            onRetry={dead.refetch}
          />
        ))}
      {hasRows && rows.length === 0 && (
        <StatePanel
          state="empty"
          title="No dead jobs."
          description="Nothing has failed for good."
        />
      )}
      {rows.length > 0 && <DeadJobsTable jobs={rows} now={now} />}
      {hasRows && dead.nextCursor && !dead.loading && (
        <button
          type="button"
          className="sre-action mt-3 w-full"
          onClick={() => {
            // A failed page keeps its cursor, so advancing would be a no-op; reload it instead.
            if (cursor === dead.nextCursor) {
              dead.refetch();
            } else {
              announce('Loading more dead jobs…');
              setCursor(dead.nextCursor ?? undefined);
            }
          }}
        >
          Load more
        </button>
      )}
    </section>
  );
}
