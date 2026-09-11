// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '../../theme';

const mocks = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  logout: vi.fn(),
  foundingId: undefined as string | undefined,
  me: {
    data: null as Record<string, unknown> | null,
    loading: false,
    error: null as Error | null,
    refresh: vi.fn(),
  },
}));

vi.mock('../../auth', () => ({
  useSession: () => ({
    status: 'authenticated',
    sessionKey: 'session-a',
    getCredentials: mocks.getCredentials,
    logout: mocks.logout,
    foundingId: mocks.foundingId,
  }),
}));
vi.mock('../../lib/me-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/me-store')>()),
  useMe: () => mocks.me,
}));
vi.mock('../../lib/public-config', () => ({
  loadPublicConfig: vi.fn(async () => ({
    productName: 'SRE Platform',
    staffProvider: null,
    signupProvider: null,
    registrationMode: 'open',
    supportUrl: null,
    termsUrl: null,
    termsVersion: null,
  })),
}));

import { ReviewPage } from '../ReviewPage';
import { LandingPage } from '../LandingPage';
import { SettingUpPage, foundingPollDelay } from '../SettingUpPage';
import { WorkspaceStatusError } from '../../lib/me-store';

function themed(children: ReactNode) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  mocks.getCredentials.mockReset();
  mocks.logout.mockReset();
  mocks.foundingId = undefined;
  mocks.me.data = null;
  mocks.me.error = null;
  mocks.me.loading = false;
  mocks.me.refresh.mockReset();
});

describe('durable onboarding resume', () => {
  test('allows ordinary sessions rejected by the API to sign in again', async () => {
    mocks.me.error = new WorkspaceStatusError(401);
    render(
      themed(
        <MemoryRouter initialEntries={['/sign-in']}>
          <LandingPage />
        </MemoryRouter>,
      ),
    );
    expect(await screen.findByText('Your session ended. Sign in again.')).toBeDefined();
    expect(screen.getByLabelText('Work email')).toBeDefined();
  });
  test('requires saved review details before submission and offers retry when loading fails', async () => {
    mocks.foundingId = 'founding-1';
    mocks.me.loading = true;
    sessionStorage.setItem(
      'sre-platform.workspace-draft',
      JSON.stringify({ requestedName: 'Stale draft', slug: 'stale-draft' }),
    );
    const view = render(
      themed(
        <MemoryRouter>
          <ReviewPage registrationMode="open" />
        </MemoryRouter>,
      ),
    );
    expect(
      ((await screen.findByRole('button', { name: 'Set up workspace' })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByText('Stale draft')).toBeNull();
    mocks.me.loading = false;
    mocks.me.error = new Error('Network unavailable');
    view.rerender(
      themed(
        <MemoryRouter>
          <ReviewPage registrationMode="open" />
        </MemoryRouter>,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading details' }));
    expect(mocks.me.refresh).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole('button', { name: 'Set up workspace' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    mocks.me.error = null;
    mocks.me.data = {
      user: { email: 'owner@example.test' },
      founding: {
        id: 'founding-1',
        requestedName: 'Saved workspace',
        slug: 'saved-workspace',
        domain: 'example.test',
        provider: { displayName: 'Company directory', issuer: 'https://directory.example.test' },
      },
    };
    view.rerender(
      themed(
        <MemoryRouter>
          <ReviewPage registrationMode="open" />
        </MemoryRouter>,
      ),
    );
    expect(screen.getByText('Saved workspace')).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'Set up workspace' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  test.each([
    ['founder_authenticated', '/get-started', 'Review destination'],
    ['pending', '/get-started', 'Setting-up destination'],
    ['failed', '/get-started', 'Setting-up destination'],
  ])('resumes %s from server state when tab storage is empty', (status, route, destination) => {
    mocks.foundingId = 'founding-1';
    mocks.me.data = {
      state: 'founding',
      tenant: null,
      founding: { id: 'founding-1', status },
    };
    render(
      themed(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path={route} element={<p>{destination}</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    expect(sessionStorage.length).toBe(0);
    expect(screen.getByText(destination)).toBeDefined();
  });

  test('resumes a newly active workspace at its one-time welcome', () => {
    mocks.foundingId = 'founding-1';
    mocks.me.data = {
      state: 'active',
      tenant: { id: 'tenant-1' },
      founding: { id: 'founding-1', status: 'active' },
      welcome: { shown: false, dismissed: false, complete: false },
    };
    render(
      themed(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/w" element={<p>Workspace destination</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    expect(screen.getByText('Workspace destination')).toBeDefined();
  });

  test('preserves setup while requesting a fresh sign-in after session expiry', async () => {
    mocks.foundingId = 'founding-1';
    mocks.me.error = new WorkspaceStatusError(401);
    sessionStorage.setItem('sre-platform.workspace-draft', '{"slug":"expired"}');

    render(
      themed(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/sign-in" element={<p>Resume saved setup</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    expect(
      await screen.findByText('Sign in again to resume your saved workspace setup.'),
    ).toBeDefined();
    expect(screen.getByLabelText('Work email')).toBeDefined();
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('sre-platform.workspace-draft')).toBe('{"slug":"expired"}');
  });

  test('hydrates review after tab storage is lost', () => {
    mocks.me.data = {
      user: { email: 'owner@example.test' },
      founding: {
        id: 'founding-1',
        status: 'founder_authenticated',
        requestedName: 'Acme Engineering',
        slug: 'acme-engineering',
        failureReason: null,
      },
    };
    const onSubmit = vi.fn();
    render(
      themed(
        <MemoryRouter>
          <ReviewPage registrationMode="open" onSubmit={onSubmit} />
        </MemoryRouter>,
      ),
    );

    expect(screen.getByText('Acme Engineering')).toBeDefined();
    expect(screen.getByText(`${window.location.origin}/acme-engineering`)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /set up workspace/i }));
    expect(onSubmit).toHaveBeenCalledWith({});
  });

  test('shows waiting and failure states and bounds polling', () => {
    const onRetry = vi.fn();
    const view = render(
      themed(
        <MemoryRouter>
          <SettingUpPage
            founding={{ id: 'founding-1', status: 'pending', failureReason: null }}
            onRetry={onRetry}
          />
        </MemoryRouter>,
      ),
    );
    expect(screen.getByText(/waiting for approval/i)).toBeDefined();
    view.rerender(
      themed(
        <MemoryRouter>
          <SettingUpPage
            founding={{ id: 'founding-1', status: 'failed', failureReason: 'address taken' }}
            onRetry={onRetry}
          />
        </MemoryRouter>,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /retry setup/i }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(foundingPollDelay(0)).toBe(3_000);
    expect(foundingPollDelay(20)).toBe(30_000);
  });

  test('ends a rejected setup and clears every browser continuation', () => {
    sessionStorage.setItem('sre-platform.workspace-draft', '{"slug":"acme"}');
    sessionStorage.setItem('sre-platform.workspace-sign-in', '{"slug":"acme"}');
    sessionStorage.setItem('sre.sign-in-retry', '{"foundingId":"founding-1"}');
    render(
      themed(
        <MemoryRouter>
          <SettingUpPage
            founding={{
              id: 'founding-1',
              status: 'rejected',
              failureReason: 'Registration is not approved.',
            }}
          />
        </MemoryRouter>,
      ),
    );

    expect(screen.getByText('Registration is not approved.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Start a new setup' }));

    expect(sessionStorage.getItem('sre-platform.workspace-draft')).toBeNull();
    expect(sessionStorage.getItem('sre-platform.workspace-sign-in')).toBeNull();
    expect(sessionStorage.getItem('sre.sign-in-retry')).toBeNull();
    expect(mocks.logout).toHaveBeenCalledWith(`${window.location.origin}/get-started?setup=ended`);
  });

  test('retries with an edited address and resumes polling through active', async () => {
    mocks.foundingId = 'founding-1';
    mocks.getCredentials.mockResolvedValue({ kind: 'bearer', token: 'token' });
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          {
            founding: {
              id: 'founding-1',
              status: 'provisioning',
              failureReason: null,
              slug: 'acme-platform',
            },
          },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          founding: {
            id: 'founding-1',
            status: 'active',
            failureReason: null,
            slug: 'acme-platform',
          },
        }),
      );
    render(
      themed(
        <MemoryRouter initialEntries={['/setting-up']}>
          <Routes>
            <Route
              path="/setting-up"
              element={
                <SettingUpPage
                  founding={{
                    id: 'founding-1',
                    status: 'failed',
                    failureReason: 'worker unavailable',
                    slug: 'acme-engineering',
                  }}
                />
              }
            />
            <Route path="/w" element={<p>Workspace destination</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /change address/i }));
    fireEvent.change(screen.getByLabelText(/workspace address/i), {
      target: { value: 'acme-platform' },
    });
    fireEvent.click(screen.getByRole('button', { name: /retry setup/i }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Workspace destination')).toBeDefined();
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/\/foundings\/founding-1\/retry$/),
      expect.objectContaining({ body: JSON.stringify({ slug: 'acme-platform' }) }),
    );
  });

  test('keeps the request and reports a replacement address collision inline', async () => {
    mocks.foundingId = 'founding-1';
    mocks.getCredentials.mockResolvedValue({ kind: 'bearer', token: 'token' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ code: 'workspace_address_taken' }, { status: 409 }),
    );
    render(
      themed(
        <MemoryRouter>
          <SettingUpPage
            founding={{
              id: 'founding-1',
              status: 'failed',
              failureReason: 'address taken',
              slug: 'acme-engineering',
            }}
          />
        </MemoryRouter>,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /change address/i }));
    fireEvent.change(screen.getByLabelText(/workspace address/i), {
      target: { value: 'occupied-address' },
    });
    fireEvent.click(screen.getByRole('button', { name: /retry setup/i }));

    expect(await screen.findByText(/workspace address is already taken/i)).toBeDefined();
    expect(screen.getByLabelText(/workspace address/i)).toHaveProperty('value', 'occupied-address');
  });

  test('restores a failed setup from the current-user projection', () => {
    mocks.me.data = {
      founding: {
        id: 'founding-1',
        status: 'failed',
        requestedName: 'Acme Engineering',
        slug: 'acme-engineering',
        failureReason: 'worker unavailable',
      },
    };
    render(
      themed(
        <MemoryRouter>
          <SettingUpPage />
        </MemoryRouter>,
      ),
    );
    expect(screen.getByRole('alert').textContent).toMatch(/worker unavailable/i);
  });

  test('clears an expired setup before starting a new request', () => {
    sessionStorage.setItem(
      'sre-platform.workspace-draft',
      JSON.stringify({ requestedName: 'Expired', slug: 'expired' }),
    );
    render(
      themed(
        <MemoryRouter initialEntries={['/setting-up']}>
          <Routes>
            <Route
              path="/setting-up"
              element={
                <SettingUpPage
                  founding={{
                    id: 'founding-expired',
                    status: 'expired',
                    failureReason: null,
                    slug: 'expired',
                  }}
                />
              }
            />
            <Route path="/get-started" element={<p>New request</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /start again/i }));
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('sre-platform.workspace-draft')).toBeNull();
    expect(screen.getByText('New request')).toBeDefined();
  });

  test('preserves the saved request and requests sign-in after a real 401 poll', async () => {
    mocks.foundingId = 'founding-terminal';
    mocks.me.data = {
      state: 'founding',
      founding: { id: 'founding-terminal', status: 'pending' },
    };
    mocks.getCredentials.mockResolvedValue({ kind: 'bearer', token: 'token' });
    sessionStorage.setItem(
      'sre-platform.workspace-draft',
      JSON.stringify({ requestedName: 'Ended request', slug: 'ended-request' }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 'invalid token' }, { status: 401 }),
    );
    render(
      themed(
        <MemoryRouter initialEntries={['/get-started']}>
          <Routes>
            <Route path="/get-started" element={<SettingUpPage />} />
            <Route path="/sign-in" element={<p role="alert">Resume saved setup</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    expect((await screen.findByRole('alert')).textContent).toBe('Resume saved setup');
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('sre-platform.workspace-draft')).toContain('ended-request');
  });
});
