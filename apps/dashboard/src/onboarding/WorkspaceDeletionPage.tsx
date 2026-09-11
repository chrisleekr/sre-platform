import { requestErrorMessage } from '../lib/request-error';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { invalidateMe } from '../lib/me-store';
import { workspaceSettingsRequest } from '../lib/workspace-settings';
import { PublicShell, fieldClass, primaryButton } from './shared';

interface DeletingWorkspace {
  name: string;
  slug: string;
  deleteAfter: string;
  role: string;
}

/** Preserves the owner's cancellation path while general workspace access is suspended. */
export function WorkspaceDeletionPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<DeletingWorkspace[]>();
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void workspaceSettingsRequest<{ workspaces: DeletingWorkspace[] }>(
      session.getCredentials,
      '/deletion',
    )
      .then((result) => {
        if (live) setWorkspaces(result.workspaces);
      })
      .catch(() => {
        if (live) setError('Deletion details could not be loaded. Sign in again to retry.');
      });
    return () => {
      live = false;
    };
  }, [session.getCredentials]);

  async function cancel(event: FormEvent, slug: string) {
    event.preventDefault();
    if (busy || confirmation !== slug) return;
    setBusy(true);
    setError(undefined);
    try {
      await workspaceSettingsRequest(session.getCredentials, '/cancel-deletion', {
        method: 'POST',
        body: { confirmSlug: slug },
      });
      invalidateMe(session.sessionKey ?? null);
      navigate('/w', { replace: true });
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Deletion could not be cancelled.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicShell>
      <h1 className="text-2xl font-bold">Workspace scheduled for deletion</h1>
      <p className="mt-2 text-sm leading-6 text-ink-muted">
        Access is paused. An owner can cancel before the date below to restore the workspace.
      </p>
      {!workspaces && !error && (
        <p role="status" className="mt-5">
          Loading deletion details…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-5 text-critical">
          {error}
        </p>
      )}
      {workspaces?.map((workspace) => (
        <section
          key={workspace.slug}
          className="mt-5 rounded-xl border border-warning-line bg-warning-soft p-5"
        >
          <h2 className="font-semibold">{workspace.name}</h2>
          <p className="mt-2 text-sm">
            Permanent deletion:{' '}
            {new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(
              new Date(workspace.deleteAfter),
            )}
          </p>
          {workspace.role === 'owner' && Date.parse(workspace.deleteAfter) > Date.now() && (
            <form onSubmit={(event) => void cancel(event, workspace.slug)} className="mt-4">
              <label className="text-sm font-medium">
                Type {workspace.slug} to cancel deletion
                <input
                  className={fieldClass}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              <button
                className={`${primaryButton} mt-3`}
                disabled={busy || confirmation !== workspace.slug}
              >
                {busy ? 'Restoring workspace…' : 'Cancel deletion'}
              </button>
            </form>
          )}
        </section>
      ))}
      {workspaces?.length === 0 && (
        <p className="mt-5">No workspace awaiting deletion is available to this account.</p>
      )}
      <Link to="/sign-in" className="mt-6 inline-block text-sm font-semibold underline">
        Back to sign in
      </Link>
    </PublicShell>
  );
}
