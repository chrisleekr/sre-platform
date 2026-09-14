import {
  listPublicProviders,
  findVerifiedDirectoryByDomain,
  getWorkspaceAddressAvailability,
  listWorkspaceSignInMethods,
  type Db,
  type PublicProvider,
} from '@sre/db';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PublicRateLimiter } from './contracts';
import { isPublicEmailDomain, workspaceSlug } from './validation';

const MAX_DISCOVERY_BODY_BYTES = 1024;

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  return email;
}

function providerProjection(provider: PublicProvider) {
  return {
    id: provider.id,
    displayName: provider.displayName,
    issuer: provider.issuer,
    authorizationEndpoint: provider.authorizationEndpoint,
    browserClientId: provider.browserClientId,
    authorizationScopes: provider.authorizationScopes,
    authorizationAudience: provider.authorizationAudience,
  };
}

/** Builds public returning-user discovery and workspace-specific sign-in routes. */
export function authDiscoveryRoutes(deps: {
  db: Db;
  limiter?: PublicRateLimiter;
  sourceAddress?: (c: Context) => string;
}): Hono {
  const routes = new Hono();
  routes.use(
    '/auth/discover',
    bodyLimit({
      maxSize: MAX_DISCOVERY_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
  );
  routes.post('/auth/discover', async (c) => {
    if (!deps.limiter) return c.json({ error: 'sign-in discovery is unavailable' }, 503);
    let source: string;
    try {
      if (!deps.sourceAddress) throw new Error('request source resolver is unavailable');
      source = deps.sourceAddress(c);
      if (!(await deps.limiter.allow('auth-discover', source, 20, 60_000))) {
        return c.json({ error: 'too many discovery requests' }, 429);
      }
    } catch {
      return c.json({ error: 'sign-in discovery is unavailable' }, 503);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const email = normalizedEmail((body as { email?: unknown } | null)?.email);
    if (!email) return c.json({ error: 'valid email is required', code: 'invalid_email' }, 400);
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const directory = await findVerifiedDirectoryByDomain(deps.db, domain);
    if (directory) return c.json({ kind: 'directory', provider: providerProjection(directory) });
    const providers = (await listPublicProviders(deps.db)).filter(
      (provider) => provider.scope === 'installation',
    );
    if (providers.length === 1) {
      const provider = providers[0]!;
      return c.json({
        kind: provider.supportsSignup ? 'signup' : 'installation',
        provider: providerProjection(provider),
      });
    }
    if (providers.length > 1)
      return c.json({ kind: 'choose_provider', providers: providers.map(providerProjection) });
    return c.json({ kind: 'unknown' });
  });

  // Unauthenticated and reached from a public URL, so the address is validated and the request is
  // metered before the control-plane database is touched. Metering raises the cost of walking the
  // address space; it does not close it, because a 200 still differs from a 404.
  routes.get('/workspaces/:slug/sign-in-methods', async (c) => {
    const slug = workspaceSlug(c.req.param('slug'));
    if (!slug) {
      return c.json({ error: 'invalid workspace address', code: 'invalid_workspace_address' }, 400);
    }
    if (!deps.limiter || !deps.sourceAddress) {
      return c.json({ error: 'workspace sign-in methods are unavailable' }, 503);
    }
    try {
      const source = deps.sourceAddress(c);
      if (!(await deps.limiter.allow('workspace-sign-in-methods', source, 30, 60_000))) {
        return c.json({ error: 'too many workspace sign-in requests' }, 429);
      }
    } catch {
      // The limiter has no internal try/catch, so without this the route would fail open.
      return c.json({ error: 'workspace sign-in methods are unavailable' }, 503);
    }
    const result = await listWorkspaceSignInMethods(deps.db, slug);
    return result
      ? c.json(result)
      : c.json({ error: 'workspace not found', code: 'workspace_not_found' }, 404);
  });
  routes.get('/workspace-addresses/:slug/availability', async (c) => {
    const slug = workspaceSlug(c.req.param('slug'));
    if (!slug) {
      return c.json({ available: false, code: 'invalid_workspace_address' }, 400);
    }
    if (!deps.limiter || !deps.sourceAddress) {
      return c.json({ error: 'workspace availability is unavailable' }, 503);
    }
    try {
      const source = deps.sourceAddress(c);
      if (!(await deps.limiter.allow('workspace-address-availability', source, 30, 60_000))) {
        return c.json({ error: 'too many workspace availability requests' }, 429);
      }
    } catch {
      return c.json({ error: 'workspace availability is unavailable' }, 503);
    }
    const availability = await getWorkspaceAddressAvailability(deps.db, slug);
    return c.json(
      availability.available
        ? availability
        : { available: false as const, code: 'workspace_address_taken' as const },
    );
  });
  routes.get('/workspace-email-domains/:domain/eligibility', (c) => {
    const domain = c.req.param('domain').trim().toLowerCase();
    if (!domain || domain.length > 253 || !domain.includes('.')) {
      return c.json({ eligible: false, code: 'invalid_email_domain' }, 400);
    }
    return isPublicEmailDomain(domain)
      ? c.json({ eligible: false, code: 'public_email_domain' })
      : c.json({ eligible: true });
  });
  return routes;
}
