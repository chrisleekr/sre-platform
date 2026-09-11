// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ThemeProvider } from '../../theme';

const mocks = vi.hoisted(() => ({
  loadPublicConfig: vi.fn(),
  session: {
    status: 'unauthenticated' as 'unauthenticated' | 'authenticated',
    sessionKey: undefined as string | undefined,
    foundingId: undefined as string | undefined,
    getCredentials: vi.fn(),
    retrySignIn: vi.fn(),
    isStarting: false,
    error: undefined as string | undefined,
  },
  me: {
    data: null as Record<string, unknown> | null,
    loading: false,
    error: null as Error | null,
    refresh: vi.fn(),
  },
}));

vi.mock('../../auth', () => ({ useSession: () => mocks.session }));
vi.mock('../../lib/me-store', () => ({ useMe: () => mocks.me }));
vi.mock('../../lib/public-config', () => ({
  loadPublicConfig: mocks.loadPublicConfig,
}));

import { WorkspaceSetupPage } from '../WorkspaceSetupPage';

async function renderPage() {
  function CurrentPath() {
    return <output data-testid="current-path">{useLocation().pathname}</output>;
  }
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/get-started']}>
        <WorkspaceSetupPage />
        <CurrentPath />
      </MemoryRouter>
    </ThemeProvider>,
  );
  await waitFor(() => expect(screen.queryByText('Loading workspace setup…')).toBeNull());
}

beforeEach(() => {
  mocks.loadPublicConfig
    .mockReset()
    .mockResolvedValue({ productName: 'SRE Platform', registrationMode: 'open' });
  mocks.session.status = 'unauthenticated';
  mocks.session.sessionKey = undefined;
  mocks.session.foundingId = undefined;
  mocks.me.data = null;
  mocks.me.loading = false;
  mocks.me.error = null;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  mocks.session.getCredentials.mockReset();
  mocks.session.retrySignIn.mockReset();
  mocks.me.refresh.mockReset();
});

describe('single-page workspace setup', () => {
  test('requires loaded configuration and retries a failed request before showing fields', async () => {
    mocks.loadPublicConfig.mockRejectedValueOnce(new Error('Offline'));
    const rendered = renderPage();
    expect(screen.getByText('Loading workspace setup…')).toBeDefined();
    expect(screen.queryByLabelText('Workspace name')).toBeNull();
    await rendered;
    expect(screen.getByRole('alert').textContent).toMatch(/settings could not be loaded/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByLabelText('Workspace name');
  });

  test('blocks a new setup when registration is closed', async () => {
    mocks.loadPublicConfig.mockResolvedValue({ registrationMode: 'closed' });
    await renderPage();
    expect(screen.getByRole('alert').textContent).toMatch(/Workspace creation is unavailable/);
    expect(screen.queryByLabelText('Workspace name')).toBeNull();
  });

  test('explains administrator approval before the user configures company sign-in', async () => {
    mocks.loadPublicConfig.mockResolvedValue({ registrationMode: 'approval_required' });
    await renderPage();
    expect(screen.getByText(/Workspace creation requires administrator approval/)).toBeDefined();
    expect(screen.getByLabelText('Workspace name')).toBeDefined();
  });

  test.each(['closed', 'unavailable'])(
    'keeps submitted requests visible when registration is %s',
    async (mode) => {
      if (mode === 'closed')
        mocks.loadPublicConfig.mockResolvedValue({ registrationMode: 'closed' });
      else mocks.loadPublicConfig.mockRejectedValue(new Error('Offline'));
      mocks.session.status = 'authenticated';
      mocks.session.foundingId = 'pending-setup';
      mocks.me.data = {
        state: 'founding',
        user: { email: 'owner@example.test' },
        founding: { id: 'pending-setup', status: 'pending', requestedName: 'Acme', slug: 'acme' },
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ founding: mocks.me.data!.founding })),
      );
      await renderPage();
      expect(await screen.findByText('Waiting for approval.')).toBeDefined();
      expect(screen.queryByText(/Workspace creation is unavailable/)).toBeNull();
    },
  );

  test('advances and goes back without changing the setup URL or losing workspace details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ available: true })),
    );
    await renderPage();

    expect(screen.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe(
      '/sign-in',
    );

    fireEvent.change(screen.getByLabelText('Workspace name'), {
      target: { value: 'Acme Operations' },
    });
    fireEvent.change(screen.getByLabelText('Workspace address'), {
      target: { value: 'acme-operations' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to company sign-in' }));

    expect(await screen.findByRole('heading', { name: 'Connect company sign-in' })).toBeDefined();
    // The step heading takes focus from an effect, so the heading is in the DOM one tick before
    // focus lands on it. Awaiting keeps the assertion exact and stops it racing a slow runner.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Connect company sign-in' }),
      ),
    );
    expect(screen.getByText('Workspace setup · Step 2 of 3')).toBeDefined();
    fireEvent.click(screen.getAllByRole('button', { name: /back to workspace details/i })[0]!);
    expect(screen.getByRole('heading', { name: 'Create your workspace' })).toBeDefined();
    expect(screen.getByLabelText('Workspace name')).toHaveProperty('value', 'Acme Operations');
    expect(screen.getByTestId('current-path').textContent).toBe('/get-started');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Create your workspace' }),
      ),
    );
  });

  test('continues a browser-owned setup without creating a duplicate founding', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/availability')) {
        return Response.json({ code: 'workspace_address_taken' }, { status: 409 });
      }
      if (path.endsWith('/workspace-setup-drafts/acme-operations')) {
        return Response.json({ providerId: 'provider-1', foundingId: 'founding-1' });
      }
      if (path.endsWith('/foundings/founding-1/draft')) {
        return Response.json({
          requestedName: 'Acme Operations',
          slug: 'acme-operations',
          issuer: 'https://acme.example.test',
          clientId: 'client-1',
          clientAuthentication: 'none',
          domain: 'example.test',
          providerId: 'provider-1',
          secretStored: false,
        });
      }
      if (path.endsWith('/foundings/discover')) return Response.json({ reachable: true });
      if (path.endsWith('/workspace-email-domains/example.test/eligibility')) {
        return Response.json({ eligible: true });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await renderPage();

    fireEvent.change(screen.getByLabelText('Workspace name'), {
      target: { value: 'Acme Operations' },
    });
    fireEvent.change(screen.getByLabelText('Workspace address'), {
      target: { value: 'acme-operations' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to company sign-in' }));

    expect(await screen.findByDisplayValue('client-1')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to sign in' }));
    await waitFor(() =>
      expect(mocks.session.retrySignIn).toHaveBeenCalledWith({
        providerId: 'provider-1',
        foundingId: 'founding-1',
        returnTo: '/get-started',
      }),
    );
    expect(
      fetcher.mock.calls.filter(
        ([input, init]) =>
          new URL(String(input)).pathname.endsWith('/foundings') && init?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  test('leaves sign-in editing when the server advanced to confirmation concurrently', async () => {
    mocks.session.status = 'authenticated';
    mocks.session.sessionKey = 'session-1';
    mocks.session.foundingId = 'founding-1';
    mocks.me.data = {
      state: 'founding',
      user: { email: 'owner@example.test' },
      founding: {
        id: 'founding-1',
        status: 'founder_authenticated',
        requestedName: 'Acme Operations',
        slug: 'acme-operations',
        domain: 'example.test',
        provider: {
          id: 'provider-1',
          displayName: 'Company directory',
          issuer: 'https://directory.example.test',
        },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/foundings/founding-1/draft')) {
          return Response.json({ code: 'setup_in_progress' }, { status: 409 });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit sign-in' }));

    await waitFor(() => expect(mocks.me.refresh).toHaveBeenCalledOnce());
    expect(screen.getByRole('heading', { name: 'Confirm and create' })).toBeDefined();
  });

  test('restores authenticated server state directly at confirmation', async () => {
    mocks.session.status = 'authenticated';
    mocks.session.sessionKey = 'session-1';
    mocks.session.foundingId = 'founding-1';
    mocks.me.data = {
      state: 'founding',
      user: { email: 'owner@example.test' },
      founding: {
        id: 'founding-1',
        status: 'founder_authenticated',
        requestedName: 'Acme Operations',
        slug: 'acme-operations',
        domain: 'example.test',
        provider: {
          id: 'provider-1',
          displayName: 'Auth0',
          issuer: 'https://example.auth0.com/',
        },
      },
    };

    await renderPage();

    expect(screen.getByRole('heading', { name: 'Confirm and create' })).toBeDefined();
    expect(screen.getByText('owner@example.test · Owner')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Edit workspace' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Edit sign-in' })).toBeDefined();
  });

  test('restores pending server state on the same setup page', async () => {
    mocks.session.status = 'authenticated';
    mocks.session.sessionKey = 'session-1';
    mocks.session.foundingId = 'founding-1';
    mocks.me.data = {
      state: 'founding',
      user: { email: 'owner@example.test' },
      founding: {
        id: 'founding-1',
        status: 'pending',
        requestedName: 'Acme Operations',
        slug: 'acme-operations',
        failureReason: null,
      },
    };

    await renderPage();

    expect(screen.getByRole('heading', { name: 'Creating your workspace' })).toBeDefined();
    expect(await screen.findByText('Waiting for approval.')).toBeDefined();
  });

  test('preserves a rejected request and its administrator reason after reload', async () => {
    const rejectedFounding = {
      id: 'founding-1',
      status: 'rejected',
      requestedName: 'Acme Operations',
      slug: 'acme-operations',
      failureReason: 'Only verified company domains are approved.',
    };
    mocks.session.status = 'authenticated';
    mocks.session.sessionKey = 'session-1';
    mocks.session.foundingId = 'founding-1';
    mocks.me.data = {
      state: 'founding',
      user: { email: 'owner@example.test' },
      founding: rejectedFounding,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/foundings/founding-1')) {
          return Response.json({ founding: rejectedFounding });
        }
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    await renderPage();

    expect(await screen.findByText('Workspace request declined.')).toBeDefined();
    expect(screen.getByText('Only verified company domains are approved.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Start a new setup' })).toBeDefined();
  });

  test('clears completed browser setup state before entering the workspace', async () => {
    sessionStorage.setItem(
      'sre-platform.workspace-draft',
      JSON.stringify({ requestedName: 'Acme Operations', slug: 'acme-operations' }),
    );
    sessionStorage.setItem(
      'sre-platform.workspace-sign-in',
      JSON.stringify({
        slug: 'acme-operations',
        retry: { providerId: 'provider-1', foundingId: 'founding-1' },
      }),
    );
    sessionStorage.setItem(
      'sre.sign-in-retry',
      JSON.stringify({ providerId: 'provider-1', foundingId: 'founding-1' }),
    );
    mocks.session.status = 'authenticated';
    mocks.me.data = { state: 'active', tenant: { id: 'tenant-1' } };

    await renderPage();

    await waitFor(() => expect(screen.getByTestId('current-path').textContent).toBe('/w'));
    expect(sessionStorage.getItem('sre-platform.workspace-draft')).toBeNull();
    expect(sessionStorage.getItem('sre-platform.workspace-sign-in')).toBeNull();
    expect(sessionStorage.getItem('sre.sign-in-retry')).toBeNull();
  });
});
