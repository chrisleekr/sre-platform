import type { CredentialGetter } from './lib/request-credentials';
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { config } from './config';
import { renewLocalDevelopmentSession, signInLocalDevelopment } from './local-development-session';
import { LocalDevelopmentSession } from './LocalDevelopmentSession';
import {
  getLocalSession,
  peekReturnTo,
  rememberReturnTo,
  setLocalSession,
  subscribeLocalSession,
} from './local-session';
import {
  clearSessionFailure,
  getSessionFailure,
  reportTokenFailure,
  subscribeSessionFailure,
} from './session-failure';
import { ApplicationLoadingSkeleton } from './components/LoadingSkeleton';
import { loadPublicConfig, type PublicIdentityProvider } from './lib/public-config';
import type { OidcProvider } from './lib/oidc-types';
import {
  ApplicationSessionProvider,
  useApplicationSession,
  type SignInRetry,
} from './lib/application-session';
import {
  clearRememberedWorkspace,
  invalidateMe,
  nextWorkspaceRoute,
  useMe,
  WorkspaceStatusError,
} from './lib/me-store';
import { setImpersonationSession } from './lib/impersonation';

/** Wraps the dashboard in its single provider-neutral OIDC session boundary. */
export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <ApplicationSessionProvider>
      <LocalDevelopmentSession>{children}</LocalDevelopmentSession>
    </ApplicationSessionProvider>
  );
}

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

export interface Session {
  status: SessionStatus;
  isStarting: boolean;
  error?: string;
  user?: { name?: string; email?: string };
  foundingId?: string;
  signInProvider: OidcProvider | null;
  sessionKey?: string;
  getCredentials: CredentialGetter;
  logout: (returnTo?: string) => void;
  signOutEverywhere: () => Promise<void>;
  loginLocally: (email: string, signal?: AbortSignal) => Promise<boolean>;
  signInWith: (provider: OidcProvider, returnTo?: string) => void;
  signInFounding: (provider: OidcProvider, foundingId: string, returnTo: string) => void;
  retrySignIn: (retry: SignInRetry) => void;
}

function browserProvider(provider: PublicIdentityProvider | null): OidcProvider | null {
  if (!provider?.authorizationEndpoint || !provider.browserClientId) return null;
  return {
    providerId: provider.providerId,
    issuer: provider.issuer,
    authorizationEndpoint: provider.authorizationEndpoint,
    clientId: provider.browserClientId,
    scopes: provider.scopes,
    authorizationAudience: provider.authorizationAudience,
  };
}

/** Combines local development login and OIDC into one application session. */
export function useSession(): Session {
  const oidc = useApplicationSession();
  const local = useSyncExternalStore(subscribeLocalSession, getLocalSession, () => null);
  const sessionFailure = useSyncExternalStore(
    subscribeSessionFailure,
    getSessionFailure,
    () => null,
  );
  const [signInProvider, setSignInProvider] = useState<OidcProvider | null>(null);

  useEffect(() => {
    let live = true;
    let providerRetryTimer: ReturnType<typeof setTimeout> | undefined;
    const loadProvider = (): void => {
      void loadPublicConfig(config.publicConfigUrl)
        .then((publicConfig) => {
          if (live) setSignInProvider(browserProvider(publicConfig.staffProvider));
        })
        .catch(() => {
          if (live) providerRetryTimer = setTimeout(loadProvider, 1_000);
        });
    };
    loadProvider();
    return () => {
      live = false;
      if (providerRetryTimer) clearTimeout(providerRetryTimer);
    };
  }, []);

  const activeLocal = local && local.expiresAt > Date.now() ? local : null;

  const getCredentials = useCallback<CredentialGetter>(async () => {
    const current = getLocalSession();
    if (current) {
      if (current.expiresAt > Date.now()) return { kind: 'bearer', token: current.token };
      if (await renewLocalDevelopmentSession(config.apiBaseUrl)) {
        const renewed = getLocalSession();
        if (renewed) return { kind: 'bearer', token: renewed.token };
      }
      if (getLocalSession() !== current)
        throw new Error('Your session changed. Retry the request.');
      setLocalSession(null);
    }
    try {
      return await oidc.getCredentials();
    } catch (tokenError) {
      reportTokenFailure(tokenError);
      throw tokenError;
    }
  }, [oidc]);

  const endSession = useCallback(
    (returnTo = window.location.origin) => {
      invalidateMe(null);
      clearRememberedWorkspace();
      setImpersonationSession(null);
      setLocalSession(null);
      clearSessionFailure();
      if (oidc.isAuthenticated) {
        void Promise.resolve(oidc.logout({ returnTo })).catch((failure: unknown) =>
          reportTokenFailure(failure),
        );
      }
    },
    [oidc],
  );

  const signOutEverywhere = useCallback(async () => {
    let revocationFailure: unknown;
    const localSession = getLocalSession();
    if (localSession) {
      try {
        const response = await fetch(`${config.apiBaseUrl}/me/sign-out-everywhere`, {
          method: 'POST',
          headers: { authorization: `Bearer ${localSession.token}` },
        });
        if (!response.ok) throw new Error(`sign out failed with ${response.status}`);
      } catch (error) {
        revocationFailure = error;
      } finally {
        setLocalSession(null);
      }
    }
    if (oidc.isAuthenticated) {
      try {
        await oidc.signOutEverywhere({ returnTo: window.location.origin });
      } catch (error) {
        revocationFailure ??= error;
      }
    }
    invalidateMe(null);
    clearRememberedWorkspace();
    setImpersonationSession(null);
    clearSessionFailure();
    if (revocationFailure) throw revocationFailure;
  }, [oidc]);

  const loginLocally = useCallback(
    async (email: string, signal?: AbortSignal) => {
      if (oidc.isAuthenticated) return false;
      if (!(await signInLocalDevelopment(config.apiBaseUrl, email, signal))) return false;
      setImpersonationSession(null);
      invalidateMe(null);
      clearSessionFailure();
      return true;
    },
    [oidc],
  );

  const signInWith = useCallback(
    (provider: OidcProvider, returnTo?: string) => {
      invalidateMe(null);
      setLocalSession(null);
      setImpersonationSession(null);
      clearSessionFailure();
      if (returnTo) rememberReturnTo(returnTo);
      oidc.signIn(provider, { returnTo });
    },
    [oidc],
  );
  const signInFounding = useCallback(
    (provider: OidcProvider, foundingId: string, returnTo: string) => {
      invalidateMe(null);
      setLocalSession(null);
      setImpersonationSession(null);
      clearSessionFailure();
      rememberReturnTo(returnTo);
      oidc.signIn(provider, { foundingId, returnTo });
    },
    [oidc],
  );
  const retrySignIn = useCallback(
    (retry: SignInRetry) => {
      invalidateMe(null);
      setLocalSession(null);
      setImpersonationSession(null);
      clearSessionFailure();
      if (retry.returnTo) rememberReturnTo(retry.returnTo);
      oidc.signIn(
        { providerId: retry.providerId },
        { foundingId: retry.foundingId, returnTo: retry.returnTo },
      );
    },
    [oidc],
  );

  let status: SessionStatus = 'unauthenticated';
  if (sessionFailure) status = 'error';
  else if (activeLocal) status = 'authenticated';
  else if (oidc.isLoading) status = 'loading';
  else if (oidc.error) status = 'error';
  else if (oidc.isAuthenticated) status = 'authenticated';

  const claims = oidc.session?.claims;
  const email = typeof claims?.email === 'string' ? claims.email : undefined;
  const name = typeof claims?.name === 'string' ? claims.name : email;
  const sessionKey = activeLocal
    ? `local:${activeLocal.email}`
    : oidc.isAuthenticated && oidc.session
      ? `browser:${oidc.session.sessionId}`
      : undefined;
  return {
    status,
    isStarting: oidc.isStarting,
    error:
      sessionFailure === 'unauthorized'
        ? 'Your session expired. Sign in again.'
        : sessionFailure === 'token-unavailable'
          ? 'Your session could not be restored. Sign in again.'
          : oidc.error?.message,
    user: activeLocal ? { name: activeLocal.email, email: activeLocal.email } : { name, email },
    foundingId: oidc.session?.foundingId,
    signInProvider,
    sessionKey,
    getCredentials,
    logout: endSession,
    signOutEverywhere,
    loginLocally,
    signInWith,
    signInFounding,
    retrySignIn,
  };
}

/** Gate that sends unauthenticated users to the public sign-in screen. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const location = useLocation();
  if (status === 'loading') return <ApplicationLoadingSkeleton />;
  if (status === 'error' || status === 'unauthenticated') {
    const params = new URLSearchParams(location.search);
    const isCallback = params.has('state') && (params.has('code') || params.has('error'));
    const from =
      (isCallback ? peekReturnTo() : null) ??
      `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to="/sign-in" replace state={{ from, recovery: status === 'error' }} />;
  }
  return <>{children}</>;
}

/** Gates product routes with the server-authoritative workspace state. */
export function RequireWorkspace({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  const me = useMe(
    session.getCredentials,
    session.status === 'authenticated',
    session.sessionKey,
    session.foundingId,
  );
  if (session.status !== 'authenticated') return <RequireAuth>{children}</RequireAuth>;
  if (me.loading || !me.data) {
    if (me.error) {
      const sessionChanged = me.error instanceof WorkspaceStatusError && me.error.status === 401;
      return (
        <main className="grid min-h-dvh place-items-center bg-canvas p-6 text-ink">
          <div role="alert" className="max-w-md rounded-lg border border-critical-line p-5">
            <p className="font-semibold">
              {sessionChanged
                ? 'Your session changed or ended. Reload to continue.'
                : 'Workspace status is unavailable.'}
            </p>
            <button
              type="button"
              className="mt-3 underline"
              onClick={sessionChanged ? () => window.location.reload() : me.refresh}
            >
              {sessionChanged ? 'Reload' : 'Try again'}
            </button>
          </div>
        </main>
      );
    }
    return <ApplicationLoadingSkeleton />;
  }
  const target = nextWorkspaceRoute(me.data);
  const current = location.pathname;
  const compatible =
    (me.data.state === 'active' && (current === '/w' || current.startsWith('/w/'))) ||
    (target === '/w' && current.startsWith('/w')) ||
    (target.startsWith('/get-started') && current.startsWith('/get-started')) ||
    target === current;
  return compatible ? <>{children}</> : <Navigate to={target} replace />;
}

/** Gates the platform control room with the server-authoritative administrator projection. */
export function RequirePlatformAdmin({ children }: { children: ReactNode }) {
  const session = useSession();
  const me = useMe(
    session.getCredentials,
    session.status === 'authenticated',
    session.sessionKey,
    session.foundingId,
  );
  if (session.status !== 'authenticated') return <RequireAuth>{children}</RequireAuth>;
  if (me.loading || !me.data) {
    if (me.error) {
      return (
        <main className="grid min-h-dvh place-items-center bg-canvas p-6 text-ink">
          <div role="alert" className="max-w-md rounded-lg border border-critical-line p-5">
            <p className="font-semibold">Administrator status is unavailable.</p>
            <button type="button" className="mt-3 underline" onClick={me.refresh}>
              Try again
            </button>
          </div>
        </main>
      );
    }
    return <ApplicationLoadingSkeleton />;
  }
  return me.data.user.isPlatformAdmin ? (
    <>{children}</>
  ) : (
    <Navigate to={nextWorkspaceRoute(me.data)} replace />
  );
}
