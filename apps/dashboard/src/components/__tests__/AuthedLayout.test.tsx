// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  logout: vi.fn(),
  signOutEverywhere: vi.fn(),
}));

vi.mock('../../auth', () => ({
  RequireAuth: ({ children }: { children: ReactNode }) => children,
  useSession: () => ({
    status: 'authenticated',
    sessionKey: 'session-a',
    user: { email: 'person@example.test' },
    getCredentials: async () => ({ kind: 'bearer' as const, token: 'token' }),
    logout: mocks.logout,
    signOutEverywhere: mocks.signOutEverywhere,
  }),
}));
vi.mock('../../lib/me-store', () => ({
  useMe: () => ({
    data: { tenant: { name: 'Acme', role: 'owner' } },
    loading: false,
    error: null,
  }),
}));
vi.mock('../../lib/notification-inbox', () => ({
  NotificationInboxProvider: ({ children }: { children: ReactNode }) => children,
  useNotificationInbox: () => ({ unreadCount: 0 }),
}));
vi.mock('../Layout', () => ({
  Layout: ({
    onLogout,
    onLogoutEverywhere,
  }: {
    onLogout(): void;
    onLogoutEverywhere(): Promise<void>;
  }) => (
    <>
      <button type="button" onClick={onLogout}>
        ordinary sign out
      </button>
      <button type="button" onClick={() => void onLogoutEverywhere()}>
        global sign out
      </button>
    </>
  ),
}));

import { AuthedLayout } from '../AuthedLayout';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/w']}>
      <Routes>
        <Route path="/w" element={<AuthedLayout />} />
        <Route path="/" element={<p>Public landing</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthedLayout sign out destinations', () => {
  test('ordinary sign out clears only the browser session and lands on the public page', () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: /ordinary sign out/i }));
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.signOutEverywhere).not.toHaveBeenCalled();
    expect(screen.getByText('Public landing')).toBeDefined();
  });

  test('global sign out lands on the public page even when server revocation fails', async () => {
    mocks.signOutEverywhere.mockRejectedValueOnce(new Error('unavailable'));
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: /global sign out/i }));
    expect(await screen.findByText('Public landing')).toBeDefined();
    expect(mocks.signOutEverywhere).toHaveBeenCalledOnce();
  });
});
