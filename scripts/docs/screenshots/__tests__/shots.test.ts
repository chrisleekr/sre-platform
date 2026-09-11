import { describe, expect, test } from 'vitest';
import { SCREENSHOT_MATRIX, SHOTS } from '../shots';

describe('dashboard screenshot route inventory', () => {
  test('captures public onboarding, workspace, and administration routes', () => {
    const routes = new Map(SHOTS.map((shot) => [shot.file, shot]));
    expect(routes.get('landing')).toMatchObject({ path: '/', anonymous: true });
    expect(routes.get('sign-in')).toMatchObject({ path: '/sign-in', anonymous: true });
    expect(routes.get('workspace-sign-in')).toMatchObject({
      path: '/local-dev',
      anonymous: true,
      expectedHeading: 'Local dev (dev@example.test)',
    });
    expect(routes.get('get-started-workspace')).toMatchObject({
      path: '/get-started',
      expectedHeading: 'Create your workspace',
    });
    expect(routes.get('get-started-sign-in')).toMatchObject({
      path: '/get-started',
      anonymous: true,
      expectedHeading: 'Connect company sign-in',
    });
    expect(routes.has('welcome')).toBe(false);
    expect(routes.get('overview')?.path).toBe('/w');
    expect(routes.get('incidents')?.path).toBe('/w/incidents');
    expect(routes.get('incident-detail')?.path).toBe('/w/incidents/:incident');
    expect(routes.get('settings')?.path).toBe('/w/settings');
    expect(routes.get('members')?.path).toBe('/w/settings/members');
    expect(routes.get('domain')?.path).toBe('/w/settings/domains/demo');
    expect(routes.get('admin-registrations')?.path).toBe('/admin');
    expect(routes.get('admin-workspaces')?.path).toBe('/admin/workspaces');
    expect(routes.get('account-menu')).toMatchObject({ path: '/w', click: 'Account menu' });
    expect(routes.get('topology')).toMatchObject({
      path: '/w/topology',
      click: 'Fit services',
      clickSizes: ['desktop'],
    });
    expect(
      [...routes.values()]
        .filter((shot) => !shot.anonymous && !shot.path.startsWith('/get-started'))
        .every((shot) => shot.path.startsWith('/w') || shot.path.startsWith('/admin')),
    ).toBe(true);
  });

  test('covers both themes at desktop and mobile widths', () => {
    expect(SCREENSHOT_MATRIX).toEqual([
      { name: 'desktop', viewport: { width: 1440, height: 960 }, themes: ['light', 'dark'] },
      { name: 'mobile', viewport: { width: 390, height: 844 }, themes: ['light', 'dark'] },
    ]);
  });
});
