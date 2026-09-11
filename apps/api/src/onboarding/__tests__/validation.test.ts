import { describe, expect, test } from 'vitest';
import { workspaceSlug } from '../validation';

const RESERVED_ROOT_SLUGS = [
  'auth',
  'changes',
  'connectors',
  'deployments',
  'get-started',
  'incidents',
  'infrastructure',
  'login',
  'reliability',
  'settings',
  'sign-in',
  'signals',
  'surfaces',
  'topology',
  'usage',
  'w',
  'welcome',
  'workspace-directory-unverified',
  'workspace-removed',
  'workspace-suspended',
] as const;

describe('workspaceSlug', () => {
  test.each(RESERVED_ROOT_SLUGS)('rejects the reserved root route %s', (slug) => {
    expect(workspaceSlug(slug)).toBeNull();
    expect(workspaceSlug(` ${slug.toUpperCase()} `)).toBeNull();
  });

  test('keeps canonical workspace addresses available', () => {
    expect(workspaceSlug(' Acme-Engineering ')).toBe('acme-engineering');
  });
});
