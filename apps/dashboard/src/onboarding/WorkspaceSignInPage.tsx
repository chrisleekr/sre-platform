import { sessionFetch } from '../lib/session-fetch';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useLocation } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { MESSAGES, messageForApiCode } from '../i18n/messages';
import type { OidcProvider } from '../lib/oidc-types';
import { PublicShell, primaryButton } from './shared';
import { usePublicConfig } from './usePublicConfig';
import { readSignInRetry } from '../lib/application-session';
import { saveWorkspaceDraft, saveWorkspaceSignIn } from './draft';
import { SignInStartNotice } from './SignInStartNotice';

interface SignInMethod {
  providerId: string;
  displayName: string;
  issuer: string;
  authorizationEndpoint: string;
  browserClientId: string;
  authorizationScopes?: string[];
  authorizationAudience?: string | null;
}

function oidcMethod(method: SignInMethod): OidcProvider {
  return {
    providerId: method.providerId,
    issuer: method.issuer,
    authorizationEndpoint: method.authorizationEndpoint,
    clientId: method.browserClientId,
    scopes: [...new Set(['openid', 'email', 'profile', ...(method.authorizationScopes ?? [])])],
    authorizationAudience: method.authorizationAudience,
  };
}

/** Public workspace-address sign-in page. */
export function WorkspaceSignInPage() {
  const { slug = '' } = useParams();
  const location = useLocation();
  const {
    signInWith,
    signInFounding,
    retrySignIn,
    isStarting,
    status: sessionStatus,
    error: sessionError,
  } = useSession();
  const publicConfig = usePublicConfig();
  const [result, setResult] = useState<{
    requestedSlug: string;
    workspace: { id: string; name: string; status: string; deleteAfter?: string | null };
    methods: SignInMethod[];
    setup?: { foundingId: string; provider: SignInMethod; returnTo?: string } | null;
  }>();
  const [error, setError] = useState<string>();
  const [ownedSetup, setOwnedSetup] = useState<{
    requestedName: string;
    slug: string;
    foundingId: string;
    providerId: string;
  }>();
  const startedMethod = useRef<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setError(undefined);
    setOwnedSetup(undefined);
    void (async () => {
      const response = await sessionFetch(
        `${config.apiBaseUrl}/workspaces/${encodeURIComponent(slug)}/sign-in-methods`,
      );
      const body = (await response.json().catch(() => null)) as
        | {
            workspace: { id: string; name: string; status: string; deleteAfter?: string | null };
            methods: SignInMethod[];
            setup?: { foundingId: string; provider: SignInMethod; returnTo?: string } | null;
            code?: string;
          }
        | { code?: string }
        | null;
      if (response.ok && body && 'workspace' in body) {
        if (live) setResult({ ...body, requestedSlug: slug });
        return;
      }
      if (response.status === 404) {
        const setupResponse = await sessionFetch(
          `${config.apiBaseUrl}/workspace-setup-drafts/${encodeURIComponent(slug)}`,
        );
        const setup = (await setupResponse.json().catch(() => null)) as {
          requestedName?: unknown;
          slug?: unknown;
          foundingId?: unknown;
          providerId?: unknown;
        } | null;
        if (
          setupResponse.ok &&
          typeof setup?.requestedName === 'string' &&
          typeof setup.slug === 'string' &&
          typeof setup.foundingId === 'string' &&
          typeof setup.providerId === 'string'
        ) {
          if (live)
            setOwnedSetup({
              requestedName: setup.requestedName,
              slug: setup.slug,
              foundingId: setup.foundingId,
              providerId: setup.providerId,
            });
          return;
        }
      }
      throw new Error(messageForApiCode(body?.code));
    })().catch((cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : MESSAGES.genericFailure);
    });
    return () => {
      live = false;
    };
  }, [slug]);
  const currentResult = result?.requestedSlug === slug ? result : undefined;
  const methods = useMemo(() => currentResult?.methods ?? [], [currentResult]);
  const destination =
    (location.state as { selectWorkspace?: boolean } | null)?.selectWorkspace &&
    currentResult?.workspace.id
      ? `/w/select?workspace=${encodeURIComponent(currentResult.workspace.id)}`
      : '/w';
  const deleting = currentResult?.workspace.status === 'deleting';
  const retry = readSignInRetry();
  const matchingRetry =
    retry &&
    (methods.some((method) => method.providerId === retry.providerId) ||
      (currentResult?.setup?.provider.providerId === retry.providerId &&
        currentResult.setup.foundingId === retry.foundingId));
  useEffect(() => {
    const method = methods[0];
    const key = method ? `${slug}:${method.providerId}` : undefined;
    if (
      currentResult?.workspace.status === 'active' &&
      methods.length === 1 &&
      key &&
      startedMethod.current !== key
    ) {
      startedMethod.current = key;
      signInWith(oidcMethod(methods[0]!), destination);
    }
  }, [currentResult, methods, signInWith, slug, destination]);

  return (
    <PublicShell>
      <h1 className="text-2xl font-bold">
        {currentResult?.workspace.name ?? 'Sign in to your workspace'}
      </h1>
      {error && (
        <p role="alert" className="mt-4 text-critical">
          {error}
        </p>
      )}
      {ownedSetup && (
        <section className="mt-6 rounded-xl border border-info-line bg-info-soft p-5">
          <h2 className="font-semibold">Finish setting up {ownedSetup.requestedName}</h2>
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            This browser created the saved workspace request. Continue to correct its settings or
            finish company sign-in.
          </p>
          <Link
            to="/get-started"
            className={`${primaryButton} mt-4 inline-flex`}
            onClick={() => {
              saveWorkspaceDraft({
                requestedName: ownedSetup.requestedName,
                slug: ownedSetup.slug,
              });
              saveWorkspaceSignIn(ownedSetup.slug, {
                providerId: ownedSetup.providerId,
                foundingId: ownedSetup.foundingId,
                returnTo: '/get-started',
              });
            }}
          >
            Resume setup
          </Link>
        </section>
      )}
      {matchingRetry && (sessionError || isStarting) && (
        <SignInStartNotice
          error={sessionError}
          pending={isStarting}
          onRetry={() => retrySignIn(retry!)}
        />
      )}
      {currentResult && currentResult.workspace.status !== 'active' && (
        <p role="alert" className="mt-4 text-warning">
          {currentResult.workspace.status === 'deleting' && currentResult.workspace.deleteAfter
            ? `This workspace is scheduled for deletion on ${new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(currentResult.workspace.deleteAfter))}.`
            : `This workspace is ${currentResult.workspace.status}.`}
          {publicConfig.value?.supportUrl && (
            <>
              {' '}
              <a className="underline" href={publicConfig.value.supportUrl}>
                Contact support
              </a>
            </>
          )}
        </p>
      )}
      {currentResult?.setup && (
        <section className="mt-6 space-y-4">
          <p className="text-sm text-ink-muted">
            Domain verification is pending. The account that created this workspace can sign in to
            finish setup.
          </p>
          <button
            type="button"
            className={primaryButton}
            disabled={isStarting}
            onClick={() =>
              signInFounding(
                oidcMethod(currentResult.setup!.provider),
                currentResult.setup!.foundingId,
                currentResult.setup!.returnTo ?? '/get-started',
              )
            }
          >
            Resume workspace setup
          </button>
        </section>
      )}
      {currentResult?.workspace.status === 'active' &&
        methods.length === 0 &&
        !currentResult.setup && (
          <div role="alert" className="mt-6 space-y-3 text-warning">
            <p>
              Sign-in is not configured for this workspace. Ask its administrator to connect a
              sign-in provider.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                className="underline"
                to={sessionStatus === 'authenticated' ? '/w/select?switch=true' : '/sign-in'}
              >
                {sessionStatus === 'authenticated' ? 'Back to your workspaces' : 'Back to sign in'}
              </Link>
              {publicConfig.value?.supportUrl && (
                <a className="underline" href={publicConfig.value.supportUrl}>
                  Contact support
                </a>
              )}
            </div>
          </div>
        )}
      {deleting && (
        <p className="mt-5 text-sm text-ink-muted">
          Workspace owner? Sign in to cancel deletion during the grace period.
          {methods.length === 0 && (
            <Link to="/sign-in" className="ml-2 font-semibold underline">
              Find your sign-in method
            </Link>
          )}
        </p>
      )}
      {((currentResult?.workspace.status === 'active' && methods.length > 1) ||
        (deleting && methods.length > 0)) && (
        <div className="mt-6 space-y-3">
          {methods.map((method) => (
            <button
              key={method.providerId}
              type="button"
              className={`${primaryButton} w-full`}
              disabled={isStarting}
              onClick={() =>
                signInWith(oidcMethod(method), deleting ? '/workspace-deleting' : destination)
              }
            >
              Continue with {method.displayName}
            </button>
          ))}
        </div>
      )}
    </PublicShell>
  );
}
