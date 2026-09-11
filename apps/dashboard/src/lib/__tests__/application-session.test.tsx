// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApplicationSessionProvider, useApplicationSession } from '../application-session';
import { readFounderSignIn, rememberFounderSignIn } from '../founder-sign-in';
const metadata = {
  authenticated: true,
  providerId: 'provider',
  sessionId: 'session',
  expiresAt: Date.now() + 60000,
  user: { id: 'user', email: 'owner@example.test' },
};

test('keeps only a founder routing hint across logout, never an authenticated session', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      Response.json(
        input.endsWith('/logout') ? { ok: true } : { ...metadata, foundingId: 'setup' },
      ),
    ),
  );
  render(
    <ApplicationSessionProvider>
      <Probe />
    </ApplicationSessionProvider>,
  );
  await screen.findByText('Signed in');
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
  await screen.findByText('Signed out');
  expect(readFounderSignIn('OWNER@example.test')).toEqual({
    email: metadata.user.email,
    providerId: metadata.providerId,
    foundingId: 'setup',
    expiresAt: metadata.expiresAt,
  });
  expect(readFounderSignIn('other@example.test')).toBeNull();
});

test('retires founder routing when authentication no longer has a founding association', async () => {
  rememberFounderSignIn({
    email: metadata.user.email,
    providerId: 'old',
    foundingId: 'setup',
    expiresAt: Date.now() + 60000,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(metadata)),
  );
  render(
    <ApplicationSessionProvider>
      <Probe />
    </ApplicationSessionProvider>,
  );
  await screen.findByText('Signed in');
  expect(readFounderSignIn(metadata.user.email)).toBeNull();
});

test('ignores expired and malformed founder routing hints', () => {
  rememberFounderSignIn({
    email: metadata.user.email,
    providerId: 'old',
    foundingId: 'setup',
    expiresAt: Date.now() - 1,
  });
  expect(readFounderSignIn(metadata.user.email)).toBeNull();
  sessionStorage.setItem('sre.founder-sign-in', '{bad');
  expect(readFounderSignIn(metadata.user.email)).toBeNull();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
function Probe() {
  const session = useApplicationSession();
  return (
    <>
      <p>{session.isLoading ? 'Loading' : session.isAuthenticated ? 'Signed in' : 'Signed out'}</p>
      <p>{session.isStarting ? 'Starting' : 'Not starting'}</p>
      {session.error && <p role="alert">{session.error.message}</p>}
      <button onClick={() => void session.logout()}>Log out</button>
      <button
        onClick={() => {
          session.signIn({ providerId: 'provider' });
          session.signIn({ providerId: 'provider' });
        }}
      >
        Start twice
      </button>
      <button
        onClick={() =>
          void session.complete(new URL('https://app.example/auth/callback?state=one&code=two'))
        }
      >
        Complete
      </button>
      <button
        onClick={() =>
          void session.getCredentials().then((value) => {
            document.title = value.kind;
          })
        }
      >
        Credential mode
      </button>
    </>
  );
}
test('restores only server metadata and retires the old browser token cache', async () => {
  localStorage.setItem('sre-platform.oidc-session', JSON.stringify({ accessToken: 'old-secret' }));
  const fetcher = vi.fn(async () => Response.json(metadata));
  vi.stubGlobal('fetch', fetcher);
  render(
    <ApplicationSessionProvider>
      <Probe />
    </ApplicationSessionProvider>,
  );
  await screen.findByText('Signed in');
  expect(localStorage.getItem('sre-platform.oidc-session')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Credential mode' }));
  await waitFor(() => expect(document.title).toBe('cookie'));
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining('/auth/browser/session'),
    expect.objectContaining({ credentials: 'include' }),
  );
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('old-secret');
});
test('completes using only server attempt state and code, never a browser verifier or refresh token', async () => {
  const fetcher = vi.fn(async (input: string) =>
    Response.json(input.endsWith('/complete') ? { returnTo: '/w' } : metadata),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <ApplicationSessionProvider>
      <Probe />
    </ApplicationSessionProvider>,
  );
  await screen.findByText('Signed in');
  fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/auth/browser/complete'),
      expect.objectContaining({
        body: JSON.stringify({ state: 'one', code: 'two' }),
        credentials: 'include',
      }),
    ),
  );
});
test('logs out through the server and clears in-memory authentication', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      Response.json(input.endsWith('/logout') ? { ok: true } : metadata),
    ),
  );
  render(
    <ApplicationSessionProvider>
      <Probe />
    </ApplicationSessionProvider>,
  );
  await screen.findByText('Signed in');
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
  await screen.findByText('Signed out');
});
test('does not advertise authentication when session hydration fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'Service unavailable' }, { status: 503 })),
  );
  render(
    <ApplicationSessionProvider>
      <Probe />
    </ApplicationSessionProvider>,
  );
  await screen.findByRole('alert');
  expect(screen.getByText('Signed out')).toBeTruthy();
});

test('coalesces simultaneous starts and releases the guard after failure', async () => {
  let starts = 0;
  let fail!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.endsWith('/start')) return Response.json({ authenticated: false });
      starts++;
      return new Promise<Response>((resolve) => {
        fail = resolve;
      });
    }),
  );
  render(
    <ApplicationSessionProvider>
      <Probe />
    </ApplicationSessionProvider>,
  );
  await screen.findByText('Signed out');
  fireEvent.click(screen.getByRole('button', { name: 'Start twice' }));
  await waitFor(() => expect(starts).toBe(1));
  fail(Response.json({ error: 'Try again' }, { status: 503 }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Start twice' }));
  await waitFor(() => expect(starts).toBe(2));
  fail(Response.json({ error: 'Try again' }, { status: 503 }));
  await screen.findByRole('alert');
});

test('late initial hydration cannot finish loading for a pending sign-in', async () => {
  let hydrate!: (response: Response) => void;
  let finishStart!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Promise<Response>((resolve) => {
          if (url.endsWith('/session')) hydrate = resolve;
          else finishStart = resolve;
        }),
    ),
  );
  render(
    <ApplicationSessionProvider>
      <Probe />
    </ApplicationSessionProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Start twice' }));
  await screen.findByText('Starting');
  await act(async () => hydrate(Response.json({ authenticated: false })));
  expect(screen.getByText('Loading')).toBeDefined();
  expect(screen.getByText('Starting')).toBeDefined();
  await act(async () => finishStart(Response.json({ error: 'Start failed' }, { status: 503 })));
  await screen.findByText('Signed out');
  expect(screen.getByText('Not starting')).toBeDefined();
});
