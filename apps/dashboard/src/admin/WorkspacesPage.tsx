import { requestErrorMessage } from '../lib/request-error';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { InlineAlert } from '../components/PageState';
import { WorkspaceMutationConfirmation } from '../components/WorkspaceMutationConfirmation';
import { setImpersonationSession } from '../lib/impersonation';
import { invalidateMe } from '../lib/me-store';
import { adminRequest } from './api';
import { AdminPage } from './AdminPage';
import { useAdminData } from './useAdminData';

interface Workspace {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'deleting';
  deleteAfter: string | null;
  requireDirectory: boolean;
  memberCount: number;
  owners: Array<{ userId: string; email: string | null }>;
  providers: Array<{ id: string; displayName: string; claimValue: string | null }>;
  domains: Array<{ id: string; domain: string; status: string }>;
}

interface Provider {
  id: string;
  displayName: string;
  status: string;
}

/** Controls workspace lifecycle, legacy bindings, and bounded support access. */
export function WorkspacesPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [drafts, setDrafts] = useState<
    Record<string, { reason?: string; providerId?: string; claimValue?: string }>
  >({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [clearingDirectory, setClearingDirectory] = useState<Workspace>();
  const query = useAdminData(async () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (status) params.set('status', status);
    const suffix = params.size ? `?${params}` : '';
    const [workspaceData, providerData] = await Promise.all([
      adminRequest<{ tenants: Workspace[] }>(session.getCredentials, `/tenants${suffix}`),
      adminRequest<{ providers: Provider[] }>(session.getCredentials, '/providers'),
    ]);
    return { ...workspaceData, providers: providerData.providers };
  });

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(undefined);
    try {
      await action();
      await query.refresh();
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Workspace update failed.'));
    } finally {
      setBusy(undefined);
    }
  };

  const startSupport = async (workspace: Workspace) => {
    const reason = drafts[workspace.id]?.reason ?? '';
    setBusy(`${workspace.id}:support`);
    setError(undefined);
    try {
      const result = await adminRequest<{
        session: {
          id: string;
          tenantId: string;
          tenantName: string;
          reason: string;
          expiresAt: string;
        };
      }>(session.getCredentials, `/tenants/${workspace.id}/impersonate`, {
        method: 'POST',
        body: { reason },
      });
      setImpersonationSession(result.session);
      invalidateMe(session.sessionKey ?? null);
      navigate('/w', { replace: true });
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Support session could not be started.'));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <AdminPage
      title="Workspaces"
      description="Inspect identity coverage, control access, and enter a visible one-hour support session."
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
          aria-label="Search workspaces"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search workspace name"
          className="rounded-lg border border-line-strong bg-canvas px-3 py-2"
        />
        <select
          aria-label="Workspace status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="rounded-lg border border-line-strong bg-canvas px-3 py-2"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="deleting">Deleting</option>
        </select>
        <button className="rounded-lg bg-strong px-4 py-2 font-semibold text-on-strong">
          Apply
        </button>
      </form>
      {error && <InlineAlert message={error} />}
      {clearingDirectory && (
        <WorkspaceMutationConfirmation
          title={`Allow platform-wide sign-in for ${clearingDirectory.name}? Owners will be notified.`}
          slug={clearingDirectory.slug}
          busy={Boolean(busy)}
          onCancel={() => setClearingDirectory(undefined)}
          onConfirm={() =>
            void run(`${clearingDirectory.id}:directory`, async () => {
              await adminRequest(
                session.getCredentials,
                `/tenants/${clearingDirectory.id}/clear-require-directory`,
                {
                  method: 'POST',
                  body: { reason: drafts[clearingDirectory.id]?.reason ?? '' },
                },
              );
              setClearingDirectory(undefined);
            })
          }
        />
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {query.data?.tenants.map((workspace) => {
          const draft = drafts[workspace.id] ?? {};
          const updateDraft = (patch: Partial<typeof draft>) =>
            setDrafts((current) => ({ ...current, [workspace.id]: { ...draft, ...patch } }));
          return (
            <article
              key={workspace.id}
              className="min-w-0 rounded-xl border border-line bg-surface p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold">{workspace.name}</h2>
                  <p className="mt-1 font-mono text-xs text-ink-faint">/{workspace.slug}</p>
                </div>
                <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-xs font-semibold uppercase tracking-wide">
                  {workspace.status}
                </span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-ink-faint">Members</dt>
                  <dd className="font-semibold">{workspace.memberCount}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Owners</dt>
                  <dd className="truncate font-semibold">
                    {workspace.owners.map((owner) => owner.email ?? owner.userId).join(', ') ||
                      'None'}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Directories</dt>
                  <dd>
                    {workspace.domains
                      .map((domain) => `${domain.domain} (${domain.status})`)
                      .join(', ') || 'None'}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Providers</dt>
                  <dd>
                    {workspace.providers.map((provider) => provider.displayName).join(', ') ||
                      'None'}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  aria-label={`Administrative reason for ${workspace.name}`}
                  value={draft.reason ?? ''}
                  onChange={(event) => updateDraft({ reason: event.target.value })}
                  placeholder="Reason for access-changing actions"
                  className="rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm"
                />
                {workspace.status === 'active' ? (
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run(`${workspace.id}:suspend`, () =>
                        adminRequest(session.getCredentials, `/tenants/${workspace.id}/suspend`, {
                          method: 'POST',
                          body: { reason: draft.reason ?? '' },
                        }),
                      )
                    }
                    className="rounded-lg border border-critical-line px-3 py-2 text-sm font-semibold text-critical hover:bg-critical-soft disabled:opacity-60"
                  >
                    Suspend
                  </button>
                ) : workspace.status === 'suspended' ? (
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run(`${workspace.id}:reactivate`, () =>
                        adminRequest(
                          session.getCredentials,
                          `/tenants/${workspace.id}/reactivate`,
                          {
                            method: 'POST',
                          },
                        ),
                      )
                    }
                    className="rounded-lg bg-strong px-3 py-2 text-sm font-semibold text-on-strong disabled:opacity-60"
                  >
                    Reactivate
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run(`${workspace.id}:cancel`, () =>
                        adminRequest(
                          session.getCredentials,
                          `/tenants/${workspace.id}/cancel-deletion`,
                          {
                            method: 'POST',
                          },
                        ),
                      )
                    }
                    className="rounded-lg bg-strong px-3 py-2 text-sm font-semibold text-on-strong disabled:opacity-60"
                  >
                    Cancel deletion
                  </button>
                )}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <select
                  aria-label={`Binding provider for ${workspace.name}`}
                  value={draft.providerId ?? ''}
                  onChange={(event) => updateDraft({ providerId: event.target.value })}
                  className="rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm"
                >
                  <option value="">Choose staff provider</option>
                  {(query.data?.providers ?? [])
                    .filter((provider) => provider.status === 'active')
                    .map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.displayName}
                      </option>
                    ))}
                </select>
                <input
                  aria-label={`Binding claim for ${workspace.name}`}
                  value={draft.claimValue ?? ''}
                  onChange={(event) => updateDraft({ claimValue: event.target.value })}
                  placeholder="Tenant claim value"
                  className="rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(`${workspace.id}:binding`, () =>
                      adminRequest(session.getCredentials, `/tenants/${workspace.id}/bindings`, {
                        method: 'POST',
                        body: { providerId: draft.providerId, claimValue: draft.claimValue },
                      }),
                    )
                  }
                  className="rounded-lg border border-line-strong px-3 py-2 text-sm font-semibold disabled:opacity-60"
                >
                  Add binding
                </button>
              </div>
              {workspace.requireDirectory && (
                <div className="mt-3 rounded-lg border border-warning-line bg-warning-soft p-3 text-sm">
                  <p>
                    Workspace directory required. Clear this restriction only to recover owner
                    access. The reason is audited and owners are notified.
                  </p>
                  <button
                    type="button"
                    disabled={Boolean(busy) || !draft.reason?.trim()}
                    onClick={() => setClearingDirectory(workspace)}
                    className="mt-3 rounded-lg border border-warning-line bg-surface px-3 py-2 font-semibold text-warning disabled:opacity-60"
                  >
                    Clear directory requirement
                  </button>
                </div>
              )}
              {workspace.status === 'active' && (
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void startSupport(workspace)}
                  className="mt-3 w-full rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-sm font-semibold text-warning disabled:opacity-60"
                >
                  Open one-hour support session
                </button>
              )}
            </article>
          );
        })}
      </div>
    </AdminPage>
  );
}
