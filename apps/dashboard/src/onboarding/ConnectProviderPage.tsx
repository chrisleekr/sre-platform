import { sessionFetch } from '../lib/session-fetch';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { messageForApiCode } from '../i18n/messages';
import {
  readWorkspaceDraft,
  readWorkspaceSignIn,
  saveWorkspaceSignIn,
  type WorkspaceDraft,
} from './draft';
import type { SignInRetry } from '../lib/application-session';
import { SavedSignInSettings } from './SavedSignInSettings';
import { SignInMethodSetup, type SignInMethodInput } from './SignInMethodSetup';

interface StartedFounding {
  founding: { id: string; status: string };
  provider: {
    id: string;
    issuer?: string;
    authorizationEndpoint?: string;
    browserClientId?: string;
  };
}

/** Connects the workspace draft to a validated public OIDC client. */
export function ConnectProviderPage({
  workspace,
  onContinue,
  continuation,
  onBack,
  onEditingEnded,
}: {
  workspace?: WorkspaceDraft;
  onContinue?: (result: StartedFounding) => void;
  continuation?: { slug: string; retry: SignInRetry } | null;
  onBack?: () => void;
  onEditingEnded?: () => void;
}) {
  const session = useSession();
  const draft = workspace ?? readWorkspaceDraft();
  const [created, setCreated] = useState<{ slug: string; retry: SignInRetry } | null>(() =>
    draft ? readWorkspaceSignIn(draft.slug) : null,
  );
  const saved =
    created?.slug === draft?.slug
      ? created
      : continuation?.slug === draft?.slug
        ? continuation
        : draft
          ? readWorkspaceSignIn(draft.slug)
          : null;

  async function connect(input: SignInMethodInput): Promise<void> {
    if (!draft) throw new Error('Start with your workspace name and address.');
    if (saved) {
      session.retrySignIn(saved.retry);
      return;
    }
    const response = await sessionFetch(`${config.apiBaseUrl}/foundings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'own_directory',
        ...draft,
        issuer: input.issuer,
        clientId: input.clientId,
        clientAuthentication: input.clientAuthentication,
        clientSecret: input.clientSecret,
        declaredDomain: input.domain,
      }),
    });
    const result = (await response.json().catch(() => null)) as
      | (StartedFounding & { code?: string; error?: string })
      | { code?: string; error?: string }
      | null;
    if (!response.ok || !result || !('founding' in result)) {
      throw new Error(result?.error ?? messageForApiCode(result?.code));
    }
    if (onContinue) {
      onContinue(result);
      return;
    }
    const retry = {
      providerId: result.provider.id,
      foundingId: result.founding.id,
      returnTo: '/get-started',
    };
    saveWorkspaceSignIn(draft.slug, retry);
    setCreated({ slug: draft.slug, retry });
    session.retrySignIn(retry);
  }

  return (
    <>
      {!draft ? (
        <div role="alert" className="rounded-xl border border-warning-line bg-warning-soft p-5">
          <p className="font-semibold text-warning">Workspace details are missing.</p>
          <p className="mt-1 text-sm text-warning">
            Name your workspace before connecting sign-in.
          </p>
          <Link className="mt-3 inline-block text-sm font-semibold underline" to="/get-started">
            Return to workspace details
          </Link>
        </div>
      ) : saved ? (
        <SavedSignInSettings
          key={saved.retry.foundingId}
          id={saved.retry.foundingId!}
          workspace={draft}
          retry={saved.retry}
          onBack={onBack}
          onEditingEnded={onEditingEnded}
        />
      ) : (
        <>
          <SignInMethodSetup
            submitLabel="Continue to sign in"
            onSubmit={connect}
            draftKey="sre.workspace-directory-draft"
            backTo={onBack ? undefined : '/get-started'}
            onBack={onBack}
          />
        </>
      )}
    </>
  );
}
