// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../theme';
const mocks = vi.hoisted(() => ({
  loadPublicConfig: vi.fn(),
  retrySignIn: vi.fn(),
  signInWith: vi.fn(),
}));
vi.mock('../../auth', () => ({
  useSession: () => ({
    localEnabled: false,
    loginLocally: async () => false,
    signInWith: mocks.signInWith,
    retrySignIn: mocks.retrySignIn,
  }),
}));
vi.mock('../../lib/public-config', () => ({ loadPublicConfig: mocks.loadPublicConfig }));
import { SignInPage } from '../SignInPage';
const PUBLIC_CONFIG = {
  productName: 'SRE Platform',
  registrationMode: 'open',
  staffProvider: null,
  signupProvider: null,
  supportUrl: null,
  termsUrl: null,
  termsVersion: null,
};
function themed(children: ReactNode) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
beforeEach(() => {
  mocks.loadPublicConfig.mockResolvedValue(PUBLIC_CONFIG);
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  mocks.loadPublicConfig.mockReset();
  mocks.retrySignIn.mockReset();
  mocks.signInWith.mockReset();
});
test('requires email before selecting the single installation provider', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      kind: 'installation',
      provider: {
        id: 'company',
        displayName: 'Company SSO',
        issuer: 'https://company.example',
        authorizationEndpoint: 'https://company.example/authorize',
        browserClientId: 'client',
      },
    }),
  );
  mocks.loadPublicConfig.mockResolvedValue({
    ...PUBLIC_CONFIG,
    signInProviders: [
      {
        providerId: 'company',
        displayName: 'Company SSO',
        issuer: 'https://company.example',
        authorizationEndpoint: 'https://company.example/authorize',
        browserClientId: 'client',
        scopes: ['openid', 'email'],
      },
    ],
  });
  render(
    themed(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    ),
  );
  expect(screen.queryByRole('button', { name: 'Continue with Company SSO' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Work email'), {
    target: { value: 'person@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await vi.waitFor(() => expect(mocks.signInWith).toHaveBeenCalled());
  expect(screen.queryByLabelText('Workspace address')).toBeNull();
  expect(mocks.signInWith).toHaveBeenCalledWith(
    expect.objectContaining({ providerId: 'company' }),
    '/w/select',
  );
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining('/auth/discover'),
    expect.objectContaining({ body: JSON.stringify({ email: 'person@example.test' }) }),
  );
});

test.each(['unavailable', 'stale'])(
  'renders discovered choices with %s public configuration',
  async (state) => {
    if (state === 'unavailable') mocks.loadPublicConfig.mockRejectedValue(new Error('Unavailable'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        kind: 'choose_provider',
        providers: [
          {
            id: 'staff',
            displayName: 'Staff sign-in',
            issuer: 'https://staff.example',
            browserClientId: 'staff-client',
            authorizationEndpoint: 'https://staff.example/authorize',
          },
          {
            id: 'other',
            displayName: 'Other sign-in',
            issuer: 'https://other.example',
            browserClientId: 'other-client',
            authorizationEndpoint: 'https://other.example/authorize',
          },
        ],
      }),
    );
    render(
      themed(
        <MemoryRouter>
          <SignInPage />
        </MemoryRouter>,
      ),
    );
    fireEvent.change(screen.getByLabelText('Work email'), {
      target: { value: 'operator@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Staff sign-in' }));
    expect(screen.getByRole('button', { name: 'Continue with Other sign-in' })).toBeDefined();
    expect(mocks.signInWith).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'staff' }),
      '/w/select',
    );
  },
);

test('reauthenticates an expired session even when its browser draft remains editable', async () => {
  const retry = { providerId: 'provider-1', foundingId: 'setup-1', returnTo: '/get-started' };
  sessionStorage.setItem('sre.sign-in-retry', JSON.stringify(retry));
  sessionStorage.setItem(
    'sre-platform.workspace-draft',
    JSON.stringify({ requestedName: 'Acme', slug: 'acme' }),
  );
  sessionStorage.setItem('sre-platform.workspace-sign-in', JSON.stringify({ slug: 'acme', retry }));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ providerId: 'provider-1' }));
  render(
    themed(
      <MemoryRouter>
        <SignInPage authNotice="Sign in again to resume your saved workspace setup." />
      </MemoryRouter>,
    ),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Continue setup' }));
  expect(mocks.retrySignIn).toHaveBeenCalledWith(retry);
});

test('keeps a discovery outage distinct from an unknown workspace and retries', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new Error('Connection unavailable'))
    .mockResolvedValueOnce(Response.json({ kind: 'unknown' }));
  render(
    themed(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    ),
  );
  fireEvent.change(screen.getByLabelText('Work email'), {
    target: { value: 'person@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Connection unavailable/);
  expect(screen.queryByLabelText('Workspace address')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText(/We could not find company sign-in/);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('does not offer creation when registration is closed', async () => {
  mocks.loadPublicConfig.mockResolvedValue({ ...PUBLIC_CONFIG, registrationMode: 'closed' });
  render(
    themed(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    ),
  );
  await screen.findByText(/Workspace creation is unavailable/);
  expect(screen.queryByRole('link', { name: 'Create a workspace' })).toBeNull();
  expect(screen.getByLabelText('Work email')).toBeDefined();
});

test('retries unavailable configuration without advertising registration prematurely', async () => {
  mocks.loadPublicConfig
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(PUBLIC_CONFIG);
  render(
    themed(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    ),
  );
  expect(screen.queryByRole('link', { name: 'Create a workspace' })).toBeNull();
  await screen.findByRole('alert');
  expect(screen.queryByRole('link', { name: 'Create a workspace' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('link', { name: 'Create a workspace' });
  expect(mocks.loadPublicConfig).toHaveBeenCalledTimes(2);
});
