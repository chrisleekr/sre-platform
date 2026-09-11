// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../theme';

const mocks = vi.hoisted(() => ({
  status: 'unauthenticated' as 'authenticated' | 'unauthenticated',
  localEnabled: false,
  sessionKey: undefined as string | undefined,
  getCredentials: vi.fn(),
  signInWith: vi.fn(),
  loginLocally: vi.fn(async () => false),
  logout: vi.fn(),
  loadPublicConfig: vi.fn(),
  foundingId: undefined as string | undefined,
  me: {
    data: null as Record<string, unknown> | null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  },
}));

vi.mock('../../auth', () => ({
  useSession: () => ({
    status: mocks.status,
    localEnabled: mocks.localEnabled,
    sessionKey: mocks.sessionKey,
    getCredentials: mocks.getCredentials,
    signInWith: mocks.signInWith,
    loginLocally: mocks.loginLocally,
    logout: mocks.logout,
    foundingId: mocks.foundingId,
  }),
}));
vi.mock('../../lib/public-config', () => ({ loadPublicConfig: mocks.loadPublicConfig }));
vi.mock('../../lib/me-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/me-store')>()),
  useMe: () => mocks.me,
}));

import { LandingPage } from '../LandingPage';
import { SignInPage } from '../SignInPage';
import { WorkspaceSignInPage } from '../WorkspaceSignInPage';
import { WorkspaceIdentityPage } from '../WorkspaceIdentityPage';
import { ConnectProviderPage } from '../ConnectProviderPage';
import { ReviewPage } from '../ReviewPage';

const PUBLIC_CONFIG = {
  productName: 'SRE Platform',
  staffProvider: null,
  signupProvider: null,
  registrationMode: 'open',
  supportUrl: 'https://support.example.test/help',
  termsUrl: 'https://legal.example.test/terms',
  termsVersion: '2026-09',
};

beforeEach(() => {
  mocks.loadPublicConfig.mockResolvedValue(PUBLIC_CONFIG);
});

afterEach(() => {
  expect(document.body.textContent ?? '').not.toMatch(
    /\b(?:tenant|founding|binding|membership)\b/i,
  );
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  mocks.getCredentials.mockReset();
  mocks.signInWith.mockReset();
  mocks.loginLocally.mockReset().mockResolvedValue(false);
  mocks.logout.mockReset();
  mocks.loadPublicConfig.mockReset();
  mocks.foundingId = undefined;
  mocks.status = 'unauthenticated';
  mocks.localEnabled = false;
  mocks.sessionKey = undefined;
  mocks.me.data = null;
  mocks.me.refresh.mockReset();
});

function themed(children: ReactNode) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe('public sign-in and onboarding flow', () => {
  test('guides founders through service-specific registration before asking for credentials', () => {
    render(
      themed(
        <MemoryRouter>
          <ConnectProviderPage
            workspace={{ requestedName: 'Acme Engineering', slug: 'acme-engineering' }}
            onContinue={vi.fn()}
          />
        </MemoryRouter>,
      ),
    );

    expect(screen.getByRole('heading', { name: /register your application/i })).toBeDefined();
    expect(screen.getByText(`${window.location.origin}/auth/callback`)).toBeDefined();
    expect(screen.getByText(/application's identifier, not its secret/i)).toBeDefined();
    expect(screen.getByRole('heading', { name: /what happens next/i })).toBeDefined();

    fireEvent.change(screen.getByLabelText('Identity service'), { target: { value: 'entra' } });
    expect(screen.getByLabelText('Client ID')).toBeDefined();
    expect(screen.getByLabelText('Client secret')).toBeDefined();
    expect(screen.queryByLabelText(/api application client id/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Identity service'), {
      target: { value: 'google-workspace' },
    });
    expect(screen.queryByText(/gateway/i)).toBeNull();
  });

  test('renders the public landing from public configuration without requesting a token', async () => {
    mocks.loadPublicConfig.mockResolvedValue(PUBLIC_CONFIG);
    render(
      themed(
        <MemoryRouter>
          <LandingPage />
        </MemoryRouter>,
      ),
    );

    expect(await screen.findByRole('link', { name: 'Create a workspace' })).toBeDefined();
    expect(screen.getByRole('link', { name: /create a workspace/i }).getAttribute('href')).toBe(
      '/get-started',
    );
    expect(screen.getByLabelText('Work email')).toBeDefined();
    expect(mocks.getCredentials).not.toHaveBeenCalled();
  });

  test('does not offer a remembered workspace shortcut alongside email-first sign-in', async () => {
    localStorage.setItem(
      'sre-platform.remembered-workspace',
      JSON.stringify({ name: 'Local dev (dev@example.com)', slug: 'local-dev' }),
    );
    render(
      themed(
        <MemoryRouter>
          <LandingPage />
        </MemoryRouter>,
      ),
    );

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined();
    expect(screen.queryByRole('link', { name: /sign in to local dev/i })).toBeNull();
  });

  test('uses nondisclosing copy when email discovery finds no sign-in method', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ kind: 'unknown' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(
      themed(
        <MemoryRouter>
          <SignInPage />
        </MemoryRouter>,
      ),
    );
    fireEvent.change(screen.getByLabelText(/work email/i), {
      target: { value: 'person@unknown.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    const notice = await screen.findByText(/We could not find company sign-in/);
    expect(notice.textContent).toMatch(/invitation/i);
    expect(notice.textContent).not.toContain('unknown.example');
    expect(screen.queryByLabelText(/workspace address/i)).toBeNull();
    const request = vi.mocked(fetch).mock.calls[0];
    expect(String(request?.[0])).toMatch(/\/auth\/discover$/);
    expect(new Headers(request?.[1]?.headers).has('authorization')).toBe(false);
  });

  test('keeps development sign-in on the same email form without extra controls', () => {
    mocks.localEnabled = true;
    render(
      themed(
        <MemoryRouter>
          <SignInPage />
        </MemoryRouter>,
      ),
    );

    expect(screen.queryByText('Development login')).toBeNull();
    expect(screen.queryByRole('link', { name: /sign in with a development account/i })).toBeNull();
    expect(screen.getByLabelText(/work email/i)).toBeTruthy();
  });

  test('shows the workspace setup route before a first-time visitor submits an email', async () => {
    render(
      themed(
        <MemoryRouter>
          <SignInPage />
        </MemoryRouter>,
      ),
    );

    expect(
      (await screen.findByRole('link', { name: /create a workspace/i })).getAttribute('href'),
    ).toBe('/get-started');
  });

  test('labels a browser-saved workspace draft as a continuation', async () => {
    sessionStorage.setItem(
      'sre-platform.workspace-draft',
      JSON.stringify({ requestedName: 'Acme Operations', slug: 'acme-operations' }),
    );
    render(
      themed(
        <MemoryRouter>
          <SignInPage />
        </MemoryRouter>,
      ),
    );

    expect(
      (await screen.findByRole('link', { name: /continue workspace setup/i })).getAttribute('href'),
    ).toBe('/get-started');
  });

  test('preserves the requested workspace route through email sign-in', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        kind: 'directory',
        provider: {
          id: 'provider-1',
          issuer: 'https://identity.example.test',
          authorizationEndpoint: 'https://identity.example.test/authorize',
          browserClientId: 'browser-client',
        },
      }),
    );
    render(
      themed(
        <MemoryRouter
          initialEntries={[{ pathname: '/sign-in', state: { from: '/w/incidents/incident-1' } }]}
        >
          <SignInPage />
        </MemoryRouter>,
      ),
    );
    fireEvent.change(screen.getByLabelText(/work email/i), {
      target: { value: 'person@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() =>
      expect(mocks.signInWith).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'provider-1' }),
        '/w/incidents/incident-1',
      ),
    );
  });

  test.each([
    { state: undefined, destination: '/w' },
    { state: { selectWorkspace: true }, destination: '/w/select?workspace=workspace-1' },
  ])('starts workspace sign-in with destination $destination', async ({ state, destination }) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          workspace: {
            id: 'workspace-1',
            name: 'Acme Engineering',
            slug: 'acme',
            status: 'active',
          },
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
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    render(
      themed(
        <MemoryRouter initialEntries={[{ pathname: '/acme', state }]}>
          <Routes>
            <Route path="/:slug" element={<WorkspaceSignInPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    await waitFor(() => expect(mocks.signInWith).toHaveBeenCalledOnce());
    expect(mocks.signInWith.mock.calls[0]).toEqual([
      expect.objectContaining({
        providerId: 'provider-1',
        scopes: ['openid', 'email', 'profile'],
      }),
      destination,
    ]);
  });

  test('offers explicit sign-in to recover a deleting workspace instead of hiding its only method', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        workspace: {
          name: 'Acme Engineering',
          status: 'deleting',
          deleteAfter: '2099-01-01T00:00:00Z',
        },
        methods: [
          {
            providerId: 'directory-1',
            displayName: 'Company sign-in',
            issuer: 'https://identity.example.test',
            authorizationEndpoint: 'https://identity.example.test/authorize',
            browserClientId: 'browser-client',
          },
        ],
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
    const signIn = await screen.findByRole('button', { name: 'Continue with Company sign-in' });
    expect(mocks.signInWith).not.toHaveBeenCalled();
    fireEvent.click(signIn);
    expect(mocks.signInWith).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'directory-1' }),
      '/workspace-deleting',
    );
  });

  test('checks address availability accessibly before advancing from workspace identity', async () => {
    const onContinue = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ available: false, code: 'workspace_address_taken' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    render(
      themed(
        <MemoryRouter>
          <WorkspaceIdentityPage onContinue={onContinue} />
        </MemoryRouter>,
      ),
    );
    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: 'Acme' } });
    const address = screen.getByLabelText(/workspace address/i);
    fireEvent.change(address, { target: { value: 'acme' } });
    fireEvent.blur(address);

    expect((await screen.findByRole('status')).textContent).toMatch(/already taken/i);
    expect((screen.getByRole('button', { name: /continue/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(onContinue).not.toHaveBeenCalled();
  });

  test('keeps Continue clickable while a blur-triggered address check is pending', async () => {
    const continueFlow = vi.fn();
    let finishBlur!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishBlur = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ available: true }));
    render(
      themed(
        <MemoryRouter>
          <WorkspaceIdentityPage onContinue={continueFlow} />
        </MemoryRouter>,
      ),
    );
    fireEvent.change(screen.getByLabelText('Workspace name'), {
      target: { value: 'Example team' },
    });
    const address = screen.getByLabelText('Workspace address');
    fireEvent.change(address, { target: { value: 'example-team' } });
    fireEvent.blur(address);
    const button = screen.getByRole('button', {
      name: 'Continue to company sign-in',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(continueFlow).toHaveBeenCalledOnce());
    finishBlur(Response.json({ available: true }));
  });

  test('connects OIDC only after workspace identity and omits a cosmetic bot challenge', async () => {
    const onContinue = vi.fn();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          provider: {
            issuer: 'https://identity.example.test',
            authorizationEndpoint: 'https://identity.example.test/authorize',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ eligible: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          founding: { id: 'founding-1', status: 'awaiting_founder' },
          provider: { id: 'provider-1' },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    render(
      themed(
        <MemoryRouter>
          <ConnectProviderPage
            workspace={{ requestedName: 'Acme Engineering', slug: 'acme-engineering' }}
            onContinue={onContinue}
          />
        </MemoryRouter>,
      ),
    );
    const issuer = screen.getByLabelText(/Directory URL|Auth0 domain /i);
    fireEvent.change(issuer, { target: { value: 'https://identity.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /check directory/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/reachable/i);
    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: 'browser-client' } });
    fireEvent.change(screen.getByLabelText('Client secret'), {
      target: { value: 'sre-api' },
    });
    fireEvent.change(screen.getByLabelText(/email domain/i), {
      target: { value: 'example.test' },
    });
    expect(screen.queryByText(/bot challenge/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /continue to sign in/i }));

    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
    const createRequest = fetcher.mock.calls[2];
    expect(String(createRequest?.[0])).toMatch(/\/foundings$/);
    expect(JSON.parse(String(createRequest?.[1]?.body))).toMatchObject({
      requestedName: 'Acme Engineering',
      slug: 'acme-engineering',
      issuer: 'https://identity.example.test',
      clientId: 'browser-client',
      clientAuthentication: 'client_secret_post',
      clientSecret: 'sre-api',
      declaredDomain: 'example.test',
    });
  });

  test('announces directory discovery failure beside the field and blocks submission', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'directory_unreachable' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(
      themed(
        <MemoryRouter>
          <ConnectProviderPage
            workspace={{ requestedName: 'Acme Engineering', slug: 'acme-engineering' }}
            onContinue={vi.fn()}
          />
        </MemoryRouter>,
      ),
    );
    const directory = screen.getByLabelText(/Directory URL|Auth0 domain /i);
    fireEvent.change(directory, { target: { value: 'https://identity.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /check directory/i }));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toMatch(/could not reach/i);
    expect(directory.getAttribute('aria-describedby')).toBe(error.id);
    expect(
      (screen.getByRole('button', { name: /continue to sign in/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test('rejects a public mailbox domain inline without posting a workspace request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          provider: {
            issuer: 'https://identity.example.test',
            authorizationEndpoint: 'https://identity.example.test/authorize',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ eligible: false, code: 'public_email_domain' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(
      themed(
        <MemoryRouter>
          <ConnectProviderPage
            workspace={{ requestedName: 'Acme Engineering', slug: 'acme-engineering' }}
            onContinue={vi.fn()}
          />
        </MemoryRouter>,
      ),
    );
    const directory = screen.getByLabelText(/Directory URL|Auth0 domain /i);
    fireEvent.change(directory, { target: { value: 'https://identity.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /check directory/i }));
    await screen.findByText(/reachable/i);
    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: 'browser-client' } });
    fireEvent.change(screen.getByLabelText('Client secret'), {
      target: { value: 'sre-api' },
    });
    const domain = screen.getByLabelText(/email domain/i);
    fireEvent.change(domain, { target: { value: 'gmail.com' } });
    fireEvent.blur(domain);

    const error = await screen.findByRole('alert');
    expect(error.textContent).toMatch(/work email domain/i);
    expect(domain.getAttribute('aria-describedby')).toBe(error.id);
    expect(
      (screen.getByRole('button', { name: /continue to sign in/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([input]) => !String(input).endsWith('/foundings'))).toBe(true);
  });

  test('requires configured terms consent on review and submits its exact version', () => {
    const onSubmit = vi.fn();
    render(
      themed(
        <MemoryRouter>
          <ReviewPage
            workspace={{ requestedName: 'Acme Engineering', slug: 'acme-engineering' }}
            signInMethod="Company sign-in"
            domain="example.test"
            terms={{ url: 'https://legal.example.test/terms', version: '2026-09' }}
            registrationMode="approval_required"
            onSubmit={onSubmit}
          />
        </MemoryRouter>,
      ),
    );
    const submit = screen.getByRole('button', { name: /submit request/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/accept.*terms/i));
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ termsAcceptedVersion: '2026-09' });
  });
});
