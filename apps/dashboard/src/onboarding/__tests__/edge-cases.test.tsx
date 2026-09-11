// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../theme';

const mocks = vi.hoisted(() => ({
  localEnabled: false,
  getCredentials: vi.fn(),
  signInWith: vi.fn(),
  signInFounding: vi.fn(),
  loadPublicConfig: vi.fn(),
  me: { data: null, refresh: vi.fn() },
}));

vi.mock('../../auth', () => ({
  useSession: () => ({
    status: 'authenticated',
    localEnabled: mocks.localEnabled,
    loginLocally: async () => false,
    sessionKey: 'session-a',
    foundingId: 'founding-1',
    getCredentials: mocks.getCredentials,
    signInWith: mocks.signInWith,
    signInFounding: mocks.signInFounding,
  }),
}));
vi.mock('../../lib/public-config', () => ({ loadPublicConfig: mocks.loadPublicConfig }));
vi.mock('../../lib/me-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/me-store')>()),
  useMe: () => mocks.me,
}));

import { VerifyDomainPage } from '../VerifyDomainPage';
import { WorkspaceIdentityPage } from '../WorkspaceIdentityPage';
import { WorkspaceSignInPage } from '../WorkspaceSignInPage';

const PUBLIC_CONFIG = {
  productName: 'SRE Platform',
  staffProvider: null,
  signupProvider: null,
  registrationMode: 'open',
  supportUrl: 'https://support.example.test/help',
  termsUrl: null,
  termsVersion: null,
};

function themed(children: ReactNode) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

beforeEach(() => {
  mocks.localEnabled = false;
  mocks.loadPublicConfig.mockResolvedValue(PUBLIC_CONFIG);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  mocks.getCredentials.mockReset();
  mocks.signInWith.mockReset();
  mocks.signInFounding.mockReset();
  mocks.loadPublicConfig.mockReset();
  mocks.me.refresh.mockReset();
});

describe('workspace sign-in recovery', () => {
  test('offers explicit founder recovery without auto-starting an ordinary sign-in', async () => {
    const provider = {
      providerId: 'provider-1',
      displayName: 'Company directory',
      issuer: 'https://directory.example.test',
      authorizationEndpoint: 'https://directory.example.test/authorize',
      browserClientId: 'client-1',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        workspace: { name: 'Workspace', status: 'active' },
        methods: [],
        setup: { foundingId: 'founding-1', provider },
      }),
    );
    render(
      themed(
        <MemoryRouter initialEntries={['/workspace']}>
          <Routes>
            <Route path="/:slug" element={<WorkspaceSignInPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Resume workspace setup' }));
    expect(mocks.signInWith).not.toHaveBeenCalled();
    expect(mocks.signInFounding).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'provider-1' }),
      'founding-1',
      '/get-started',
    );
    expect(screen.queryByText(/no sign-in method is available/i)).toBeNull();
  });
  test('starts a single method only once across session rerenders', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        workspace: { name: 'Acme Engineering', slug: 'acme', status: 'active' },
        methods: [
          {
            providerId: 'provider-1',
            displayName: 'Company sign-in',
            issuer: 'https://identity.example.test',
            authorizationEndpoint: 'https://identity.example.test/authorize',
            browserClientId: 'browser-client',
          },
        ],
      }),
    );
    const view = render(
      themed(
        <MemoryRouter initialEntries={['/acme']}>
          <Routes>
            <Route path="/:slug" element={<WorkspaceSignInPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await waitFor(() => expect(mocks.signInWith).toHaveBeenCalledOnce());
    const replacementSignIn = vi.fn();
    mocks.signInWith = replacementSignIn;

    view.rerender(
      themed(
        <MemoryRouter initialEntries={['/acme']}>
          <Routes>
            <Route path="/:slug" element={<WorkspaceSignInPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    await act(async () => undefined);
    expect(replacementSignIn).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'offers recovery without a browser sign-in method with development login %s',
    async (enabled) => {
      mocks.localEnabled = enabled;
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          workspace: { name: 'Acme Engineering', slug: 'acme', status: 'active' },
          methods: [],
        }),
      );
      render(
        themed(
          <MemoryRouter initialEntries={['/acme']}>
            <Routes>
              <Route path="/:slug" element={<WorkspaceSignInPage />} />
            </Routes>
          </MemoryRouter>,
        ),
      );

      expect((await screen.findByRole('alert')).textContent).toMatch(/sign-in is not configured/i);
      const development = screen.queryByRole('link', {
        name: 'Sign in with a development account',
      });
      expect(development).toBeNull();
      expect(
        screen.getByRole('link', { name: /back to your workspaces/i }).getAttribute('href'),
      ).toBe('/w/select?switch=true');
      expect(screen.getByRole('link', { name: /contact support/i }).getAttribute('href')).toBe(
        PUBLIC_CONFIG.supportUrl,
      );
    },
  );

  test('lets the creating browser recover a pre-workspace setup by its address', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/sign-in-methods')
        ? Response.json({ code: 'workspace_not_found' }, { status: 404 })
        : Response.json({
            requestedName: 'Acme Operations',
            slug: 'acme',
            foundingId: 'founding-1',
            providerId: 'provider-1',
          }),
    );
    render(
      themed(
        <MemoryRouter initialEntries={['/acme']}>
          <Routes>
            <Route path="/:slug" element={<WorkspaceSignInPage />} />
            <Route path="/get-started" element={<p>Saved setup</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    fireEvent.click(await screen.findByRole('link', { name: 'Resume setup' }));

    expect(screen.getByText('Saved setup')).toBeDefined();
    expect(sessionStorage.getItem('sre-platform.workspace-draft')).toContain('Acme Operations');
    expect(sessionStorage.getItem('sre-platform.workspace-sign-in')).toContain('founding-1');
  });
});

test('ignores stale address availability and submits only the latest address', async () => {
  const onContinue = vi.fn();
  let resolveFirst!: (response: Response) => void;
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveFirst = resolve)))
    .mockResolvedValueOnce(Response.json({ available: true }));
  render(
    themed(
      <MemoryRouter>
        <WorkspaceIdentityPage onContinue={onContinue} />
      </MemoryRouter>,
    ),
  );
  fireEvent.change(screen.getByLabelText(/workspace name/i), {
    target: { value: 'Acme Engineering' },
  });
  const address = screen.getByLabelText(/workspace address/i);
  fireEvent.change(address, { target: { value: 'acme-old' } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  fireEvent.change(address, { target: { value: 'acme-current' } });
  await act(async () => resolveFirst(Response.json({ available: true })));

  expect(onContinue).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toMatch(/your team will use this address/i);
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));

  await waitFor(() =>
    expect(onContinue).toHaveBeenCalledWith({
      requestedName: 'Acme Engineering',
      slug: 'acme-current',
    }),
  );
  expect(String(fetcher.mock.calls[1]?.[0])).toMatch(/acme-current\/availability$/);
});

describe('domain verification failures', () => {
  const domain = {
    id: 'domain-1',
    domain: 'example.test',
    status: 'pending',
    challengeHost: '_sre-platform.example.test',
    challengeValue: 'verification-value',
    lastCheckedAt: null,
    foundingId: 'founding-1',
  };

  test.each(['pending', 'failed'])(
    'never displays or checks domain A while route B is %s',
    async (outcome) => {
      mocks.getCredentials.mockResolvedValue({ kind: 'cookie' });
      let finishB!: (response: Response) => void;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
        String(url).endsWith('/b')
          ? new Promise<Response>((resolve) => {
              finishB = resolve;
            })
          : Response.json({ domain: { ...domain, id: 'a', domain: 'a.example.test' } }),
      );
      render(
        themed(
          <MemoryRouter initialEntries={['/domains/a']}>
            <Routes>
              <Route
                path="/domains/:id"
                element={
                  <>
                    <VerifyDomainPage />
                    <Link to="/domains/b">Next domain</Link>
                  </>
                }
              />
            </Routes>
          </MemoryRouter>,
        ),
      );
      await screen.findByText('a.example.test', { exact: true });
      fireEvent.click(screen.getByRole('link', { name: 'Next domain' }));
      await waitFor(() => expect(finishB).toBeDefined());
      expect(screen.queryByText('a.example.test', { exact: true })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
      if (outcome === 'failed') {
        await act(async () => finishB(Response.json({ error: 'Not available' }, { status: 503 })));
        expect(await screen.findByText(/domain could not be loaded/i)).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
      } else
        await act(async () =>
          finishB(Response.json({ domain: { ...domain, id: 'b', domain: 'b.example.test' } })),
        );
    },
  );

  test('an old domain check cannot replace the newly selected domain or its status', async () => {
    mocks.getCredentials.mockResolvedValue({ kind: 'cookie' });
    let finishA!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/a/check'))
        return new Promise<Response>((resolve) => {
          finishA = resolve;
        });
      const id = String(url).endsWith('/b') ? 'b' : 'a';
      return Response.json({ domain: { ...domain, id, domain: `${id}.example.test` } });
    });
    render(
      themed(
        <MemoryRouter initialEntries={['/domains/a']}>
          <Routes>
            <Route
              path="/domains/:id"
              element={
                <>
                  <VerifyDomainPage />
                  <Link to="/domains/b">Next domain</Link>
                </>
              }
            />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await screen.findByText('a.example.test', { exact: true });
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(finishA).toBeDefined());
    fireEvent.click(screen.getByRole('link', { name: 'Next domain' }));
    await screen.findByText('b.example.test', { exact: true });
    await act(async () => finishA(Response.json({ status: 'verified' })));
    expect(screen.getByText('b.example.test', { exact: true })).toBeDefined();
    expect(screen.queryByText('a.example.test', { exact: true })).toBeNull();
    expect(screen.queryByText(/Domain verified/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Check now' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test('prevents duplicate checks while one request is pending', async () => {
    mocks.getCredentials.mockResolvedValue({ kind: 'bearer', token: 'token' });
    let resolveCheck!: (response: Response) => void;
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>((resolve) => (resolveCheck = resolve)));
    render(
      themed(
        <MemoryRouter>
          <VerifyDomainPage domain={domain} />
        </MemoryRouter>,
      ),
    );
    const check = screen.getByRole('button', { name: /check now/i });
    fireEvent.click(check);
    fireEvent.click(check);

    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect((check as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveCheck(Response.json({ status: 'pending' })));
    expect(await screen.findByText(/DNS record is not visible yet/i)).toBeDefined();
    expect((check as HTMLButtonElement).disabled).toBe(false);
  });

  test('reports token or network failure', async () => {
    mocks.getCredentials.mockRejectedValue(new Error('session unavailable'));
    const fetcher = vi.spyOn(globalThis, 'fetch');
    render(
      themed(
        <MemoryRouter>
          <VerifyDomainPage domain={domain} />
        </MemoryRouter>,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /check now/i }));

    expect(await screen.findByText(/session unavailable/i)).toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
