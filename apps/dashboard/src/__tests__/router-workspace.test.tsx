// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { Children, isValidElement, type ReactNode } from 'react';
import { matchRoutes } from 'react-router-dom';
import { PANELS } from '../lib/panels';
import { router } from '../router';

function matchedPaths(pathname: string): Array<string | undefined> {
  return matchRoutes(router.routes, pathname)?.map((match) => match.route.path) ?? [];
}

function componentNames(node: ReactNode): string[] {
  if (!isValidElement(node)) return [];
  const type = node.type as { name?: string } | string;
  const name = typeof type === 'string' ? type : type.name;
  const children = Children.toArray((node.props as { children?: ReactNode }).children);
  return [...(name ? [name] : []), ...children.flatMap(componentNames)];
}

describe('public and workspace routing', () => {
  test('keeps public entry points outside the authenticated workspace', () => {
    expect(matchedPaths('/')).toEqual(['/']);
    expect(matchedPaths('/sign-in')).toContain('/sign-in');
    expect(matchedPaths('/login')).toContain('/login');
    expect(matchedPaths('/auth/callback')).toContain('/auth/callback');
    expect(matchedPaths('/get-started/name')).toContain('*');
  });

  test('moves the complete product route set below the workspace prefix', () => {
    expect(matchedPaths('/w/select')).toEqual(['/w/select']);
    const chooser = router.routes.find((route) => route.path === '/w/select');
    expect(componentNames(chooser?.element)).toContain('RequireAuth');
    expect(componentNames(chooser?.element)).not.toContain('RequireWorkspace');
    expect(matchedPaths('/w')).toEqual(['/w', undefined]);
    expect(matchedPaths('/w/incidents')).toContain('incidents');
    expect(matchedPaths('/w/incidents/incident-1')).toContain('incidents/:id');
    expect(matchedPaths('/w/settings/members')).toContain('settings/members');
    expect(matchedPaths('/w/settings/domains/domain-1')).toContain('settings/domains/:id');
    expect(PANELS.every((panel) => panel.path === '/w' || panel.path.startsWith('/w/'))).toBe(true);
    const workspaceRoot = router.routes.find((route) => route.path === '/w');
    expect(componentNames(workspaceRoot?.element)).toContain('RequireWorkspace');
  });

  test('keeps compatibility redirects distinct from the workspace-address catch-all', () => {
    expect(matchedPaths('/incidents/incident-1')).toContain('/incidents/:id');
    expect(matchedPaths('/settings')).toContain('/settings');
    expect(matchedPaths('/reliability/weekly')).toContain('/reliability/weekly');
    expect(matchedPaths('/acme-engineering')).toEqual(['/:slug']);
    for (const staticPath of ['/login', '/sign-in', '/auth/callback', '/get-started', '/welcome']) {
      expect(matchedPaths(staticPath)).not.toContain('/:slug');
    }
  });

  test('registers the platform control room outside tenant routes', () => {
    expect(matchedPaths('/admin')).toEqual(['/admin', undefined]);
    expect(matchedPaths('/admin/workspaces')).toContain('workspaces');
    expect(matchedPaths('/admin/users')).toContain('users');
    expect(matchedPaths('/admin/providers')).toContain('providers');
    expect(matchedPaths('/admin/settings')).toContain('settings');
    expect(matchedPaths('/admin/audit')).toContain('audit');
    const adminRoot = router.routes.find((route) => route.path === '/admin');
    expect(componentNames(adminRoot?.element)).toContain('RequirePlatformAdmin');
  });
});
