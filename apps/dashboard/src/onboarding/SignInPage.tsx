import { sessionFetch } from '../lib/session-fetch';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { MESSAGES, messageForApiCode } from '../i18n/messages';
import type { OidcProvider } from '../lib/oidc-types';
import { fieldClass, primaryButton } from './shared';
import { EntryLayout } from './EntryLayout';
import { usePublicConfig } from './usePublicConfig';
import { CompanySignInOptions } from './CompanySignInOptions';
import type { PublicIdentityProvider } from '../lib/public-config';
import { clearSignInRetry, readSignInRetry } from '../lib/application-session';
import { readFounderSignIn } from '../lib/founder-sign-in';
import {
  clearWorkspaceDraft,
  readWorkspaceDraft,
  readWorkspaceSignIn,
  saveWorkspaceSignIn,
} from './draft';

interface DiscoveryProvider {
  id: string;
  displayName: string;
  issuer: string;
  authorizationEndpoint: string;
  browserClientId: string;
  authorizationScopes?: string[];
  authorizationAudience?: string | null;
}

function browserMethod(provider: DiscoveryProvider): OidcProvider {
  return {
    providerId: provider.id,
    issuer: provider.issuer,
    authorizationEndpoint: provider.authorizationEndpoint,
    clientId: provider.browserClientId,
    scopes: [...new Set(['openid', 'email', 'profile', ...(provider.authorizationScopes ?? [])])],
    authorizationAudience: provider.authorizationAudience,
  };
}

/** Public work-email discovery without account-existence disclosure. */
export function SignInPage({ authNotice }: { authNotice?: string }) {
  const publicConfig = usePublicConfig();
  const { loginLocally, signInWith, retrySignIn, isStarting, error: sessionError } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = (location.state as { from?: string } | null)?.from ?? '/w/select';
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);
  const [notice, setNotice] = useState<string>();
  const [discoveredProviders, setDiscoveredProviders] = useState<PublicIdentityProvider[]>();
  const [discoveryError, setDiscoveryError] = useState<string>();
  const [setupEnded, setSetupEnded] = useState(false);
  const [setupEditable, setSetupEditable] = useState(false);
  const callbackError = (location.state as { error?: string } | null)?.error;
  const retry = readSignInRetry();
  const setupDraft = readWorkspaceDraft();
  const setupSlug = setupDraft?.slug;
  const savedSetup = setupSlug ? readWorkspaceSignIn(setupSlug) : null;
  const setupMatchesFounding = Boolean(
    retry?.foundingId && savedSetup?.retry.foundingId === retry.foundingId,
  );
  const setupMatchesRetry =
    setupMatchesFounding && savedSetup?.retry.providerId === retry?.providerId;
  const [setupCheck, setSetupCheck] = useState<'none' | 'checking' | 'valid' | 'unavailable'>(
    retry?.foundingId ? 'checking' : 'none',
  );
  const [validatedRetry, setValidatedRetry] = useState<typeof retry>(null);
  const [setupCheckGeneration, setSetupCheckGeneration] = useState(0);

  useEffect(() => {
    if (!retry?.foundingId) {
      setSetupCheck('none');
      return;
    }
    let live = true;
    setSetupCheck('checking');
    void sessionFetch(
      `${config.apiBaseUrl}/foundings/${encodeURIComponent(retry.foundingId)}/draft`,
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          code?: string;
          providerId?: string;
        } | null;
        const resumable =
          response.ok ||
          (response.status === 409 &&
            (body?.code === 'setup_in_progress' ||
              body?.code === 'setup_authentication_in_progress'));
        if (!live) return;
        if (resumable) {
          if (typeof body?.providerId !== 'string') {
            setValidatedRetry(null);
            setSetupCheck('unavailable');
            return;
          }
          const current = { ...retry, providerId: body.providerId, returnTo: '/get-started' };
          if (setupSlug && setupMatchesFounding && !setupMatchesRetry) {
            saveWorkspaceSignIn(setupSlug, current);
          }
          setValidatedRetry(current);
          setSetupEditable(response.ok);
          setSetupCheck('valid');
          return;
        }
        const terminal =
          [400, 403, 404, 410].includes(response.status) ||
          body?.code === 'setup_expired' ||
          body?.code === 'setup_unavailable';
        if (terminal) {
          setSetupEnded(true);
          clearSignInRetry();
          if (setupMatchesFounding) clearWorkspaceDraft();
          setValidatedRetry(null);
          setSetupCheck('none');
        } else {
          setValidatedRetry(null);
          setSetupCheck('unavailable');
        }
      })
      .catch(() => {
        if (live) setSetupCheck('unavailable');
      });
    return () => {
      live = false;
    };
  }, [
    retry?.foundingId,
    retry?.providerId,
    setupCheckGeneration,
    setupSlug,
    setupMatchesFounding,
    setupMatchesRetry,
  ]);

  async function discover(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setNotice(undefined);
    setDiscoveryError(undefined);
    setDiscoveredProviders(undefined);
    const controller = new AbortController();
    attempt.current = controller;
    try {
      if (await loginLocally(email, controller.signal)) {
        // Publishing the session can unmount this form before navigation completes.
        navigate(returnTo, { replace: true });
        return;
      }
      controller.signal.throwIfAborted();
      const founder = readFounderSignIn(email);
      if (founder) {
        retrySignIn({
          providerId: founder.providerId,
          foundingId: founder.foundingId,
          returnTo,
        });
        return;
      }
      const response = await sessionFetch(`${config.apiBaseUrl}/auth/discover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as {
        kind?: string;
        provider?: DiscoveryProvider;
        providers?: DiscoveryProvider[];
        code?: string;
      } | null;
      controller.signal.throwIfAborted();
      if (!response.ok) throw new Error(messageForApiCode(body?.code));
      if (['directory', 'signup', 'installation'].includes(body?.kind ?? '') && body?.provider) {
        signInWith(browserMethod(body.provider), returnTo);
        return;
      }
      if (body?.kind === 'choose_provider' && body.providers?.length) {
        setDiscoveredProviders(
          body.providers.map((provider) => ({
            providerId: provider.id,
            displayName: provider.displayName,
            issuer: provider.issuer,
            browserClientId: provider.browserClientId,
            authorizationEndpoint: provider.authorizationEndpoint,
            scopes: [
              ...new Set(['openid', 'email', 'profile', ...(provider.authorizationScopes ?? [])]),
            ],
            authorizationAudience: provider.authorizationAudience,
          })),
        );
      }
      setNotice(
        body?.kind === 'choose_provider'
          ? 'Choose your company account to continue.'
          : 'We could not find company sign-in for this email. Open your workspace invitation, or ask your administrator for a sign-in link.',
      );
    } catch (cause) {
      if (controller.signal.aborted) return;
      setDiscoveryError(cause instanceof Error ? cause.message : MESSAGES.genericFailure);
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <EntryLayout
      productName={publicConfig.value?.productName}
      description={publicConfig.value?.productValueLine}
    >
      <h1 className="text-2xl font-bold">Sign in</h1>
      {(authNotice || callbackError || sessionError) && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-warning-line bg-warning-soft p-4 text-sm text-warning"
        >
          <p>{authNotice ?? callbackError ?? sessionError}</p>
        </div>
      )}
      {validatedRetry?.foundingId && setupCheck === 'valid' && (
        <section className="mt-5 rounded-xl border border-info-line bg-info-soft p-4">
          <p className="font-semibold">Resume workspace setup</p>
          <p className="mt-1 text-sm leading-6 text-ink-muted">
            {setupMatchesFounding && setupDraft
              ? `Continue setting up ${setupDraft.requestedName}. Your saved request is unchanged.`
              : 'This browser has a saved setup. Continue with the same company sign-in method.'}
          </p>
          <button
            type="button"
            disabled={pending || isStarting}
            className={`${primaryButton} mt-3`}
            onClick={() =>
              setupMatchesFounding && setupEditable && !authNotice
                ? navigate('/get-started')
                : retrySignIn(validatedRetry)
            }
          >
            {isStarting ? 'Opening sign-in…' : 'Continue setup'}
          </button>
          <button
            type="button"
            className="ml-4 text-sm font-semibold text-info underline"
            onClick={() => {
              clearSignInRetry();
              if (setupMatchesFounding) clearWorkspaceDraft();
              navigate('/get-started');
            }}
          >
            Start a different setup
          </button>
        </section>
      )}
      {setupCheck === 'checking' && (
        <p role="status" className="mt-5 text-sm text-ink-muted">
          Checking your saved workspace setup…
        </p>
      )}
      {setupCheck === 'unavailable' && (
        <div role="alert" className="mt-5 rounded-lg border border-warning-line p-4 text-sm">
          <p>Your saved setup could not be checked. It has not been removed.</p>
          <button
            type="button"
            className="mt-2 font-semibold text-info underline"
            onClick={() => setSetupCheckGeneration((value) => value + 1)}
          >
            Check again
          </button>
        </div>
      )}
      {setupEnded && (
        <p role="status" className="mt-4 text-sm text-warning">
          Your previous setup is no longer available. Create a workspace to start again, or sign in
          if it was already created.
        </p>
      )}
      <p className="mt-2 text-sm text-ink-muted">Enter your work email to continue.</p>
      <form className="mt-6" onSubmit={discover}>
        <label className="text-sm font-medium" htmlFor="work-email">
          Work email
        </label>
        <input
          id="work-email"
          type="email"
          required
          autoComplete="email"
          disabled={pending || isStarting}
          className={fieldClass}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setDiscoveredProviders(undefined);
            setNotice(undefined);
          }}
        />
        <button
          type="submit"
          disabled={pending || isStarting}
          className={`${primaryButton} mt-4 w-full`}
        >
          {pending ? 'Signing in…' : isStarting ? 'Opening sign-in…' : 'Continue'}
        </button>
      </form>
      {discoveryError && (
        <p role="alert" className="mt-3 text-sm text-critical">
          {discoveryError} Try again using Continue.
        </p>
      )}
      {notice && (
        <p className="mt-5 rounded-lg border border-line p-4 text-sm leading-relaxed" role="status">
          {notice}
        </p>
      )}
      {discoveredProviders && (
        <CompanySignInOptions providers={discoveredProviders} returnTo={returnTo} />
      )}
      {setupCheck !== 'valid' && (
        <section className="mt-6 border-t border-line pt-5">
          {publicConfig.error ? (
            <div role="alert" className="text-sm">
              Sign-in and workspace creation settings could not be loaded.{' '}
              <button
                type="button"
                onClick={publicConfig.retry}
                className="font-semibold text-info underline"
              >
                Try again
              </button>
            </div>
          ) : !publicConfig.value ? (
            <p role="status" className="text-sm text-ink-muted">
              Checking workspace creation availability…
            </p>
          ) : publicConfig.value.registrationMode === 'closed' ? (
            <p className="text-sm text-ink-muted">
              Workspace creation is unavailable. Ask your administrator for an invitation.
            </p>
          ) : (
            <>
              <h2 className="font-semibold">Setting up for your team?</h2>
              <Link
                to="/get-started"
                className="mt-3 inline-flex rounded-lg border border-line-strong px-4 py-2.5 text-sm font-semibold"
              >
                {setupDraft ? 'Continue workspace setup' : 'Create a workspace'}
              </Link>
              <p className="mt-2 text-sm text-ink-muted">
                Connect your company sign-in and bring your team together.
                {publicConfig.value.registrationMode === 'approval_required' &&
                  ' Workspace creation requires administrator approval.'}
              </p>
            </>
          )}
        </section>
      )}
      {publicConfig.value?.supportUrl && (
        <a href={publicConfig.value.supportUrl} className="mt-4 block text-sm text-info underline">
          Contact support
        </a>
      )}
      {publicConfig.value?.privacyUrl && (
        <a
          href={publicConfig.value.privacyUrl}
          className="mt-4 block text-sm text-ink-muted underline"
        >
          Privacy
        </a>
      )}
    </EntryLayout>
  );
}
