const WORKSPACE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const RESERVED_WORKSPACE_SLUGS = new Set([
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
]);

const PUBLIC_EMAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mac.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
]);

/** Returns a canonical workspace address when it satisfies the public URL contract. */
export function workspaceSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  return WORKSPACE_SLUG.test(slug) && !RESERVED_WORKSPACE_SLUGS.has(slug) ? slug : null;
}

/** Identifies consumer mailbox domains that cannot prove organisation ownership. */
export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}
