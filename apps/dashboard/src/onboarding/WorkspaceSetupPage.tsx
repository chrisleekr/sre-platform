import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useSession } from '../auth';
import { ApplicationLoadingSkeleton } from '../components/LoadingSkeleton';
import { clearSignInRetry, type SignInRetry } from '../lib/application-session';
import { useMe } from '../lib/me-store';
import { ConnectProviderPage } from './ConnectProviderPage';
import {
  readWorkspaceDraft,
  readWorkspaceSignIn,
  clearWorkspaceDraft,
  saveWorkspaceDraft,
  saveWorkspaceSignIn,
  type WorkspaceDraft,
} from './draft';
import { ReviewPage } from './ReviewPage';
import { SettingUpPage } from './SettingUpPage';
import { PublicShell, SetupProgress, primaryButton } from './shared';
import { WorkspaceIdentityPage } from './WorkspaceIdentityPage';
import { usePublicConfig } from './usePublicConfig';

type SetupView = 'workspace' | 'sign-in' | 'review' | 'progress';

const copy: Record<SetupView, { title: string; description: string; step: 1 | 2 | 3 }> = {
  workspace: {
    title: 'Create your workspace',
    description: 'A shared space for your team’s incident investigations.',
    step: 1,
  },
  'sign-in': {
    title: 'Connect company sign-in',
    description: 'Add your identity service, then sign in once to prove the connection works.',
    step: 2,
  },
  review: {
    title: 'Confirm and create',
    description: 'Review the saved details before SRE Platform creates the workspace.',
    step: 3,
  },
  progress: {
    title: 'Creating your workspace',
    description: 'This request is saved. You can close the page and return later.',
    step: 3,
  },
};

/** Presents the durable workspace founding lifecycle through one stable URL. */
export function WorkspaceSetupPage() {
  const publicConfig = usePublicConfig();
  const session = useSession();
  const me = useMe(
    session.getCredentials,
    session.status === 'authenticated',
    session.sessionKey,
    session.foundingId,
  );
  const serverDraft =
    me.data?.founding?.requestedName && me.data.founding.slug
      ? { requestedName: me.data.founding.requestedName, slug: me.data.founding.slug }
      : null;
  const [draft, setDraft] = useState<WorkspaceDraft | null>(() => readWorkspaceDraft());
  const [editing, setEditing] = useState<'workspace' | 'sign-in' | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const workspace = editing && draft ? draft : (serverDraft ?? draft);
  const founding = me.data?.founding;
  const serverContinuation =
    workspace && founding?.id && founding.provider?.id
      ? {
          slug: workspace.slug,
          retry: {
            providerId: founding.provider.id,
            foundingId: founding.id,
            returnTo: '/get-started',
          },
        }
      : null;
  const savedContinuation = workspace ? readWorkspaceSignIn(workspace.slug) : null;
  const continuation = serverContinuation ?? savedContinuation;
  const view: SetupView = editing
    ? editing
    : submitted ||
        (me.data?.state === 'founding' &&
          founding?.status !== 'awaiting_founder' &&
          founding?.status !== 'authenticating_founder' &&
          founding?.status !== 'founder_authenticated')
      ? 'progress'
      : me.data?.state === 'founding' && founding?.status === 'founder_authenticated'
        ? 'review'
        : workspace
          ? 'sign-in'
          : 'workspace';
  const heading = copy[view];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousView = useRef(view);

  useEffect(() => {
    if (previousView.current !== view) headingRef.current?.focus();
    previousView.current = view;
  }, [view]);
  useEffect(() => {
    if (me.data?.state !== 'active') return;
    clearWorkspaceDraft();
    clearSignInRetry();
  }, [me.data?.state]);

  const editWorkspace = () => {
    if (serverDraft) {
      saveWorkspaceDraft(serverDraft);
      setDraft(serverDraft);
    }
    setEditing('workspace');
  };
  const editSignIn = () => setEditing('sign-in');
  const handleEditingEnded = useCallback(() => {
    setEditing(null);
    me.refresh();
  }, [me.refresh]);
  const continueWorkspace = (next: WorkspaceDraft, recovered?: SignInRetry) => {
    const nextContinuation = recovered ?? continuation?.retry;
    saveWorkspaceDraft(next);
    if (nextContinuation) saveWorkspaceSignIn(next.slug, nextContinuation);
    setDraft(next);
    setEditing('sign-in');
  };

  if (session.status === 'loading') return <ApplicationLoadingSkeleton />;
  if (session.status === 'authenticated' && (me.loading || (!me.data && !me.error))) {
    return <ApplicationLoadingSkeleton />;
  }
  if (me.data?.state === 'active') return <Navigate to="/w" replace />;

  return (
    <PublicShell>
      {session.status !== 'authenticated' && (
        <Link to="/sign-in" className="mb-6 inline-block text-sm font-semibold text-info">
          Back to sign in
        </Link>
      )}
      <SetupProgress
        step={heading.step}
        onEditWorkspace={heading.step > 1 && view !== 'progress' ? editWorkspace : undefined}
        onEditSignIn={heading.step > 2 && view !== 'progress' ? editSignIn : undefined}
      />
      <header className="mb-7 max-w-3xl">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-3xl font-bold tracking-tight outline-none"
        >
          {heading.title}
        </h1>
        <p className="mt-2 text-sm leading-6 text-ink-muted">{heading.description}</p>
      </header>

      {publicConfig.value?.registrationMode === 'approval_required' && view !== 'progress' && (
        <p className="mb-6 rounded-lg border border-info-line bg-info-soft p-3 text-sm">
          Workspace creation requires administrator approval. You can configure and verify company
          sign-in before submitting your request.
        </p>
      )}
      {publicConfig.error && view !== 'progress' ? (
        <div role="alert">
          Workspace setup settings could not be loaded.{' '}
          <button
            type="button"
            className="font-semibold text-info underline"
            onClick={publicConfig.retry}
          >
            Try again
          </button>
        </div>
      ) : !publicConfig.value && view !== 'progress' ? (
        <p role="status">Loading workspace setup…</p>
      ) : publicConfig.value?.registrationMode === 'closed' && view !== 'progress' ? (
        <p role="alert">
          Workspace creation is unavailable. Ask your administrator for an invitation.
        </p>
      ) : me.error && session.status === 'authenticated' ? (
        <div role="alert" className="rounded-xl border border-warning-line bg-warning-soft p-5">
          <p className="font-semibold text-warning">Your saved setup could not be loaded.</p>
          <p className="mt-1 text-sm text-warning">Nothing was deleted. Try loading it again.</p>
          <button type="button" className={`${primaryButton} mt-4`} onClick={me.refresh}>
            Try again
          </button>
        </div>
      ) : view === 'workspace' ? (
        <WorkspaceIdentityPage onContinue={continueWorkspace} />
      ) : view === 'sign-in' && workspace ? (
        <>
          <section className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-surface-subtle p-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                Workspace
              </p>
              <p className="mt-1 font-semibold">{workspace.requestedName}</p>
              <p className="text-sm text-ink-muted">/{workspace.slug}</p>
            </div>
            <button
              type="button"
              className="text-sm font-semibold text-info underline"
              onClick={editWorkspace}
            >
              Edit
            </button>
          </section>
          <ConnectProviderPage
            workspace={workspace}
            continuation={continuation}
            onBack={editWorkspace}
            onEditingEnded={handleEditingEnded}
          />
        </>
      ) : view === 'review' ? (
        <ReviewPage
          workspace={workspace ?? undefined}
          onEditWorkspace={editWorkspace}
          onEditSignIn={editSignIn}
          onSubmitted={() => {
            setSubmitted(true);
            setEditing(null);
          }}
        />
      ) : (
        <SettingUpPage />
      )}
    </PublicShell>
  );
}
