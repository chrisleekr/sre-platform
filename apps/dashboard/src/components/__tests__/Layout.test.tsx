// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { matchRoutes, MemoryRouter, Routes, Route } from 'react-router-dom';
import { Layout } from '../Layout';
import { DashboardPanel } from '../DashboardPanel';
import { IncidentsPanel } from '../IncidentsPanel';
import { WorkspaceSettingsPage } from '../WorkspaceSettingsPage';
import { UsagePanel } from '../UsagePanel';
import { PANELS } from '../../lib/types';
import { router } from '../../router';
import { ThemeProvider } from '../../theme';

function withTheme(children: ReactNode) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

function renderLayout({
  initialEntry = '/w',
  user,
  onLogout,
}: {
  initialEntry?: string;
  user?: { name?: string; email?: string };
  onLogout?: () => void;
} = {}) {
  return render(
    withTheme(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/w" element={<Layout panels={PANELS} user={user} onLogout={onLogout} />}>
            <Route index element={<p>Dashboard destination</p>} />
            <Route path="incidents" element={<p>Incidents destination</p>} />
            <Route path="*" element={<p>Panel destination</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  );
}

describe('Layout', () => {
  test('keeps page scrolling inside the viewport-bound content pane', () => {
    const { container } = renderLayout();

    const shell = container.firstElementChild;
    const main = screen.getByRole('main');
    expect(shell?.className).toContain('fixed');
    expect(shell?.className).toContain('inset-0');
    expect(shell?.className).toContain('overflow-hidden');
    expect(main.className).toContain('min-h-0');
    expect(main.className).toContain('overflow-y-auto');
  });

  test('renders a nav item for every panel and the user', () => {
    render(
      withTheme(
        <MemoryRouter initialEntries={['/w']}>
          <Routes>
            <Route path="/w" element={<Layout panels={PANELS} user={{ name: 'Dev User' }} />} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    for (const p of PANELS) expect(within(nav).getByRole('link', { name: p.label })).toBeDefined();
    expect(screen.getByText('Dev User')).toBeDefined();
  });

  test('selecting Settings navigates to the registered settings route', () => {
    render(
      withTheme(
        <MemoryRouter initialEntries={['/w']}>
          <Routes>
            <Route path="/w" element={<Layout panels={PANELS} user={{ name: 'Dev User' }} />}>
              <Route path="settings" element={<p>Settings destination</p>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      ),
    );

    const link = screen.getByRole('link', { name: 'Settings' });
    expect(link.getAttribute('href')).toBe('/w/settings');
    fireEvent.click(link);
    expect(screen.getByText('Settings destination')).toBeDefined();
    const settingsRoute = matchRoutes(router.routes, '/w/settings/workspace')?.at(-1)?.route;
    expect(settingsRoute?.path).toBe('settings/workspace');
    expect(settingsRoute?.element).toMatchObject({ type: WorkspaceSettingsPage });
  });

  test('registers Usage & Cost as a first-class panel separate from Settings', () => {
    renderLayout({ initialEntry: '/w/usage' });

    const usageLink = screen.getByRole('link', { name: 'Usage & Cost' });
    expect(usageLink.getAttribute('href')).toBe('/w/usage');
    expect(usageLink.getAttribute('aria-current')).toBe('page');
    const usageRoute = matchRoutes(router.routes, '/w/usage')?.at(-1)?.route;
    expect(usageRoute?.path).toBe('usage');
    expect(usageRoute?.element).toMatchObject({ type: UsagePanel });
  });

  test('does not keep a root panel active on its child routes', () => {
    const panels = [
      { path: '/admin', label: 'Registrations', group: 'Configure' as const },
      { path: '/admin/users', label: 'Users', group: 'Configure' as const },
    ];
    render(
      withTheme(
        <MemoryRouter initialEntries={['/admin/users']}>
          <Routes>
            <Route path="/admin" element={<Layout panels={panels} />}>
              <Route path="users" element={<p>Users destination</p>} />
            </Route>
          </Routes>
        </MemoryRouter>,
      ),
    );

    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(
      within(nav).getByRole('link', { name: 'Registrations' }).getAttribute('aria-current'),
    ).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Users' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  test('separates the operational dashboard from the incident queue and detail routes', () => {
    const dashboardRoute = matchRoutes(router.routes, '/w')?.at(-1)?.route;
    const incidentsRoute = matchRoutes(router.routes, '/w/incidents')?.at(-1)?.route;
    const incidentRoute = matchRoutes(router.routes, '/w/incidents/incident-1')?.at(-1)?.route;

    expect(dashboardRoute?.index).toBe(true);
    expect(dashboardRoute?.element).toMatchObject({ type: DashboardPanel });
    expect(incidentsRoute?.path).toBe('incidents');
    expect(incidentsRoute?.element).toMatchObject({ type: IncidentsPanel });
    expect(incidentRoute?.path).toBe('incidents/:id');
  });

  test('exposes every panel in the primary rail and compact navigation', () => {
    renderLayout({ initialEntry: '/w/settings' });

    const primaryNav = screen.getByRole('navigation', { name: 'Primary navigation' });
    for (const panel of PANELS) {
      expect(within(primaryNav).getByRole('link', { name: panel.label }).getAttribute('href')).toBe(
        panel.path,
      );
    }
    expect(
      within(primaryNav).getByRole('link', { name: 'Settings' }).getAttribute('aria-current'),
    ).toBe('page');

    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    for (const panel of PANELS) {
      expect(within(drawer).getByRole('link', { name: panel.label }).getAttribute('href')).toBe(
        panel.path,
      );
    }
    expect(
      within(drawer).getByRole('link', { name: 'Settings' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(document.activeElement).toBe(within(drawer).getByRole('link', { name: 'Dashboard' }));

    fireEvent.click(within(drawer).getByRole('link', { name: 'Infrastructure' }));

    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    expect(
      within(primaryNav).getByRole('link', { name: 'Infrastructure' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.getByText('Panel destination')).toBeDefined();
  });

  test('Escape closes compact navigation and restores focus to its trigger', () => {
    renderLayout();

    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(trigger);
    const firstLink = within(screen.getByRole('dialog', { name: 'Navigation' })).getByRole('link', {
      name: 'Dashboard',
    });
    expect(document.activeElement).toBe(firstLink);

    fireEvent.keyDown(firstLink, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  test('contains keyboard focus within compact navigation', () => {
    renderLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    const closeButton = within(drawer).getByRole('button', { name: 'Close navigation' });
    const lastControl = within(drawer).getByRole('combobox', { name: 'Appearance' });

    lastControl.focus();
    fireEvent.keyDown(lastControl, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastControl);
  });

  test('groups navigation by responder task instead of presenting an undifferentiated list', () => {
    renderLayout();

    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const expected = {
      Respond: ['Dashboard', 'Incidents', 'Signals'],
      Observe: [
        'Infrastructure',
        'Deployments',
        'Changes',
        'Topology',
        'Reliability',
        'Error budgets',
      ],
      Configure: ['Connections', 'Inbound', 'Usage & Cost', 'Settings'],
    };
    for (const [group, links] of Object.entries(expected)) {
      const section = within(nav).getByRole('region', { name: group });
      expect(
        within(section)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(links);
    }
  });

  test.each([
    [{ name: 'Dev User', email: 'dev@example.com' }, 'Dev User'],
    [{ email: 'dev@example.com' }, 'dev@example.com'],
    [undefined, 'Signed in'],
  ])('renders the expected identity fallback for %o', (user, expected) => {
    renderLayout({ user });

    expect(screen.getByText(expected)).toBeDefined();
  });

  test('preserves logout behavior in the responsive shell', () => {
    const onLogout = vi.fn();
    renderLayout({ user: { name: 'Dev User' }, onLogout });

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect(onLogout).toHaveBeenCalledOnce();
  });

  // the page is where the operator says which Slack channels we listen to — "Inbound", not the
  // internal "Surfaces" jargon.
  test('the nav entry reads "Inbound", not "Surfaces"', () => {
    const labels = PANELS.map((p) => p.label);
    expect(labels).toContain('Inbound');
    expect(labels).not.toContain('Surfaces');
  });
});
