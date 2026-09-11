// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../theme';
import { AuthProvider } from '../../auth';
import { ConnectProviderPage } from '../ConnectProviderPage';
import { WorkspaceIdentityPage } from '../WorkspaceIdentityPage';
import { saveWorkspaceDraft, saveWorkspaceSignIn } from '../draft';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

test('does not grant editing to another browser for a reserved address', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      String(input).endsWith('/availability')
        ? Response.json({ available: false, code: 'workspace_address_taken' })
        : String(input).includes('/workspace-setup-drafts/')
          ? Response.json({ error: 'Not this browser' }, { status: 404 })
          : Response.json({
              workspace: { status: 'setting_up' },
              setup: { foundingId: 'saved-setup' },
            }),
    ),
  );
  saveWorkspaceDraft({ requestedName: 'Existing setup', slug: 'existing-setup' });
  render(
    <ThemeProvider>
      <MemoryRouter>
        <WorkspaceIdentityPage onContinue={vi.fn()} />
      </MemoryRouter>
    </ThemeProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Continue to company sign-in' }));
  expect((await screen.findByRole('status')).textContent).toMatch(/already taken/i);
  expect(screen.queryByRole('link', { name: 'Resume setup' })).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Continue to company sign-in' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Workspace address'), {
    target: { value: 'different-setup' },
  });
  expect(
    (screen.getByRole('button', { name: 'Continue to company sign-in' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test('keeps an in-flight sign-in editable instead of skipping ahead', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/auth/browser/session')) {
        return Response.json({
          authenticated: true,
          providerId: 'provider-1',
          sessionId: 'session-1',
          foundingId: 'setup-1',
          expiresAt: Date.now() + 60_000,
          user: { id: 'founder-1', email: 'owner@example.test' },
        });
      }
      if (url.endsWith('/foundings/setup-1/draft')) {
        return Response.json(
          {
            error: 'Sign-in verification is still completing. Retry loading settings shortly.',
            code: 'setup_authentication_in_progress',
          },
          { status: 409 },
        );
      }
      return Response.json({ localPasswordLogin: false, staffProvider: null });
    }),
  );
  saveWorkspaceDraft({ requestedName: 'Pending workspace', slug: 'pending-workspace' });
  saveWorkspaceSignIn('pending-workspace', {
    providerId: 'provider-1',
    foundingId: 'setup-1',
    returnTo: '/get-started',
  });
  render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter>
          <ConnectProviderPage />
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );

  expect(
    await screen.findByText(
      'Sign-in verification is still completing. Retry loading settings shortly.',
    ),
  ).toBeDefined();
});

test('restarts sign-in for a submitted setup when its browser session ended', async () => {
  const starts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/browser/session')) return Response.json({ authenticated: false });
      if (url.endsWith('/foundings/setup-1/draft')) {
        return Response.json(
          { error: 'Setup submitted.', code: 'setup_in_progress' },
          { status: 409 },
        );
      }
      if (url.endsWith('/auth/browser/start')) {
        starts.push(JSON.parse(String(init?.body)));
        return Response.json({ error: 'Stop after asserting the request.' }, { status: 503 });
      }
      return Response.json({ localPasswordLogin: false, staffProvider: null });
    }),
  );
  saveWorkspaceDraft({ requestedName: 'Pending workspace', slug: 'pending-workspace' });
  saveWorkspaceSignIn('pending-workspace', {
    providerId: 'provider-1',
    foundingId: 'setup-1',
    returnTo: '/get-started',
  });
  render(
    <ThemeProvider>
      <AuthProvider>
        <MemoryRouter>
          <ConnectProviderPage />
        </MemoryRouter>
      </AuthProvider>
    </ThemeProvider>,
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Continue saved setup' }));
  await screen.findByText('Stop after asserting the request.');
  expect(starts).toEqual([
    {
      providerId: 'provider-1',
      foundingId: 'setup-1',
      returnTo: '/get-started',
    },
  ]);
});
