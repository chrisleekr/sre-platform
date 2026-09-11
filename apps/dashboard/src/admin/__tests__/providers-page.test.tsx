// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ThemeProvider } from '../../theme';

const getCredentials = vi.fn(async () => ({ kind: 'bearer' as const, token: 'admin-token' }));
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

vi.mock('../../auth', () => ({ useSession: () => ({ getCredentials }) }));

import { ProvidersPage } from '../ProvidersPage';

const provider = {
  id: '10000000-0000-4000-8000-000000000001',
  displayName: 'Staff directory',
  kind: 'oidc',
  issuer: 'https://identity.example.test',
  jwksUri: 'https://identity.example.test/jwks',
  audience: 'sre-api',
  browserClientId: 'staff-client',
  authorizationEndpoint: 'https://identity.example.test/authorize',
  tokenEndpoint: 'https://identity.example.test/token',
  backchannelLogout: false,
  backchannelLogoutTypRequired: false,
  clientAuthentication: 'client_secret_post',
  emailClaim: 'email',
  tenantClaim: 'organization_id',
  subjectClaim: 'sub',
  scimEnabled: false,
  scimTokenCreatedAt: null,
  scimTokenExpiresAt: null,
  requireProvisioned: false,
  scimIdentityAttribute: 'externalId',
  status: 'active',
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) =>
      new URL(String(input)).pathname === '/admin/providers'
        ? Response.json({ providers: [provider] })
        : Response.json({ provider: { ...provider, backchannelLogout: true } }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

test('an administrator can opt in and copy the exact installation callback', async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(
    <ThemeProvider>
      <ProvidersPage />
    </ThemeProvider>,
  );
  const toggle = await screen.findByRole('checkbox', { name: /provider-initiated logout/i });

  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('checkbox', { name: /require logout\+jwt token type/i }));

  expect(
    screen.getByText(`http://localhost:43000/auth/providers/${provider.id}/backchannel-logout`),
  ).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
  expect(await screen.findByText('Copied')).toBeDefined();
  expect(writeText).toHaveBeenCalledWith(
    `http://localhost:43000/auth/providers/${provider.id}/backchannel-logout`,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/admin/providers/${provider.id}`),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          backchannelLogout: true,
          backchannelLogoutTypRequired: true,
        }),
      }),
    ),
  );
});

test.each(['unavailable', 'rejected'] as const)(
  'shows manual-copy guidance when the clipboard API is %s',
  async (state) => {
    if (state === 'unavailable') Reflect.deleteProperty(navigator, 'clipboard');
    else {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      });
    }
    render(
      <ThemeProvider>
        <ProvidersPage />
      </ThemeProvider>,
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: /provider-initiated logout/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));

    expect(await screen.findByText('Select and copy the URL manually.')).toBeDefined();
  },
);

test('hides the setting when an OIDC browser client is not configured', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ providers: [{ ...provider, browserClientId: null }] })),
  );

  render(
    <ThemeProvider>
      <ProvidersPage />
    </ThemeProvider>,
  );

  await screen.findByText('Staff directory');
  expect(screen.queryByRole('checkbox', { name: /provider-initiated logout/i })).toBeNull();
});

test('keeps a newly issued SCIM token visible while provider data refreshes', async () => {
  let enabled = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/admin/providers') {
        return Response.json({ providers: [{ ...provider, scimEnabled: enabled }] });
      }
      if (path.endsWith('/scim/credential')) {
        enabled = true;
        return Response.json({ token: 'copy-before-leaving', scim: { scimEnabled: true } });
      }
      if (path.endsWith('/scim/accounts')) return Response.json({ total: 0, accounts: [] });
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }),
  );
  render(
    <ThemeProvider>
      <ProvidersPage />
    </ThemeProvider>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Enable SCIM' }));

  expect(await screen.findByText('copy-before-leaving')).toBeDefined();
  expect(screen.getByText(/will not be shown again/i)).toBeDefined();
});

test('does not discard a one-time SCIM token when the follow-up refresh fails', async () => {
  let providerLoads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/admin/providers') {
        providerLoads += 1;
        return providerLoads === 1
          ? Response.json({ providers: [provider] })
          : Response.json({ error: 'refresh unavailable' }, { status: 503 });
      }
      if (path.endsWith('/scim/credential')) {
        return Response.json({ token: 'recoverable-token', scim: { scimEnabled: true } });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }),
  );
  render(
    <ThemeProvider>
      <ProvidersPage />
    </ThemeProvider>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Enable SCIM' }));

  expect(await screen.findByText('recoverable-token')).toBeDefined();
  expect(
    await screen.findByText('Administrator request could not complete. Refresh and retry.'),
  ).toBeDefined();
});
