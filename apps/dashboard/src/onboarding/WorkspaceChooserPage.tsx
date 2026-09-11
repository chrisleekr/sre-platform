import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { browserSessionRequest } from '../lib/application-session';
import { useSession } from '../auth';
import { useMe, nextWorkspaceRoute, WorkspaceStatusError } from '../lib/me-store';
import { SkeletonBlock } from '../components/LoadingSkeleton';
import { PublicShell, primaryButton } from './shared';

/** Chooses from authenticated memberships without granting access from an email or URL. */
export function WorkspaceChooserPage() {
  const session = useSession();
  const [opening, setOpening] = useState<string>();
  const [selectionError, setSelectionError] = useState<string>();
  async function openWorkspace(tenantId: string) {
    setOpening(tenantId);
    setSelectionError(undefined);
    try {
      await browserSessionRequest('workspace', { tenantId });
      // A full navigation drops tenant-scoped caches and open connections together.
      window.location.assign('/w');
    } catch (error) {
      setSelectionError(
        error instanceof Error ? error.message : 'The workspace could not be opened. Try again.',
      );
      setOpening(undefined);
      me.refresh();
    }
  }
  const me = useMe(
    session.getCredentials,
    session.status === 'authenticated',
    session.sessionKey,
    session.foundingId,
  );
  const [params] = useSearchParams();
  const selected = params.get('workspace');
  const switching = params.get('switch') === 'true';
  if (me.error instanceof WorkspaceStatusError && me.error.status === 401)
    return <Navigate to="/sign-in" replace />;
  if (me.error)
    return (
      <PublicShell entry>
        <div className="mx-auto max-w-xl rounded-xl border border-line bg-surface p-6">
          <h1 className="text-2xl font-bold">Choose a workspace</h1>
          <p role="alert" className="mt-3 text-ink-muted">
            Your workspaces could not be loaded.
          </p>
          <button type="button" className={`${primaryButton} mt-4`} onClick={me.refresh}>
            Try again
          </button>
        </div>
      </PublicShell>
    );
  if (!me.data)
    return (
      <PublicShell entry>
        <div role="status" aria-label="Loading workspaces" className="mx-auto max-w-xl space-y-4">
          <SkeletonBlock className="h-8 w-64 max-w-full" />
          <SkeletonBlock className="h-4 w-48 max-w-full" />
          <SkeletonBlock className="h-28 w-full rounded-xl" />
        </div>
      </PublicShell>
    );
  const { tenant, workspaces = [] } = me.data;
  if (selected && me.data.state === 'active' && tenant?.id === selected)
    return <Navigate to="/w" replace />;
  if (!selected && !switching && workspaces.length <= 1) {
    const target = nextWorkspaceRoute(me.data);
    if (target !== '/w/select') return <Navigate to={target} replace />;
  }
  return (
    <PublicShell entry>
      <div className="mx-auto max-w-xl sm:pt-6">
        <h1 className="text-3xl font-bold">Choose a workspace</h1>
        <p className="mt-2 text-sm text-ink-muted">
          {me.data.user.email ? `Signed in as ${me.data.user.email}` : 'You are signed in.'}
        </p>
        {selected && (
          <p role="alert" className="mt-5 text-sm text-warning">
            This sign-in did not open the selected workspace. Use its required company account, or
            ask its administrator to check your access.
          </p>
        )}
        {selectionError && (
          <p role="alert" className="mt-5 text-sm text-critical">
            {selectionError}
          </p>
        )}
        <div className="mt-7 space-y-3">
          {workspaces.map((workspace) => {
            const current = me.data!.state === 'active' && tenant?.id === workspace.id;
            const available = !workspace.status || workspace.status === 'active';
            return (
              <section
                key={workspace.id}
                aria-label={workspace.name}
                className="rounded-xl border border-line bg-surface p-5 sm:p-6"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold">{workspace.name}</h2>
                    <p className="mt-1 text-sm capitalize text-ink-muted">
                      {workspace.role}
                      {!available && ` · ${workspace.status}`}
                    </p>
                  </div>
                  {available && !current && workspace.canSelect ? (
                    <button
                      type="button"
                      aria-label={`Open ${workspace.name}`}
                      disabled={Boolean(opening)}
                      onClick={() => void openWorkspace(workspace.id)}
                      className={`${primaryButton} shrink-0 text-center`}
                    >
                      {opening === workspace.id ? 'Opening…' : 'Open workspace'}{' '}
                      <span aria-hidden="true" className="ml-2">
                        →
                      </span>
                    </button>
                  ) : (
                    available &&
                    (current || workspace.signInAvailable !== false) && (
                      <Link
                        to={current ? '/w' : `/${encodeURIComponent(workspace.slug)}`}
                        state={current ? undefined : { selectWorkspace: true }}
                        aria-label={`Open ${workspace.name}`}
                        className={`${primaryButton} shrink-0 text-center`}
                      >
                        Open workspace{' '}
                        <span aria-hidden="true" className="ml-2">
                          →
                        </span>
                      </Link>
                    )
                  )}
                </div>
                {available &&
                  !current &&
                  !workspace.canSelect &&
                  workspace.signInAvailable === false && (
                    <p className="mt-3 text-sm text-warning">
                      Sign-in is not configured.{' '}
                      {me.data!.user.isPlatformAdmin
                        ? 'Configure a provider in Platform administration.'
                        : 'Ask your workspace administrator to configure sign-in.'}
                    </p>
                  )}
              </section>
            );
          })}
        </div>
        {!workspaces.length && !me.data.user.isPlatformAdmin && (
          <p className="mt-6 text-sm text-ink-muted">
            This account has no workspace memberships yet. Open an invitation from your team.
          </p>
        )}
        {me.data.user.isPlatformAdmin && (
          <Link
            to="/admin"
            className="mt-6 flex items-center justify-between gap-4 rounded-xl border border-line bg-surface p-5 text-ink hover:bg-surface-subtle sm:p-6"
          >
            <span>
              <span className="block font-semibold">Platform administration</span>
              <span className="mt-1 block text-sm text-ink-muted">
                Manage workspaces, people and sign-in.
              </span>
            </span>
            <span aria-hidden="true">→</span>
          </Link>
        )}
        <button
          type="button"
          onClick={() => session.logout('/sign-in')}
          className="mt-6 min-h-11 text-sm font-medium text-ink-muted underline decoration-line underline-offset-4 hover:text-ink"
        >
          Sign out
        </button>
      </div>
    </PublicShell>
  );
}
