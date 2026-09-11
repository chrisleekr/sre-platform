// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ThemeProvider } from '../../theme';

const mocks = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'admin' | 'member',
  token: 'settings-token',
  support: false,
  getCredentials: vi.fn(async () => ({ kind: 'bearer' as const, token: 'settings-token' })),
}));

vi.mock('../../auth', () => ({
  useSession: () => ({
    status: 'authenticated',
    sessionKey: 'settings-session',
    getCredentials: mocks.getCredentials,
  }),
}));
vi.mock('../../lib/me-store', async (load) => ({
  ...(await load<typeof import('../../lib/me-store')>()),
  useMe: () => ({
    data: {
      user: { isPlatformAdmin: mocks.support },
      tenant: {
        role: mocks.role,
        impersonation: mocks.support ? { sessionId: 'support-session' } : null,
      },
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  invalidateMe: vi.fn(),
}));

import { AuthenticationSettingsPage } from '../AuthenticationSettingsPage';
import { WorkspaceSettingsPage } from '../WorkspaceSettingsPage';
import { WorkspaceDeletionPage } from '../../onboarding/WorkspaceDeletionPage';
import { WorkspacesPage } from '../../admin/WorkspacesPage';

const SETTINGS = {
  workspace: {
    id: 'workspace-1',
    name: 'Acme Engineering',
    slug: 'acme-engineering',
    status: 'active',
    requireDirectory: false,
    deleteAfter: null,
  },
  methods: [
    {
      id: 'method-1',
      displayName: 'Company directory',
      issuer: 'https://identity.example.test',
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
      browserClientId: 'company-browser-client',
      subjectClaim: 'sub',
      backchannelLogout: false,
      backchannelLogoutTypRequired: false,
      scimEnabled: false,
      scimTokenCreatedAt: null,
      scimTokenExpiresAt: null,
      requireProvisioned: false,
      scimIdentityAttribute: 'externalId',
      sortOrder: 0,
      createdAt: '2026-09-05T00:00:00.000Z',
    },
  ],
  domains: [
    {
      id: 'domain-1',
      providerId: 'method-1',
      domain: 'example.test',
      status: 'verified',
      challenge: null,
      expiresAt: null,
      lastCheckedAt: null,
    },
  ],
};

test('requires an administrative reason and the workspace address before clearing directory-only access', async () => {
  let required = true;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/admin/providers') return Response.json({ providers: [] });
    if (path === '/admin/tenants')
      return Response.json({
        tenants: [
          {
            ...SETTINGS.workspace,
            requireDirectory: required,
            memberCount: 1,
            owners: [],
            providers: [],
            domains: [],
          },
        ],
      });
    if (path === '/admin/tenants/workspace-1/clear-require-directory' && init?.method === 'POST') {
      required = false;
      return Response.json({ tenant: { requireDirectory: false } });
    }
    return Response.json({ error: 'unexpected request' }, { status: 500 });
  });
  vi.stubGlobal('fetch', fetcher);
  render(themed(<WorkspacesPage />));
  const clear = await screen.findByRole('button', { name: 'Clear directory requirement' });
  expect((clear as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Administrative reason for Acme Engineering'), {
    target: { value: 'Recover owner access' },
  });
  fireEvent.click(clear);
  const confirm = screen.getByRole('button', { name: 'Confirm change' });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Type acme-engineering to confirm'), {
    target: { value: 'acme-engineering' },
  });
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/admin/tenants/workspace-1/clear-require-directory'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'Recover owner access' }),
      }),
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Clear directory requirement' })).toBeNull(),
  );
});

function themed(element: ReactNode) {
  return (
    <ThemeProvider>
      <MemoryRouter>{element}</MemoryRouter>
    </ThemeProvider>
  );
}

beforeEach(() => {
  mocks.role = 'owner';
  mocks.support = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path === '/tenant/settings'
        ? Response.json(SETTINGS)
        : Response.json({ error: 'unexpected request' }, { status: 500 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('workspace settings screens', () => {
  test('lets an active support admin check DNS, refresh the result and retry without owner-only actions', async () => {
    mocks.role = 'admin';
    mocks.support = true;
    let verified = false;
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/tenant/settings')
        return Response.json({
          ...SETTINGS,
          domains: [
            {
              ...SETTINGS.domains[0],
              status: verified ? 'verified' : 'pending',
              challenge: 'dns-proof',
              lastCheckedAt: verified ? '2026-09-09T00:00:00Z' : null,
            },
          ],
        });
      if (path === '/tenant/domains/domain-1/check' && init?.method === 'POST')
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return Response.json({}, { status: 500 });
    });
    vi.stubGlobal('fetch', fetcher);
    render(themed(<AuthenticationSettingsPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify DNS now' }));
    expect(
      (screen.getByRole('button', { name: 'Checking DNS…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add sign-in method' })).toBeNull();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    finish(Response.json({ status: 'pending' }));
    expect(await screen.findByText(/matching TXT record is not confirmed/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Verify DNS now' }));
    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2),
    );
    verified = true;
    finish(Response.json({ status: 'verified' }));
    expect(await screen.findByText(/DNS verified/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Verify DNS now' })).toBeNull();
    expect(screen.queryByText(/Not checked yet/)).toBeNull();
  });
  test('restores a scheduled workspace from a fresh cancellation page', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/tenant/deletion')
        return Response.json({
          workspaces: [
            {
              name: 'Acme Engineering',
              slug: 'acme-engineering',
              role: 'owner',
              deleteAfter: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        });
      if (path === '/tenant/cancel-deletion')
        return Response.json({ workspace: { status: 'active' } });
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/workspace-deleting']}>
          <Routes>
            <Route path="/workspace-deleting" element={<WorkspaceDeletionPage />} />
            <Route path="/w" element={<p>Workspace restored</p>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    );
    const button = (await screen.findByRole('button', {
      name: 'Cancel deletion',
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/type acme-engineering to cancel/i), {
      target: { value: 'acme-engineering' },
    });
    fireEvent.click(button);
    expect(await screen.findByText('Workspace restored')).toBeDefined();
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith('/tenant/cancel-deletion')),
    ).toHaveLength(1);
  });

  test('requires a typed workspace address before disabling a sign-in method', async () => {
    render(themed(<AuthenticationSettingsPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    const button = screen.getByRole('button', { name: 'Confirm change' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(/type acme-engineering to confirm/i), {
      target: { value: 'different' },
    });
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('explains the immutable address and requires typed confirmation before deletion', async () => {
    render(themed(<WorkspaceSettingsPage />));
    expect(await screen.findByDisplayValue('Acme Engineering')).toBeDefined();
    const address = screen.getByDisplayValue('acme-engineering') as HTMLInputElement;
    expect(address.readOnly).toBe(true);
    expect(screen.getByText(/cannot be changed after the workspace is created/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /schedule deletion/i }));
    const confirm = screen.getByLabelText(/type acme-engineering to confirm/i);
    const deleteButton = screen.getByRole('button', {
      name: /confirm deletion/i,
    }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    fireEvent.change(confirm, { target: { value: 'acme-engineering' } });
    expect(deleteButton.disabled).toBe(false);
  });

  test('gives owners a guided add-method path and keeps members read-only', async () => {
    const ownerView = render(themed(<AuthenticationSettingsPage />));
    expect(await screen.findByRole('heading', { name: 'Company directory' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /add sign-in method/i }));
    expect(screen.getByRole('heading', { name: /register your application/i })).toBeDefined();
    expect(screen.getByText(`${window.location.origin}/auth/callback`)).toBeDefined();
    ownerView.unmount();

    mocks.role = 'member';
    render(themed(<AuthenticationSettingsPage />));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Company directory' })).toBeDefined(),
    );
    expect(screen.queryByRole('button', { name: /add sign-in method/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^disable$/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /provider-initiated logout/i })).toBeNull();
  });

  test('lets an owner enable provider logout and shows the exact callback URL', async () => {
    let enabled = false;
    let typRequired = false;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/tenant/settings') {
        return Response.json({
          ...SETTINGS,
          methods: SETTINGS.methods.map((method) => ({
            ...method,
            backchannelLogout: enabled,
            backchannelLogoutTypRequired: typRequired,
          })),
        });
      }
      if (path === '/tenant/providers/method-1/backchannel-logout' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { enabled: boolean; typRequired: boolean };
        enabled = body.enabled;
        typRequired = body.typRequired;
        return Response.json({
          method: {
            ...SETTINGS.methods[0],
            backchannelLogout: enabled,
            backchannelLogoutTypRequired: typRequired,
          },
        });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetcher);
    render(themed(<AuthenticationSettingsPage />));
    const toggle = await screen.findByRole('checkbox', { name: /provider-initiated logout/i });

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining('/tenant/providers/method-1/backchannel-logout'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ enabled: true, typRequired: false }),
        }),
      ),
    );
    expect(
      await screen.findByText('http://localhost:43000/auth/providers/method-1/backchannel-logout'),
    ).toBeDefined();
    fireEvent.click(
      await screen.findByRole('checkbox', { name: /require logout\+jwt token type/i }),
    );
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining('/tenant/providers/method-1/backchannel-logout'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ enabled: true, typRequired: true }),
        }),
      ),
    );
  });

  test('hides provider logout for installation, local, and browserless methods', async () => {
    const ineligible = [
      { ...SETTINGS.methods[0], id: 'installation', scope: 'installation' as const },
      { ...SETTINGS.methods[0], id: 'local', kind: 'local' as const },
      { ...SETTINGS.methods[0], id: 'browserless', browserClientId: null },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...SETTINGS, methods: ineligible })),
    );

    render(themed(<AuthenticationSettingsPage />));

    expect(await screen.findAllByRole('heading', { name: 'Company directory' })).toHaveLength(3);
    expect(screen.queryByRole('checkbox', { name: /provider-initiated logout/i })).toBeNull();
  });
});
