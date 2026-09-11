// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const h = vi.hoisted(() => ({
  oidc: {} as Record<string, unknown>,
  signIn: vi.fn(),
}));

vi.mock('../lib/application-session', () => ({
  ApplicationSessionProvider: ({ children }: { children: ReactNode }) => children,
  useApplicationSession: () => ({ signIn: h.signIn, ...h.oidc }),
}));

import { RequireAuth, useSession } from '../auth';
import { getLocalSession, rememberReturnTo, setLocalSession, takeReturnTo } from '../local-session';
import { clearSessionFailure, getSessionFailure, reportSessionFailure } from '../session-failure';

beforeEach(() => {
  // useSession probes GET /auth/capabilities on mount; keep it off the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ localPasswordLogin: false }), { status: 200 })),
  );
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  h.oidc = {};
  setLocalSession(null);
  clearSessionFailure();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function LoginRouteProbe() {
  const location = useLocation();
  return (
    <>
      <p>login screen</p>
      <output data-testid="login-state">{JSON.stringify(location.state)}</output>
    </>
  );
}

function renderGate(at = '/incidents/abc') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route
          path="*"
          element={
            <RequireAuth>
              <div>protected</div>
            </RequireAuth>
          }
        />
        <Route path="/sign-in" element={<LoginRouteProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  test('shows the application shell skeleton while OIDC restores the session', () => {
    h.oidc = { isLoading: true, isAuthenticated: false, error: undefined };
    const { container } = renderGate();

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/restoring your session/i);
    expect(container.querySelectorAll('.sre-skeleton').length).toBeGreaterThan(10);
    expect(screen.queryByText('protected')).toBeNull();
  });

  test('routes an OIDC restoration error to the login screen without starting a redirect loop', () => {
    h.oidc = { isLoading: false, isAuthenticated: false, error: new Error('Unauthorized') };
    renderGate();
    expect(screen.getByText('login screen')).toBeTruthy();
    expect(screen.queryByText('protected')).toBeNull();
    expect(h.signIn).not.toHaveBeenCalled();
  });

  test('routes an API-rejected OIDC session to the login screen', () => {
    h.oidc = { isLoading: false, isAuthenticated: true, error: undefined };
    reportSessionFailure('unauthorized');
    renderGate();
    expect(screen.getByText('login screen')).toBeTruthy();
    expect(screen.queryByText('protected')).toBeNull();
    expect(screen.getByTestId('login-state').textContent).toBe(
      JSON.stringify({ from: '/incidents/abc', recovery: true }),
    );
  });

  test('preserves the requested page when an OIDC callback fails', () => {
    rememberReturnTo('/incidents/abc');
    h.oidc = { isLoading: false, isAuthenticated: false, error: new Error('Access denied') };

    renderGate('/?error=access_denied&state=auth-state');

    expect(screen.getByTestId('login-state').textContent).toBe(
      JSON.stringify({ from: '/incidents/abc', recovery: true }),
    );
    expect(takeReturnTo()).toBe('/incidents/abc');
  });

  // No imperative redirect during render — the gate navigates to the in-app login screen and
  // hands it the URL the user actually asked for.
  test('navigates to /sign-in with the requested URL when unauthenticated', () => {
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined };
    renderGate('/incidents/abc');
    expect(screen.getByText('login screen')).toBeTruthy();
    expect(screen.queryByText('protected')).toBeNull();
    expect(h.signIn).not.toHaveBeenCalled();
  });

  test('renders children when authenticated via OIDC', () => {
    h.oidc = { isLoading: false, isAuthenticated: true, error: undefined };
    renderGate();
    expect(screen.getByText('protected')).toBeDefined();
    expect(h.signIn).not.toHaveBeenCalled();
  });

  // One boundary serves both paths: an unexpired local session authenticates with OIDC
  // reporting nothing at all.
  test('renders children for an unexpired local-password session', () => {
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined };
    setLocalSession({
      token: 'local-token',
      expiresAt: Date.now() + 60_000,
      email: 'dev@example.test',
    });
    renderGate();
    expect(screen.getByText('protected')).toBeDefined();
  });

  test('treats an expired local session as unauthenticated', () => {
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined };
    setLocalSession({ token: 'stale', expiresAt: Date.now() - 1, email: 'dev@example.test' });
    renderGate();
    expect(screen.getByText('login screen')).toBeTruthy();
  });
});

describe('useSession logout', () => {
  function LogoutProbe() {
    const { logout, signOutEverywhere } = useSession();
    return (
      <>
        <button type="button" onClick={() => logout()}>
          sign out
        </button>
        <button type="button" onClick={() => void signOutEverywhere().catch(() => undefined)}>
          sign out everywhere
        </button>
      </>
    );
  }

  // An expired local session is still returned by getLocalSession (its snapshot must stay
  // referentially stable), so logout must decide on freshness. Treating the dead blob as the active
  // session would swallow the OIDC logout and leave the user signed in.
  test('logs out of OIDC when only an expired local session remains', () => {
    const logout = vi.fn();
    h.oidc = { isLoading: false, isAuthenticated: true, error: undefined, logout };
    setLocalSession({ token: 'stale', expiresAt: Date.now() - 1, email: 'dev@example.test' });
    render(
      <MemoryRouter>
        <LogoutProbe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    expect(logout).toHaveBeenCalledOnce();
  });

  test('does not call OIDC logout while an unexpired local session is active', () => {
    const logout = vi.fn();
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined, logout };
    setLocalSession({ token: 'live', expiresAt: Date.now() + 60_000, email: 'dev@example.test' });
    render(
      <MemoryRouter>
        <LogoutProbe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    expect(logout).not.toHaveBeenCalled();
  });

  test('clears OIDC as well when both session mechanisms are active', () => {
    const logout = vi.fn();
    h.oidc = { isLoading: false, isAuthenticated: true, error: undefined, logout };
    setLocalSession({ token: 'live', expiresAt: Date.now() + 60_000, email: 'dev@example.test' });
    render(
      <MemoryRouter>
        <LogoutProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));

    expect(getLocalSession()).toBeNull();
    expect(logout).toHaveBeenCalledWith({ returnTo: window.location.origin });
  });

  test('clears OIDC with an explicit onboarding recovery destination', () => {
    const logout = vi.fn();
    h.oidc = { isLoading: false, isAuthenticated: true, error: undefined, logout };
    function RecoveryLogoutProbe() {
      const session = useSession();
      return (
        <button
          type="button"
          onClick={() => session.logout(`${window.location.origin}/get-started?setup=ended`)}
        >
          recover setup
        </button>
      );
    }
    render(
      <MemoryRouter>
        <RecoveryLogoutProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'recover setup' }));

    expect(logout).toHaveBeenCalledWith({
      returnTo: `${window.location.origin}/get-started?setup=ended`,
    });
  });

  test('revokes a local session through the API before clearing the browser credential', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/auth/capabilities')) {
        return Response.json({ localDevelopmentLogin: true });
      }
      expect(String(input)).toMatch(/\/me\/sign-out-everywhere$/);
      expect(init).toMatchObject({
        method: 'POST',
        headers: { authorization: 'Bearer local-live' },
      });
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetcher);
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined, logout: vi.fn() };
    setLocalSession({
      token: 'local-live',
      expiresAt: Date.now() + 60_000,
      email: 'dev@example.test',
    });
    render(
      <MemoryRouter>
        <LogoutProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sign out everywhere' }));

    await vi.waitFor(() => expect(getLocalSession()).toBeNull());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('still clears a local credential when durable revocation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/auth/capabilities')) {
          return Response.json({ localDevelopmentLogin: true });
        }
        return new Response('unavailable', { status: 503 });
      }),
    );
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined, logout: vi.fn() };
    setLocalSession({
      token: 'local-live',
      expiresAt: Date.now() + 60_000,
      email: 'dev@example.test',
    });
    localStorage.setItem(
      'sre-platform.remembered-workspace',
      JSON.stringify({ name: 'Example', slug: 'example' }),
    );
    render(
      <MemoryRouter>
        <LogoutProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sign out everywhere' }));

    await vi.waitFor(() => expect(getLocalSession()).toBeNull());
    expect(localStorage.getItem('sre-platform.remembered-workspace')).toBeNull();
  });

  test('delegates OIDC sign-out-everywhere to the provider-neutral session boundary', async () => {
    const signOutEverywhere = vi.fn().mockResolvedValue(undefined);
    h.oidc = {
      isLoading: false,
      isAuthenticated: true,
      error: undefined,
      logout: vi.fn(),
      signOutEverywhere,
    };
    render(
      <MemoryRouter>
        <LogoutProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sign out everywhere' }));

    await vi.waitFor(() =>
      expect(signOutEverywhere).toHaveBeenCalledWith({ returnTo: window.location.origin }),
    );
  });
});

describe('useSession token failure', () => {
  function TokenProbe() {
    const { getCredentials, error } = useSession();
    return (
      <>
        <button type="button" onClick={() => void getCredentials().catch(() => undefined)}>
          load token
        </button>
        {error && <p>{error}</p>}
      </>
    );
  }

  test('moves a silent OIDC token failure into session recovery', async () => {
    const getCredentials = vi.fn().mockRejectedValue({ error: 'missing_refresh_token' });
    h.oidc = {
      isLoading: false,
      isAuthenticated: true,
      error: undefined,
      getCredentials,
    };
    render(
      <MemoryRouter>
        <TokenProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'load token' }));
    await vi.waitFor(() => expect(getSessionFailure()).toBe('token-unavailable'));
    expect(screen.getByText(/session could not be restored/i)).toBeDefined();
    expect(getCredentials).toHaveBeenCalledOnce();
  });

  test('leaves a transient OIDC timeout retryable', async () => {
    const getCredentials = vi.fn().mockRejectedValue({ error: 'timeout' });
    h.oidc = {
      isLoading: false,
      isAuthenticated: true,
      error: undefined,
      getCredentials,
    };
    render(
      <MemoryRouter>
        <TokenProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'load token' }));
    await vi.waitFor(() => expect(getCredentials).toHaveBeenCalledOnce());
    expect(getSessionFailure()).toBeNull();
    expect(screen.queryByText(/session could not be restored/i)).toBeNull();
  });
});

describe('useSession local recovery', () => {
  function EmailProbe() {
    const { loginLocally, status } = useSession();
    return (
      <>
        <button type="button" onClick={() => void loginLocally('dev@example.test')}>
          sign in locally
        </button>
        <p>{status}</p>
      </>
    );
  }

  test('clears the failed session after local email sign-in succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/auth/capabilities')) {
          return new Response(JSON.stringify({ localDevelopmentLogin: true }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            token: 'local-token',
            expiresAt: Date.now() + 60_000,
            email: 'dev@example.test',
          }),
          { status: 200 },
        );
      }),
    );
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined };
    reportSessionFailure('unauthorized');
    render(
      <MemoryRouter>
        <EmailProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sign in locally' }));
    await vi.waitFor(() => expect(getSessionFailure()).toBeNull());
    expect(screen.getByText('authenticated')).toBeDefined();
  });

  test('does not replace an authenticated OIDC session with a local identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/auth/capabilities')) {
          return new Response(JSON.stringify({ localDevelopmentLogin: true }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            token: 'local-token',
            expiresAt: Date.now() + 60_000,
            email: 'dev@example.test',
          }),
          { status: 200 },
        );
      }),
    );
    const logout = vi.fn().mockResolvedValue(undefined);
    h.oidc = { isLoading: false, isAuthenticated: true, error: undefined, logout };
    reportSessionFailure('unauthorized');
    render(
      <MemoryRouter>
        <EmailProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'sign in locally' }));

    await vi.waitFor(() => expect(getLocalSession()).toBeNull());
    expect(logout).not.toHaveBeenCalled();
  });
});

describe('useSession signInWith', () => {
  const provider = {
    providerId: 'provider-1',
    issuer: 'https://identity.example',
    authorizationEndpoint: 'https://identity.example/authorize',
    clientId: 'browser-client',
    scopes: ['openid', 'email', 'profile'],
  };

  function OidcProbe({ returnTo }: { returnTo?: string }) {
    const { signInWith } = useSession();
    return (
      <button type="button" onClick={() => signInWith(provider, returnTo)}>
        continue
      </button>
    );
  }

  // The hosted login leaves the SPA entirely, so the requested URL cannot ride React Router
  // state. It is parked in storage here and replayed by AuthedLayout once the session exists.
  test('starts the hosted redirect and parks the requested URL for replay', () => {
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined };
    render(
      <MemoryRouter>
        <OidcProbe returnTo="/topology" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    expect(h.signIn).toHaveBeenCalledWith(provider, { returnTo: '/topology' });
    expect(takeReturnTo()).toBe('/topology');
  });

  test('parks nothing when there is no requested URL to return to', () => {
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined };
    render(
      <MemoryRouter>
        <OidcProbe />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    expect(h.signIn).toHaveBeenCalledWith(provider, { returnTo: undefined });
    expect(takeReturnTo()).toBeNull();
  });

  test('discards a rejected local token before starting OIDC recovery', () => {
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined };
    setLocalSession({
      token: 'rejected-local-token',
      expiresAt: Date.now() + 60_000,
      email: 'dev@example.test',
    });
    reportSessionFailure('unauthorized');
    render(
      <MemoryRouter>
        <OidcProbe returnTo="/incidents/abc" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    expect(getLocalSession()).toBeNull();
    expect(getSessionFailure()).toBeNull();
    expect(h.signIn).toHaveBeenCalledWith(provider, { returnTo: '/incidents/abc' });
  });
});

describe('public provider recovery', () => {
  function ProviderProbe() {
    const { signInProvider } = useSession();
    return <p>{signInProvider?.clientId ?? 'provider unavailable'}</p>;
  }

  test('retries a transient public-config failure and exposes the recovered provider', async () => {
    let providerRequests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith('/auth/capabilities')) {
          return Response.json({ localPasswordLogin: false });
        }
        providerRequests += 1;
        if (providerRequests === 1) return new Response('unavailable', { status: 503 });
        return Response.json({
          productName: 'SRE Platform',
          staffProvider: {
            providerId: 'provider-recovered',
            displayName: 'Recovered provider',
            issuer: 'https://identity.example',
            browserClientId: 'browser-recovered',
            authorizationEndpoint: 'https://identity.example/authorize',
            scopes: ['openid', 'email', 'profile'],
          },
          signupProvider: null,
          registrationMode: 'approval_required',
        });
      }),
    );
    h.oidc = { isLoading: false, isAuthenticated: false, error: undefined };
    render(
      <MemoryRouter>
        <ProviderProbe />
      </MemoryRouter>,
    );
    expect(await screen.findByText('browser-recovered', {}, { timeout: 2_500 })).toBeDefined();
    expect(providerRequests).toBe(2);
  });
});

describe('generic OIDC boundary', () => {
  test('removes dashboard Auth0 dependencies and registers the callback route', () => {
    const source = (file: string) =>
      readFileSync(resolve(process.cwd(), 'apps/dashboard/src', file), 'utf8');
    const auth = source('auth.tsx');
    const config = source('config.ts');
    const server = source('server.ts');
    const router = source('router.tsx');
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), 'apps/dashboard/package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
    };

    expect(auth).not.toMatch(/@auth0\/auth0-react|Auth0Provider|useAuth0/);
    expect(config).not.toMatch(/auth0Domain|auth0ClientId|auth0Audience|VITE_AUTH0_/);
    expect(server).not.toMatch(/auth0Domain|auth0ClientId|auth0Audience|AUTH0_/);
    expect(pkg.dependencies).not.toHaveProperty('@auth0/auth0-react');
    expect(router).toContain("path: '/auth/callback'");
  });
});
