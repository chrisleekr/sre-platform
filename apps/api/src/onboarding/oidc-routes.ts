import { getActiveOidcProviderById, type Db } from '@sre/db';
import { Hono } from 'hono';

const PROVIDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Publishes non-secret sign-in metadata. Authorization exchanges belong to browser sessions.
 * @param dependencies - Provider store.
 */
export function oidcRoutes(dependencies: { db: Db }) {
  const routes = new Hono();
  routes.get('/auth/oidc/providers/:id', async (c) => {
    const id = c.req.param('id');
    if (!PROVIDER_ID.test(id)) return c.json({ error: 'provider not found' }, 404);
    const provider = await getActiveOidcProviderById(dependencies.db, id);
    if (!provider?.authorizationEndpoint || !provider.browserClientId) {
      return c.json({ error: 'provider not found' }, 404);
    }
    return c.json({
      providerId: provider.id,
      issuer: provider.issuer,
      authorizationEndpoint: provider.authorizationEndpoint,
      clientId: provider.browserClientId,
      scopes: ['openid', 'email', 'profile'],
    });
  });
  return routes;
}
