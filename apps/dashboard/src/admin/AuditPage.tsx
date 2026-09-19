import { requestErrorMessage } from '../lib/request-error';
import { useEffect, useState } from 'react';
import { useSession } from '../auth';
import { InlineAlert } from '../components/PageState';
import { adminRequest } from './api';
import { AdminPage } from './AdminPage';
import { useAdminData } from './useAdminData';

interface Action {
  id: string;
  actorEmail: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  reason: string | null;
  createdAt: string;
}

interface ActionPage {
  actions: Action[];
  nextCursor: string | null;
}

/** Shows the immutable platform-administrator action trail. */
export function AuditPage() {
  const { getCredentials } = useSession();
  const query = useAdminData(() => adminRequest<ActionPage>(getCredentials, '/actions'));
  const [page, setPage] = useState<ActionPage>();
  const [paging, setPaging] = useState(false);
  const [pageError, setPageError] = useState<string>();
  useEffect(() => {
    if (query.data) setPage(query.data);
  }, [query.data]);

  const loadOlder = async () => {
    if (!page?.nextCursor) return;
    setPaging(true);
    setPageError(undefined);
    try {
      const params = new URLSearchParams({ after: page.nextCursor });
      const older = await adminRequest<ActionPage>(getCredentials, `/actions?${params}`);
      setPage({ actions: [...page.actions, ...older.actions], nextCursor: older.nextCursor });
    } catch (cause) {
      setPageError(requestErrorMessage(cause, 'Older actions could not be loaded.'));
    } finally {
      setPaging(false);
    }
  };
  return (
    <AdminPage
      title="Audit trail"
      description="Every successful platform-administrator mutation, newest first."
      loading={query.loading}
      error={query.error}
      onRetry={() => void query.refresh()}
    >
      {pageError && <InlineAlert message={pageError} />}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-line bg-surface-subtle text-xs uppercase tracking-wide text-ink-faint">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Administrator</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Target</th>
              <th className="px-4 py-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {page?.actions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-ink-muted">
                  No administrator actions have been recorded yet.
                </td>
              </tr>
            )}
            {page?.actions.map((action) => (
              <tr key={action.id} className="border-b border-line last:border-0">
                <td className="whitespace-nowrap px-4 py-3">
                  {new Date(action.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3">{action.actorEmail ?? 'Deleted account'}</td>
                <td className="px-4 py-3 font-mono">{action.action}</td>
                <td className="px-4 py-3">
                  <span className="font-semibold">{action.targetKind}</span>
                  <br />
                  <span className="font-mono text-xs text-ink-faint">{action.targetId}</span>
                </td>
                <td className="max-w-md px-4 py-3">{action.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page?.nextCursor && (
        <button
          type="button"
          disabled={paging}
          onClick={() => void loadOlder()}
          className="sre-action"
        >
          {paging ? 'Loading…' : 'Load older actions'}
        </button>
      )}
    </AdminPage>
  );
}
