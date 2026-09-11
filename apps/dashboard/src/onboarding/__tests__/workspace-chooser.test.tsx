// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from '../../theme';
const mocks = vi.hoisted(() => ({
  me: { data: null as Record<string, unknown> | null, error: null, refresh: vi.fn() },
  logout: vi.fn(),
  select: vi.fn(),
}));
vi.mock('../../lib/application-session', () => ({ browserSessionRequest: mocks.select }));
vi.mock('../../auth', () => ({
  useSession: () => ({ status: 'authenticated', getCredentials: vi.fn(), logout: mocks.logout }),
}));
vi.mock('../../lib/me-store', async (original) => ({
  ...(await original<typeof import('../../lib/me-store')>()),
  useMe: () => mocks.me,
}));
import { WorkspaceChooserPage } from '../WorkspaceChooserPage';
const first = {
  id: 'one',
  name: 'Operations',
  slug: 'operations',
  role: 'owner',
  status: 'active',
};
const second = {
  id: 'two',
  name: 'Engineering',
  slug: 'engineering',
  role: 'member',
  status: 'active',
};
function mount(query = '') {
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[`/w/select${query}`]}>
        <Routes>
          <Route path="/w/select" element={<WorkspaceChooserPage />} />
          <Route path="/w" element={<p>Workspace dashboard</p>} />
          <Route path="/admin" element={<p>Platform administration</p>} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}
afterEach(() => {
  cleanup();
  mocks.me.data = null;
  mocks.select.mockReset();
});
test('selects a membership without another provider login and shows recoverable failures', async () => {
  mocks.me.data = {
    state: 'unaffiliated',
    user: { email: 'person@example.test' },
    tenant: null,
    workspaces: [{ ...first, signInAvailable: false, canSelect: true }],
  };
  mocks.select.mockRejectedValueOnce(new Error('Workspace access changed.'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Open Operations' }));
  expect(mocks.select).toHaveBeenCalledWith('workspace', { tenantId: 'one' });
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Workspace access changed.',
  );
  expect(screen.getByRole('button', { name: 'Open Operations' })).toHaveProperty('disabled', false);
  expect(mocks.me.refresh).toHaveBeenCalled();
});
test('opens the sole workspace already authorized by the current session', () => {
  mocks.me.data = {
    state: 'active',
    user: { email: 'person@example.test' },
    tenant: first,
    workspaces: [first],
  };
  mount();
  expect(screen.getByText('Workspace dashboard')).toBeDefined();
});
test('opens administration for an installation operator without a workspace', () => {
  mocks.me.data = {
    state: 'unaffiliated',
    user: { email: 'operator@example.test', isPlatformAdmin: true },
    tenant: null,
    workspaces: [],
  };
  mount();
  expect(screen.getByText('Platform administration')).toBeDefined();
});
test('shows multiple memberships after authentication and uses direct links for required company sign-in', () => {
  mocks.me.data = {
    state: 'active',
    user: { email: 'person@example.test' },
    tenant: first,
    workspaces: [first, second],
  };
  mount();
  expect(screen.getByRole('heading', { name: 'Choose a workspace' })).toBeDefined();
  expect(screen.getByRole('link', { name: 'Open Operations' }).getAttribute('href')).toBe('/w');
  expect(screen.getByRole('link', { name: 'Open Engineering' }).getAttribute('href')).toBe(
    '/engineering',
  );
});
test('never silently opens another workspace after the selected workspace authentication fails', () => {
  mocks.me.data = {
    state: 'active',
    user: { email: 'person@example.test' },
    tenant: first,
    workspaces: [first, second],
  };
  mount('?workspace=two');
  expect(screen.getByRole('alert').textContent).toMatch(/did not open the selected workspace/);
  expect(screen.queryByText('Workspace dashboard')).toBeNull();
});
test('opens a selected workspace only after the server confirms its identity', () => {
  mocks.me.data = {
    state: 'active',
    user: { email: 'person@example.test' },
    tenant: second,
    workspaces: [first, second],
  };
  mount('?workspace=two');
  expect(screen.getByText('Workspace dashboard')).toBeDefined();
});
test('does not offer access to suspended workspaces', () => {
  mocks.me.data = {
    state: 'active',
    user: { email: 'person@example.test' },
    tenant: first,
    workspaces: [first, { ...second, status: 'suspended' }],
  };
  mount();
  expect(screen.queryByRole('link', { name: 'Open Engineering' })).toBeNull();
});

test('offers administration without an unusable workspace sign-in link', () => {
  mocks.me.data = {
    state: 'unaffiliated',
    user: { email: 'operator@example.test', isPlatformAdmin: true },
    tenant: null,
    workspaces: [{ ...first, signInAvailable: false }],
  };
  mount();
  expect(screen.queryByRole('link', { name: 'Open Operations' })).toBeNull();
  expect(screen.getByText(/Sign-in is not configured/)).toBeDefined();
  expect(screen.getByRole('link', { name: /Platform administration/ }).getAttribute('href')).toBe(
    '/admin',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(mocks.logout).toHaveBeenCalledWith('/sign-in');
});

test('does not offer administration to an ordinary member', () => {
  mocks.me.data = {
    state: 'unaffiliated',
    user: { email: null },
    tenant: null,
    workspaces: [{ ...first, signInAvailable: false }],
  };
  mount();
  expect(screen.queryByRole('link', { name: /Platform administration/ })).toBeNull();
  expect(screen.getByText('You are signed in.')).toBeDefined();
  expect(screen.getByText(/Ask your workspace administrator/)).toBeDefined();
});

test('uses a compact loading state', () => {
  mount();
  expect(screen.getByRole('status', { name: 'Loading workspaces' })).toBeDefined();
});
