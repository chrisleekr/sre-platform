// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../theme';
import { AccountMenu } from '../AccountMenu';

afterEach(cleanup);

function renderMenu(
  role: 'owner' | 'admin' | 'member' = 'owner',
  unreadCount = 0,
  platformAdmin = false,
) {
  const onSignOut = vi.fn();
  const onSignOutEverywhere = vi.fn();
  render(
    <ThemeProvider>
      <MemoryRouter>
        <AccountMenu
          user={{ email: 'founder@example.test' }}
          workspace={{ name: 'Acme Engineering', role, identityScope: 'tenant' }}
          onSignOut={onSignOut}
          onSignOutEverywhere={onSignOutEverywhere}
          unreadCount={unreadCount}
          isPlatformAdmin={platformAdmin}
          pendingRegistrationCount={2}
        />
      </MemoryRouter>
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
  return { onSignOut, onSignOutEverywhere };
}

describe('AccountMenu', () => {
  test('shows the authoritative identity, workspace, role, and theme controls', () => {
    renderMenu('admin');
    expect(screen.getByText('founder@example.test')).toBeDefined();
    expect(screen.getByText('Acme Engineering')).toBeDefined();
    expect(screen.getByText('Admin')).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Appearance' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Light' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Dark' })).toBeDefined();
  });

  test('links to authenticated workspace selection and the durable inbox', () => {
    renderMenu('owner', 3);
    expect(screen.getByRole('link', { name: /switch workspace/i }).getAttribute('href')).toBe(
      '/w/select?switch=true',
    );
    expect(screen.queryByText(/new workspace/i)).toBeNull();
    expect(screen.getByRole('link', { name: /notifications/i }).getAttribute('href')).toBe(
      '/w/notifications',
    );
    expect(screen.getByRole('button', { name: /3 unread notifications/i })).toBeDefined();
  });

  test('keeps ordinary and everywhere sign-out as separate explicit actions', () => {
    const actions = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: /^sign out everywhere$/i }));
    expect(actions.onSignOutEverywhere).toHaveBeenCalledOnce();
    expect(actions.onSignOut).not.toHaveBeenCalled();
  });

  test('links platform administrators to pending registration work', () => {
    renderMenu('owner', 0, true);
    const link = screen.getByRole('link', { name: /platform administration/i });
    expect(link.getAttribute('href')).toBe('/admin');
    expect(link.textContent).toContain('2');
  });
});
