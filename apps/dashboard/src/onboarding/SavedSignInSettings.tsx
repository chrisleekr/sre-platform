import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { sessionFetch } from '../lib/session-fetch';
import { clearSignInRetry, type SignInRetry } from '../lib/application-session';
import { clearWorkspaceDraft, saveWorkspaceSignIn, type WorkspaceDraft } from './draft';
import {
  SignInMethodSetup,
  type SignInMethodDraft,
  type SignInMethodInput,
} from './SignInMethodSetup';
import { SignInStartNotice } from './SignInStartNotice';
import { primaryButton } from './shared';

interface SavedSetup extends Omit<SignInMethodDraft, 'preset'> {
  requestedName: string;
  slug: string;
  providerId: string;
  secretStored: boolean;
}

/** Keeps a saved setup editable in the normal second step, without replaying registration.
 * @param id - Existing request, verified against the browser's editing permission.
 * @param workspace - Workspace details from the preceding wizard step.
 * @param retry - Non-secret route back through the saved provider and setup request.
 */
export function SavedSignInSettings({
  id,
  workspace,
  retry,
  onBack,
  onEditingEnded,
}: {
  id: string;
  workspace: WorkspaceDraft;
  retry: SignInRetry;
  onBack?: () => void;
  onEditingEnded?: () => void;
}) {
  const session = useSession();
  const navigate = useNavigate();
  const [saved, setSaved] = useState<SavedSetup>();
  const [error, setError] = useState<string>();
  const [editingEnded, setEditingEnded] = useState(false);
  const [generation, setGeneration] = useState(0);
  const abandonSetup = () => {
    clearWorkspaceDraft();
    clearSignInRetry();
  };
  useEffect(() => {
    let live = true;
    setError(undefined);
    setEditingEnded(false);
    void sessionFetch(`${config.apiBaseUrl}/foundings/${encodeURIComponent(id)}/draft`)
      .then(async (response) => {
        const body = await response.json();
        if (response.status === 409 && body.code === 'setup_in_progress') {
          if (live) setEditingEnded(true);
          return;
        }
        if (!response.ok) throw new Error(body.error ?? 'Saved settings could not be loaded.');
        if (live) setSaved(body);
      })
      .catch((cause) => {
        if (live)
          setError(cause instanceof Error ? cause.message : 'Saved settings are unavailable.');
      });
    return () => {
      live = false;
    };
  }, [id, generation]);
  useEffect(() => {
    if (editingEnded && session.status === 'authenticated' && session.foundingId === id) {
      if (onEditingEnded) onEditingEnded();
      else navigate('/get-started', { replace: true });
    }
  }, [editingEnded, id, navigate, onEditingEnded, session.foundingId, session.status]);
  async function save(input: SignInMethodInput) {
    if (!saved) return;
    let providerId = saved.providerId;
    const unchanged =
      !input.clientSecret &&
      workspace.requestedName === saved.requestedName &&
      workspace.slug === saved.slug &&
      input.issuer === saved.issuer &&
      input.clientId === saved.clientId &&
      input.clientAuthentication === saved.clientAuthentication &&
      input.domain === saved.domain;
    if (!unchanged) {
      const response = await sessionFetch(
        `${config.apiBaseUrl}/foundings/${encodeURIComponent(id)}/draft`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...input,
            ...workspace,
            declaredDomain: input.domain,
            providerId,
            keepSecret:
              input.clientAuthentication !== 'none' && !input.clientSecret && saved.secretStored,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Settings could not be saved.');
      providerId = body.providerId;
      setSaved({
        ...saved,
        ...workspace,
        ...input,
        providerId,
        secretStored: input.clientAuthentication !== 'none',
      });
    }
    const next = { providerId, foundingId: id, returnTo: '/get-started' };
    saveWorkspaceSignIn(workspace.slug, next);
    session.retrySignIn(next);
  }
  if (error)
    return (
      <div role="alert" className="space-y-3 text-critical">
        <p>{error}</p>
        <button
          type="button"
          className="underline"
          onClick={() => setGeneration((value) => value + 1)}
        >
          Retry loading settings
        </button>
        <p>
          <Link to="/get-started" onClick={abandonSetup} className="underline">
            Start a new setup
          </Link>
        </p>
      </div>
    );
  if (editingEnded)
    return (
      <div role="status" className="space-y-4">
        <p>This setup has moved beyond editable sign-in settings.</p>
        {(session.error || session.isStarting) && (
          <SignInStartNotice
            error={session.error}
            pending={session.isStarting}
            onRetry={() => session.retrySignIn({ ...retry, returnTo: '/get-started' })}
          />
        )}
        {session.status === 'authenticated' && session.foundingId === id ? (
          <p className="text-sm text-ink-muted">Continuing to setup progress…</p>
        ) : (
          <button
            type="button"
            className={primaryButton}
            disabled={session.isStarting}
            onClick={() => session.retrySignIn({ ...retry, returnTo: '/get-started' })}
          >
            {session.isStarting ? 'Opening sign-in…' : 'Continue saved setup'}
          </button>
        )}
        <p>
          <Link to="/get-started" onClick={abandonSetup} className="text-sm underline">
            Start a new setup
          </Link>
        </p>
      </div>
    );
  if (!saved) return <p role="status">Loading saved settings…</p>;
  return (
    <>
      <p className="mb-4 text-sm text-ink-muted">
        Your settings are saved. Correct anything below, then continue. This updates the same
        workspace setup.
      </p>
      {(session.error || session.isStarting) && (
        <SignInStartNotice error={session.error} pending={session.isStarting} />
      )}
      <SignInMethodSetup
        key={saved.providerId}
        initial={{
          ...saved,
          preset: new URL(saved.issuer).hostname.endsWith('.auth0.com') ? 'auth0' : 'other',
        }}
        secretStored={saved.secretStored}
        submitLabel="Continue to sign in"
        onSubmit={save}
        backTo={onBack ? undefined : '/get-started'}
        onBack={onBack}
        busy={session.isStarting}
      />
    </>
  );
}
