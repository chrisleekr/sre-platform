import { requestErrorMessage } from '../lib/request-error';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../auth';
import { workspaceSettingsRequest, type WorkspaceSettingsData } from '../lib/workspace-settings';
import { invalidateMe, useMe } from '../lib/me-store';
import { PageHeader } from './PageHeader';
import { InlineAlert, StatePanel } from './PageState';
import { WorkspaceSettingsNavigation } from './WorkspaceSettingsNavigation';

/** Workspace identity and delayed-deletion settings for members and owners. */
export function WorkspaceSettingsPage() {
  const session = useSession();
  const me = useMe(session.getCredentials, session.status === 'authenticated', session.sessionKey);
  const owner = me.data?.tenant?.role === 'owner';
  const canEdit = owner || me.data?.tenant?.role === 'admin';
  const [data, setData] = useState<WorkspaceSettingsData>();
  const [name, setName] = useState('');
  const [confirmSlug, setConfirmSlug] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    setError(undefined);
    try {
      const next = await workspaceSettingsRequest<WorkspaceSettingsData>(
        session.getCredentials,
        '/settings',
      );
      setData(next);
      setName(next.workspace.name);
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Workspace settings are unavailable.'));
    }
  }, [session.getCredentials]);
  useEffect(() => void load(), [load]);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await workspaceSettingsRequest(session.getCredentials, '/settings', {
        method: 'PUT',
        body: { name },
      });
      invalidateMe(session.sessionKey ?? null);
      await load();
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Workspace name could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  async function deleteWorkspace() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await workspaceSettingsRequest<{ deleteAfter: string }>(
        session.getCredentials,
        '/delete',
        { method: 'POST', body: { confirmSlug } },
      );
      setData((current) =>
        current
          ? {
              ...current,
              workspace: {
                ...current.workspace,
                status: 'deleting',
                deleteAfter: result.deleteAfter,
              },
            }
          : current,
      );
      setConfirming(false);
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Workspace deletion could not be scheduled.'));
    } finally {
      setBusy(false);
    }
  }

  async function cancelDeletion() {
    setBusy(true);
    setError(undefined);
    try {
      await workspaceSettingsRequest(session.getCredentials, '/cancel-deletion', {
        method: 'POST',
        body: { confirmSlug: data?.workspace.slug },
      });
      invalidateMe(session.sessionKey ?? null);
      await load();
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Workspace deletion could not be cancelled.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <PageHeader
        title="Workspace settings"
        description="Change the workspace name and control its lifecycle. The workspace address remains stable so links and sign-in bookmarks never break."
      />
      <WorkspaceSettingsNavigation />
      {error && <InlineAlert message={error} onRetry={data ? undefined : load} />}
      {!data && !error && (
        <StatePanel state="loading" title="Loading workspace settings…" skeleton="settings" />
      )}
      {data && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
          <form
            onSubmit={(event) => void saveName(event)}
            className="rounded-xl border border-line bg-surface p-5 sm:p-6"
          >
            <h2 className="font-instrument text-lg font-semibold text-ink">Identity</h2>
            <label htmlFor="workspace-settings-name" className="mt-5 block text-sm font-medium">
              Workspace name
            </label>
            <input
              id="workspace-settings-name"
              required
              maxLength={100}
              readOnly={!canEdit}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-sm"
            />
            <p className="mt-2 text-xs leading-5 text-ink-muted">
              Usually your team or company name. You can change it at any time.
            </p>
            <label htmlFor="workspace-settings-slug" className="mt-5 block text-sm font-medium">
              Workspace address
            </label>
            <input
              id="workspace-settings-slug"
              readOnly
              value={data.workspace.slug}
              className="mt-1 w-full rounded-lg border border-line bg-surface-subtle px-3 py-2.5 text-sm text-ink-muted"
            />
            <p className="mt-2 text-xs leading-5 text-ink-muted">
              Used in links and your sign-in page. It cannot be changed after the workspace is
              created.
            </p>
            {canEdit && (
              <button
                type="submit"
                disabled={busy || name.trim() === data.workspace.name || !name.trim()}
                className="mt-5 rounded-lg bg-strong px-4 py-2.5 text-sm font-semibold text-on-strong disabled:opacity-50"
              >
                Save name
              </button>
            )}
          </form>

          <aside className="h-fit rounded-xl border border-line bg-surface p-5 sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
              Workspace address
            </p>
            <p className="mt-2 break-all font-mono text-sm text-ink">/{data.workspace.slug}</p>
            <p className="mt-3 text-sm leading-6 text-ink-muted">
              Share this address with teammates when they need to sign in directly.
            </p>
          </aside>

          {owner && (
            <section className="rounded-xl border border-critical-line bg-critical-soft p-5 sm:p-6 xl:col-span-2">
              <h2 className="font-instrument text-lg font-semibold text-critical">
                Delete workspace
              </h2>
              {data.workspace.status === 'deleting' && data.workspace.deleteAfter ? (
                <>
                  <p className="mt-2 text-sm leading-6 text-critical">
                    Permanent deletion is scheduled for{' '}
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'long',
                      timeStyle: 'short',
                    }).format(new Date(data.workspace.deleteAfter))}
                    . Access is blocked until deletion is cancelled.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void cancelDeletion()}
                    className="mt-4 rounded-lg border border-critical-line bg-surface px-4 py-2.5 text-sm font-semibold text-critical disabled:opacity-50"
                  >
                    Cancel deletion
                  </button>
                </>
              ) : (
                <>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-critical">
                    Access stops immediately. The workspace and its incident history are permanently
                    removed after 14 days unless an owner or platform administrator cancels.
                  </p>
                  {!confirming ? (
                    <button
                      type="button"
                      onClick={() => setConfirming(true)}
                      className="mt-4 rounded-lg border border-critical-line bg-surface px-4 py-2.5 text-sm font-semibold text-critical"
                    >
                      Schedule deletion
                    </button>
                  ) : (
                    <div className="mt-5 max-w-xl rounded-lg border border-critical-line bg-surface p-4">
                      <label
                        htmlFor="confirm-workspace-delete"
                        className="text-sm font-semibold text-ink"
                      >
                        Type {data.workspace.slug} to confirm
                      </label>
                      <input
                        id="confirm-workspace-delete"
                        value={confirmSlug}
                        onChange={(event) => setConfirmSlug(event.target.value)}
                        className="mt-2 w-full rounded-lg border border-critical-line bg-canvas px-3 py-2.5 text-sm"
                      />
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy || confirmSlug !== data.workspace.slug}
                          onClick={() => void deleteWorkspace()}
                          className="rounded-lg bg-critical px-4 py-2.5 text-sm font-semibold text-on-critical disabled:opacity-50"
                        >
                          Confirm deletion
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(false)}
                          className="rounded-lg border border-line-strong px-4 py-2.5 text-sm font-semibold text-ink-secondary"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
