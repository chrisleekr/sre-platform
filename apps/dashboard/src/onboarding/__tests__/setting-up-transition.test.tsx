// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const session = vi.hoisted(() => ({ oidc: {} as Record<string, unknown> }));

vi.mock('../../lib/application-session', () => ({
  ApplicationSessionProvider: ({ children }: { children: ReactNode }) => children,
  clearSignInRetry: vi.fn(),
  useApplicationSession: () => session.oidc,
}));

import { RequireWorkspace } from '../../auth';
import { resetMeStoreForTests } from '../../lib/me-store';
import { ThemeProvider } from '../../theme';
import { SettingUpPage } from '../SettingUpPage';

afterEach(() => {
  cleanup();
  resetMeStoreForTests();
  session.oidc = {};
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('refreshes shared state before admitting an active workspace welcome', async () => {
  let meRequests = 0;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/auth/capabilities')) {
      return Response.json({ localPasswordLogin: false });
    }
    if (url.endsWith('/public-config')) return new Response('unavailable', { status: 503 });
    if (url.endsWith('/me')) {
      meRequests += 1;
      expect(new Headers(init?.headers).get('x-onboarding-founding-id')).toBe('founding-1');
      return Response.json(
        meRequests === 1
          ? {
              user: { id: 'user-1', email: 'founder@example.test', isPlatformAdmin: false },
              state: 'founding',
              tenant: null,
              founding: { id: 'founding-1', status: 'provisioning', slug: 'acme' },
              workspaces: [],
              welcome: null,
              domain: null,
            }
          : {
              user: { id: 'user-1', email: 'founder@example.test', isPlatformAdmin: false },
              state: 'active',
              tenant: {
                id: 'tenant-1',
                name: 'Acme Engineering',
                slug: 'acme',
                status: 'active',
                role: 'owner',
                founderOnly: false,
              },
              founding: null,
              workspaces: [],
              welcome: { complete: false, shown: false, dismissed: false },
              domain: null,
            },
      );
    }
    if (url.endsWith('/foundings/founding-1')) {
      return Response.json({
        founding: {
          id: 'founding-1',
          status: 'active',
          failureReason: null,
          slug: 'acme',
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  session.oidc = {
    isLoading: false,
    isAuthenticated: true,
    error: undefined,
    getCredentials: vi.fn().mockResolvedValue({ kind: 'cookie' }),
    signIn: vi.fn(),
    session: {
      providerId: 'provider-1',
      sessionId: 'session-1',
      expiresAt: Date.now() + 60_000,
      claims: { sub: 'founder-1', email: 'founder@example.test' },
      foundingId: 'founding-1',
    },
  };
  sessionStorage.setItem(
    'sre-platform.workspace-draft',
    JSON.stringify({ requestedName: 'Acme Engineering', slug: 'acme' }),
  );

  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/get-started']}>
        <Routes>
          <Route
            path="/get-started"
            element={
              <RequireWorkspace>
                <SettingUpPage />
              </RequireWorkspace>
            }
          />
          <Route
            path="/w"
            element={
              <RequireWorkspace>
                <p>Workspace destination</p>
              </RequireWorkspace>
            }
          />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );

  expect(await screen.findByText('Workspace destination')).toBeDefined();
  expect(meRequests).toBe(2);
  expect(sessionStorage.getItem('sre-platform.workspace-draft')).toBeNull();
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/\/foundings\/founding-1$/),
      expect.anything(),
    ),
  );
});
