import { requestErrorMessage } from '../lib/request-error';
import { useState } from 'react';
import { useSession } from '../auth';
import { InlineAlert } from '../components/PageState';
import { adminRequest } from './api';
import { AdminPage } from './AdminPage';
import { useAdminData } from './useAdminData';

interface AdminUser {
  id: string;
  email: string | null;
  subject: string;
  issuer: string;
  status: 'active' | 'disabled' | 'deleted';
  lastSignInAt: string | null;
  notBefore: string | null;
  providerScope: 'installation' | 'tenant' | null;
  providerName: string | null;
  providerStatus: 'active' | 'disabled' | null;
  isPlatformAdmin: boolean;
  memberships: Array<{
    tenantId: string;
    workspaceName: string;
    role: string;
    status: string;
  }>;
}

/** Controls account gates, memberships, and platform-administrator access. */
export function UsersPage() {
  const { getCredentials } = useSession();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const query = useAdminData(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (status) params.set('status', status);
    return adminRequest<{ users: AdminUser[] }>(
      getCredentials,
      `/users${params.size ? `?${params}` : ''}`,
    );
  });

  const run = async (key: string, path: string, method = 'POST', reason?: string) => {
    setBusy(key);
    setError(undefined);
    try {
      await adminRequest(getCredentials, path, {
        method,
        body: reason === undefined ? {} : { reason },
      });
      await query.refresh();
    } catch (cause) {
      setError(requestErrorMessage(cause, 'User update failed.'));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <AdminPage
      title="Users"
      description="See every access gate together, then make one audited change at a time."
      loading={query.loading}
      error={query.error}
      onRetry={() => void query.refresh()}
    >
      <form
        className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_14rem_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void query.refresh();
        }}
      >
        <input
          aria-label="Search users"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Email or subject"
          className="rounded-lg border border-line-strong bg-canvas px-3 py-2"
        />
        <select
          aria-label="User status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="rounded-lg border border-line-strong bg-canvas px-3 py-2"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
          <option value="deleted">Deleted</option>
        </select>
        <button className="rounded-lg bg-strong px-4 py-2 font-semibold text-on-strong">
          Apply
        </button>
      </form>
      {error && <InlineAlert message={error} />}
      <div className="grid gap-4 xl:grid-cols-2">
        {query.data?.users.map((user) => {
          const reason = reasons[user.id] ?? '';
          const activeMemberships = user.memberships.filter(
            (membership) => membership.status === 'active',
          );
          return (
            <article
              key={user.id}
              className="min-w-0 rounded-xl border border-line bg-surface p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-bold">
                    {user.email ?? 'Deleted account'}
                  </h2>
                  <p className="mt-1 truncate font-mono text-xs text-ink-faint">{user.subject}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-xs font-semibold uppercase">
                    {user.status}
                  </span>
                  {user.isPlatformAdmin && (
                    <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">
                      Platform admin
                    </span>
                  )}
                </div>
              </div>
              <p className="mt-3 text-xs text-ink-faint">
                Last sign-in:{' '}
                {user.lastSignInAt ? new Date(user.lastSignInAt).toLocaleString() : 'Never'}
              </p>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-ink-faint">Account gate</dt>
                  <dd className="font-semibold capitalize">{user.status}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Token gate</dt>
                  <dd className="font-semibold">
                    {user.status === 'active' ? 'Accepted' : 'Blocked by account'}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Sign-out cutoff</dt>
                  <dd className="font-semibold">
                    {user.notBefore ? new Date(user.notBefore).toLocaleString() : 'Not set'}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Directory gate</dt>
                  <dd className="truncate font-semibold">
                    {user.providerName ?? user.issuer} · {user.providerStatus ?? 'unavailable'}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 space-y-2 border-t border-line pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  Workspaces
                </p>
                {activeMemberships.length === 0 ? (
                  <p className="text-sm text-ink-muted">No active memberships.</p>
                ) : (
                  activeMemberships.map((membership) => (
                    <div
                      key={membership.tenantId}
                      className="flex items-center justify-between gap-3 rounded-lg bg-surface-subtle px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        {membership.workspaceName} · {membership.role}
                      </span>
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run(
                            `${user.id}:${membership.tenantId}`,
                            `/users/${user.id}/memberships/${membership.tenantId}`,
                            'DELETE',
                            reason || undefined,
                          )
                        }
                        className="font-semibold text-critical disabled:opacity-60"
                      >
                        Remove
                      </button>
                    </div>
                  ))
                )}
              </div>
              {user.status !== 'deleted' && (
                <>
                  <input
                    aria-label={`Administrative reason for ${user.email ?? user.id}`}
                    value={reason}
                    onChange={(event) =>
                      setReasons((current) => ({ ...current, [user.id]: event.target.value }))
                    }
                    placeholder="Reason required for disable or delete"
                    className="mt-4 w-full rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {user.status === 'active' ? (
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run(
                            `${user.id}:disable`,
                            `/users/${user.id}/disable`,
                            'POST',
                            reason,
                          )
                        }
                        className="rounded-lg border border-critical-line px-3 py-2 text-sm font-semibold text-critical hover:bg-critical-soft disabled:opacity-60"
                      >
                        Disable
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => void run(`${user.id}:enable`, `/users/${user.id}/enable`)}
                        className="rounded-lg bg-strong px-3 py-2 text-sm font-semibold text-on-strong disabled:opacity-60"
                      >
                        Enable
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run(`${user.id}:signout`, `/users/${user.id}/sign-out-everywhere`)
                      }
                      className="rounded-lg border border-line-strong px-3 py-2 text-sm font-semibold disabled:opacity-60"
                    >
                      Sign out everywhere
                    </button>
                    {user.isPlatformAdmin ? (
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run(`${user.id}:revoke`, `/users/${user.id}/revoke-admin`)
                        }
                        className="rounded-lg border border-warning-line px-3 py-2 text-sm font-semibold text-warning disabled:opacity-60"
                      >
                        Revoke admin
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={Boolean(busy) || user.providerScope !== 'installation'}
                        title={
                          user.providerScope !== 'installation'
                            ? 'Only staff-directory identities can be platform administrators.'
                            : undefined
                        }
                        onClick={() =>
                          void run(`${user.id}:grant`, `/users/${user.id}/grant-admin`)
                        }
                        className="rounded-lg border border-line-strong px-3 py-2 text-sm font-semibold disabled:opacity-50"
                      >
                        Grant admin
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run(`${user.id}:delete`, `/users/${user.id}`, 'DELETE', reason)
                      }
                      className="ml-auto rounded-lg bg-critical-solid px-3 py-2 text-sm font-semibold text-on-strong disabled:opacity-60"
                    >
                      Delete account
                    </button>
                  </div>
                </>
              )}
            </article>
          );
        })}
      </div>
    </AdminPage>
  );
}
