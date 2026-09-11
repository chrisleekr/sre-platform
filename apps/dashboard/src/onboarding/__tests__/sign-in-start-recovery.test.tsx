// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider } from '../../auth';
import { ThemeProvider } from '../../theme';
import { ConnectProviderPage } from '../ConnectProviderPage';
import { WorkspaceSignInPage } from '../WorkspaceSignInPage';
import { VerifyEmailPage } from '../VerifyEmailPage';
import { SignInPage } from '../SignInPage';

const provider = {
  id: 'provider-1',
  providerId: 'provider-1',
  issuer: 'https://directory.example.test',
  authorizationEndpoint: 'https://directory.example.test/authorize',
  browserClientId: 'client-1',
  displayName: 'Company directory',
};
const workspace = { requestedName: 'Workspace', slug: 'workspace' };

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

function fixture(startError = 'Directory temporarily unavailable', hydration?: Promise<Response>) {
  const startBodies: unknown[] = [];
  let created = 0;
  let resume!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/browser/session'))
        return hydration ?? Response.json({ authenticated: false });
      if (url.endsWith('/auth/browser/start')) {
        startBodies.push(JSON.parse(String(init?.body)));
        return startBodies.length === 1
          ? Response.json({ error: startError }, { status: 503 })
          : new Promise<Response>((resolve) => {
              resume = resolve;
            });
      }
      if (url.endsWith('/foundings')) {
        created++;
        return Response.json({
          founding: { id: 'founding-1', status: 'awaiting_founder' },
          provider,
        });
      }
      if (url.endsWith('/auth/capabilities')) return Response.json({ localPasswordLogin: false });
      if (url.endsWith('/public-config'))
        return Response.json({
          productName: 'SRE Platform',
          staffProvider: null,
          signupProvider: null,
          registrationMode: 'open',
          termsUrl: null,
          termsVersion: null,
        });
      if (url.endsWith('/sign-in-methods'))
        return Response.json({
          workspace: { name: 'Workspace', status: 'active' },
          methods: [provider],
        });
      if (url.endsWith('/mailbox'))
        return Response.json({
          recipient: 'o***@company.example.test',
          expiresAt: Date.now() + 600000,
          resendAt: Date.now() + 60000,
        });
      if (url.endsWith('/eligibility')) return Response.json({ eligible: true });
      if (url.endsWith('/draft'))
        return Response.json({
          ...workspace,
          issuer: provider.issuer,
          clientId: provider.browserClientId,
          domain: 'company.example.test',
          clientAuthentication: 'client_secret_post',
          secretStored: true,
          providerId: provider.id,
        });
      if (url.endsWith('/discover')) return Response.json({});
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  return {
    startBodies,
    created: () => created,
    resume: () => resume(Response.json({ authorizationUrl: '#opened' })),
  };
}

function mount(children: ReactNode) {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={['/workspace']}>
          <Routes>
            <Route path="/get-started" element={<h1>Workspace details</h1>} />
            <Route path="/:slug" element={children} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );
}

async function retryAndOpen(f: ReturnType<typeof fixture>, label = 'Retry this sign-in') {
  const retry = screen.getByRole('button', { name: label });
  fireEvent.click(retry);
  fireEvent.click(retry);
  await waitFor(() => expect(f.startBodies).toHaveLength(2));
  expect((retry as HTMLButtonElement).disabled).toBe(true);
  await act(async () => f.resume());
  await waitFor(() => expect(window.location.hash).toBe('#opened'));
  expect(f.startBodies[1]).toEqual(f.startBodies[0]);
}

test('retries a saved connection after start failure and reload without creating it again', async () => {
  const f = fixture();
  const page = mount(<ConnectProviderPage workspace={workspace} />);
  fireEvent.change(screen.getByLabelText(/Directory URL|Auth0 domain /i), {
    target: { value: provider.issuer },
  });
  fireEvent.change(screen.getByLabelText('Client ID'), {
    target: { value: provider.browserClientId },
  });
  fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'test-secret' } });
  fireEvent.change(screen.getByLabelText('Work email domain'), {
    target: { value: 'company.example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to sign in' }));
  await screen.findByText('Directory temporarily unavailable');
  expect(f.created()).toBe(1);
  page.unmount();
  const restored = mount(<ConnectProviderPage workspace={workspace} />);
  await screen.findByRole('button', { name: 'Continue to sign in' });
  await retryAndOpen(f, 'Continue to sign in');
  expect(f.created()).toBe(1);
  expect(JSON.stringify({ ...sessionStorage })).not.toContain('test-secret');
  restored.unmount();
  mount(
    <ConnectProviderPage workspace={{ requestedName: 'Another workspace', slug: 'another' }} />,
  );
  expect(screen.getByLabelText('Identity service')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Continue saved sign-in' })).toBeNull();
});

test('a single-method workspace shows failed automatic start and can retry the same request', async () => {
  const f = fixture();
  mount(<WorkspaceSignInPage />);
  await screen.findByText('Directory temporarily unavailable');
  await retryAndOpen(f);
});

test.each(['success', 'failure'])(
  'late session hydration %s cannot hide the newer workspace start failure or retry',
  async (outcome) => {
    let hydrate!: (response: Response) => void;
    const hydration = new Promise<Response>((resolve) => {
      hydrate = resolve;
    });
    const f = fixture('Directory temporarily unavailable', hydration);
    mount(<WorkspaceSignInPage />);
    await screen.findByText('Directory temporarily unavailable');
    await act(async () =>
      hydrate(
        outcome === 'success'
          ? Response.json({ authenticated: false })
          : Response.json({ error: 'Old session request failed' }, { status: 503 }),
      ),
    );
    expect(screen.getByRole('alert').textContent).toBe('Directory temporarily unavailable');
    await retryAndOpen(f);
  },
);

test('mailbox restart failure is visible and retries its original setup', async () => {
  const f = fixture();
  sessionStorage.setItem(
    'sre.sign-in-retry',
    JSON.stringify({
      providerId: provider.id,
      foundingId: 'founding-1',
      returnTo: '/get-started',
    }),
  );
  mount(<VerifyEmailPage />);
  await screen.findByText('o***@company.example.test');
  fireEvent.click(screen.getByRole('button', { name: 'Restart this sign-in' }));
  await screen.findByText('Directory temporarily unavailable');
  await retryAndOpen(f);
});

test('returns a saved setup to its editable steps without starting authentication', async () => {
  const f = fixture();
  sessionStorage.setItem('sre-platform.workspace-draft', JSON.stringify(workspace));
  sessionStorage.setItem(
    'sre-platform.workspace-sign-in',
    JSON.stringify({
      slug: workspace.slug,
      retry: { providerId: provider.id, foundingId: 'founding-1' },
    }),
  );
  sessionStorage.setItem(
    'sre.sign-in-retry',
    JSON.stringify({
      providerId: provider.id,
      foundingId: 'founding-1',
      returnTo: '/get-started',
    }),
  );
  render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={['/sign-in']}>
          <Routes>
            <Route path="/sign-in" element={<SignInPage />} />
            <Route path="/get-started" element={<ConnectProviderPage workspace={workspace} />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );

  expect(await screen.findByText(/Continue setting up Workspace/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Continue setup' }));
  await screen.findByRole('button', { name: 'Continue to sign in' });
  expect(f.startBodies).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Continue to sign in' }));
  await screen.findByText('Directory temporarily unavailable');
  expect(f.startBodies).toEqual([
    { providerId: 'provider-1', foundingId: 'founding-1', returnTo: '/get-started' },
  ]);
});

test('removes an expired setup from every browser recovery surface', async () => {
  fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/auth/browser/session')) return Response.json({ authenticated: false });
      if (url.endsWith('/auth/capabilities')) return Response.json({ localPasswordLogin: false });
      if (url.endsWith('/public-config'))
        return Response.json({
          productName: 'SRE Platform',
          staffProvider: null,
          signupProvider: null,
          registrationMode: 'open',
          termsUrl: null,
          termsVersion: null,
        });
      if (url.endsWith('/foundings/expired-founding/draft')) {
        return Response.json({ code: 'setup_expired' }, { status: 409 });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  sessionStorage.setItem('sre-platform.workspace-draft', JSON.stringify(workspace));
  sessionStorage.setItem(
    'sre-platform.workspace-sign-in',
    JSON.stringify({
      slug: workspace.slug,
      retry: { providerId: provider.id, foundingId: 'expired-founding' },
    }),
  );
  sessionStorage.setItem(
    'sre.sign-in-retry',
    JSON.stringify({ providerId: provider.id, foundingId: 'expired-founding' }),
  );

  render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={['/sign-in']}>
          <SignInPage />
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );

  await waitFor(() =>
    expect(screen.queryByText('Checking your saved workspace setup…')).toBeNull(),
  );
  expect(screen.queryByText('Resume workspace setup')).toBeNull();
  expect(sessionStorage.getItem('sre-platform.workspace-draft')).toBeNull();
  expect(sessionStorage.getItem('sre-platform.workspace-sign-in')).toBeNull();
  expect(sessionStorage.getItem('sre.sign-in-retry')).toBeNull();
});

test('preserves a saved setup when validation receives a transient HTTP failure', async () => {
  const f = fixture();
  const fetcher = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith('/foundings/founding-1/draft')
      ? Promise.resolve(Response.json({ error: 'Unavailable' }, { status: 503 }))
      : fetcher(input, init),
  );
  sessionStorage.setItem('sre-platform.workspace-draft', JSON.stringify(workspace));
  sessionStorage.setItem(
    'sre-platform.workspace-sign-in',
    JSON.stringify({
      slug: workspace.slug,
      retry: { providerId: provider.id, foundingId: 'founding-1' },
    }),
  );
  sessionStorage.setItem(
    'sre.sign-in-retry',
    JSON.stringify({ providerId: provider.id, foundingId: 'founding-1' }),
  );

  render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={['/sign-in']}>
          <SignInPage />
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );

  expect(await screen.findByRole('button', { name: 'Check again' })).toBeDefined();
  expect(sessionStorage.getItem('sre-platform.workspace-draft')).not.toBeNull();
  expect(sessionStorage.getItem('sre-platform.workspace-sign-in')).not.toBeNull();
  expect(sessionStorage.getItem('sre.sign-in-retry')).not.toBeNull();
  expect(f.created()).toBe(0);
});

test('uses the server-validated provider when another tab replaced stale settings', async () => {
  const starts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/browser/session')) return Response.json({ authenticated: false });
      if (url.endsWith('/auth/capabilities')) return Response.json({ localPasswordLogin: false });
      if (url.endsWith('/public-config'))
        return Response.json({
          productName: 'SRE Platform',
          staffProvider: null,
          signupProvider: null,
          registrationMode: 'open',
          termsUrl: null,
          termsVersion: null,
        });
      if (url.endsWith('/foundings/founding-1/draft')) {
        return Response.json(
          { code: 'setup_in_progress', providerId: 'provider-2' },
          { status: 409 },
        );
      }
      if (url.endsWith('/auth/browser/start')) {
        starts.push(JSON.parse(String(init?.body)));
        return Response.json({ error: 'Stop after asserting the request.' }, { status: 503 });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
  sessionStorage.setItem('sre-platform.workspace-draft', JSON.stringify(workspace));
  sessionStorage.setItem(
    'sre-platform.workspace-sign-in',
    JSON.stringify({
      slug: workspace.slug,
      retry: { providerId: 'provider-1', foundingId: 'founding-1' },
    }),
  );
  sessionStorage.setItem(
    'sre.sign-in-retry',
    JSON.stringify({ providerId: 'provider-1', foundingId: 'founding-1' }),
  );

  render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={['/sign-in']}>
          <SignInPage />
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Continue setup' }));
  await screen.findByText('Stop after asserting the request.');
  expect(starts).toEqual([
    { providerId: 'provider-2', foundingId: 'founding-1', returnTo: '/get-started' },
  ]);
  expect(sessionStorage.getItem('sre-platform.workspace-sign-in')).toContain('provider-2');
});

test('an expired saved setup can be abandoned explicitly without another founding request', async () => {
  const f = fixture('This setup has expired.');
  const fetcher = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
    String(input).endsWith('/draft')
      ? Promise.resolve(Response.json({ error: 'This setup has expired.' }, { status: 409 }))
      : fetcher(input, init),
  );
  sessionStorage.setItem('sre-platform.workspace-draft', JSON.stringify(workspace));
  sessionStorage.setItem(
    'sre-platform.workspace-sign-in',
    JSON.stringify({
      slug: workspace.slug,
      retry: {
        providerId: provider.id,
        foundingId: 'expired-founding',
        returnTo: '/get-started',
      },
    }),
  );
  mount(<ConnectProviderPage />);
  await screen.findByText('This setup has expired.');
  fireEvent.click(screen.getByRole('link', { name: 'Start a new setup' }));
  await screen.findByRole('heading', { name: 'Workspace details' });
  expect(sessionStorage.getItem('sre-platform.workspace-sign-in')).toBeNull();
  expect(sessionStorage.getItem('sre-platform.workspace-draft')).toBeNull();
  expect(f.created()).toBe(0);
});
