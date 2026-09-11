import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { config } from '../config';
import { sessionFetch } from './session-fetch';
import { invalidateMe } from './me-store';
import type { OidcProvider } from './oidc-types';
import type { CredentialGetter } from './request-credentials';
import { setBrowserSessionId } from './request-credentials';
import { rememberFounderSignIn } from './founder-sign-in';

interface BrowserSession {
  providerId: string;
  sessionId: string;
  expiresAt: number;
  foundingId?: string;
  claims: { sub: string; email?: string; name?: string };
}
export interface SignInRetry {
  providerId: string;
  foundingId?: string;
  returnTo?: string;
}
const RETRY_KEY = 'sre.sign-in-retry';

/** Restores only non-secret routing information for a failed authorization attempt. */
export function readSignInRetry(): SignInRetry | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(RETRY_KEY) ?? 'null');
    return value && typeof value.providerId === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Clears a completed or abandoned browser sign-in continuation. */
export function clearSignInRetry(): void {
  try {
    sessionStorage.removeItem(RETRY_KEY);
  } catch {
    // Storage cleanup must not block the completed server-side session.
  }
}

/** Calls the server-owned browser session boundary and exposes actionable failures.
 * @param path - Browser authentication operation.
 * @param body - Optional JSON input, never provider access or refresh tokens.
 */
export async function browserSessionRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await sessionFetch(`${config.apiBaseUrl}/auth/browser/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? 'Sign-in is unavailable. Please try again.');
  return result;
}

interface ApplicationSession {
  isLoading: boolean;
  isStarting: boolean;
  isAuthenticated: boolean;
  error?: Error;
  session: BrowserSession | null;
  signIn(
    provider: Pick<OidcProvider, 'providerId'>,
    options?: Omit<SignInRetry, 'providerId'>,
  ): void;
  getCredentials: CredentialGetter;
  logout(options?: { returnTo?: string }): Promise<void>;
  signOutEverywhere(options?: { returnTo?: string }): Promise<void>;
  complete(callback?: URL): Promise<{ returnTo?: string }>;
  refresh(): Promise<void>;
}
const Context = createContext<ApplicationSession | null>(null);

/** Keeps only non-sensitive session metadata in memory; credentials remain HttpOnly. */
export function ApplicationSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [isStarting, setStarting] = useState(false);
  const starting = useRef(false);
  const signInGeneration = useRef(0);
  const [error, setError] = useState<Error>();
  const refresh = useCallback(async () => {
    const generation = signInGeneration.current;
    const result = await browserSessionRequest<{
      authenticated: boolean;
      providerId: string;
      sessionId: string;
      expiresAt: number;
      foundingId?: string;
      user: { id: string; email?: string };
    }>('session');
    if (generation !== signInGeneration.current) return;
    if (result.authenticated) {
      rememberFounderSignIn(
        result.foundingId && result.user.email
          ? {
              email: result.user.email,
              providerId: result.providerId,
              foundingId: result.foundingId,
              expiresAt: result.expiresAt,
            }
          : null,
      );
    }
    setBrowserSessionId(result.authenticated ? result.sessionId : undefined);
    setSession(
      result.authenticated
        ? { ...result, claims: { sub: result.user.id, email: result.user.email } }
        : null,
    );
    setError(undefined);
    if (result.authenticated && result.foundingId) {
      sessionStorage.setItem(
        RETRY_KEY,
        JSON.stringify({
          providerId: result.providerId,
          foundingId: result.foundingId,
          returnTo: '/get-started',
        }),
      );
    }
  }, []);
  useEffect(() => {
    // Retire the former upstream-token cache without reading or migrating its credentials.
    localStorage.removeItem('sre-platform.oidc-session');
    const generation = signInGeneration.current;
    void refresh()
      .catch((cause) => {
        if (generation === signInGeneration.current)
          setError(cause instanceof Error ? cause : new Error('Session status is unavailable.'));
      })
      .finally(() => {
        if (generation === signInGeneration.current) setLoading(false);
      });
  }, [refresh]);
  const signIn = useCallback(
    (provider: Pick<OidcProvider, 'providerId'>, options: Omit<SignInRetry, 'providerId'> = {}) => {
      if (starting.current) return;
      signInGeneration.current++;
      starting.current = true;
      setStarting(true);
      const input = {
        providerId: provider.providerId,
        foundingId: options.foundingId,
        returnTo: options.returnTo,
      };
      sessionStorage.setItem(RETRY_KEY, JSON.stringify(input));
      setError(undefined);
      setLoading(true);
      void browserSessionRequest<{ authorizationUrl: string }>('start', input)
        .then(({ authorizationUrl }) => window.location.assign(authorizationUrl))
        .catch((cause) => {
          starting.current = false;
          setStarting(false);
          setError(
            cause instanceof Error ? cause : new Error('Sign-in could not start. Try again.'),
          );
          setLoading(false);
        });
    },
    [],
  );
  const complete = useCallback(
    async (callback = new URL(window.location.href)) => {
      if (callback.searchParams.has('error'))
        throw new Error(
          'Sign-in was cancelled or refused by your directory. Try again with an account allowed to use this application.',
        );
      const result = await browserSessionRequest<{
        returnTo: string;
        mailboxVerificationRequired?: boolean;
        foundingId?: string | null;
      }>('complete', {
        state: callback.searchParams.get('state'),
        code: callback.searchParams.get('code'),
      });
      if (!result.mailboxVerificationRequired) {
        await refresh();
        invalidateMe(null);
        if (!result.foundingId) sessionStorage.removeItem(RETRY_KEY);
      }
      return result;
    },
    [refresh],
  );
  const logout = useCallback(async (options?: { returnTo?: string }) => {
    await browserSessionRequest('logout', {});
    setSession(null);
    setBrowserSessionId(undefined);
    invalidateMe(null);
    if (options?.returnTo) window.location.assign(options.returnTo);
  }, []);
  const signOutEverywhere = useCallback(
    async (options?: { returnTo?: string }) => {
      const response = await sessionFetch(`${config.apiBaseUrl}/me/sign-out-everywhere`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('Could not sign out other sessions. Try again.');
      await logout(options);
    },
    [logout],
  );
  const getCredentials = useCallback<CredentialGetter>(async () => {
    if (!session) throw new Error('Sign in to continue.');
    return { kind: 'cookie' };
  }, [session]);
  const value = useMemo(
    () => ({
      isLoading,
      isStarting,
      isAuthenticated: Boolean(session),
      error,
      session,
      signIn,
      complete,
      logout,
      signOutEverywhere,
      getCredentials,
      refresh,
    }),
    [
      isLoading,
      isStarting,
      session,
      error,
      signIn,
      complete,
      logout,
      signOutEverywhere,
      getCredentials,
      refresh,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Reads the shared application session metadata. */
export function useApplicationSession(): ApplicationSession {
  const value = useContext(Context);
  if (!value) throw new Error('ApplicationSessionProvider is required');
  return value;
}
