import { runStatusCakeSetup } from '@sre/agent-tools';
import type { Hono } from 'hono';
import type { TenantAuthVariables } from '../../auth';
import { connectorInstanceId } from '../helpers';
import type { ConnectorRouteContext } from './context';

/**
 * StatusCake uptime-test listing and contact-group setup. The list is read-only; setup writes only
 * contact groups that point at this connection's webhook and keeps every other group on each test.
 * @param r - Tenant configuration router.
 * @param context - Shared connector route context.
 */
export function registerStatusCakeSetupRoutes(
  r: Hono<{ Variables: TenantAuthVariables }>,
  context: ConnectorRouteContext,
): void {
  const { deps, serializeMutation } = context;
  const setupDeps = {
    db: deps.db,
    secrets: deps.secrets,
    ...(deps.statusCakeFetch ? { fetch: deps.statusCakeFetch } : {}),
    // Shared with the triage worker's background sync, so the two never write at the same time.
    ...(deps.cache?.acquireOwnedLease && deps.cache.releaseOwnedLease
      ? {
          lease: {
            acquire: deps.cache.acquireOwnedLease.bind(deps.cache),
            release: deps.cache.releaseOwnedLease.bind(deps.cache),
          },
        }
      : {}),
  };

  r.get('/statuscake/:id/uptime-tests', async (c) => {
    const tenant = c.get('tenant');
    // Reads normally pass the admin gate, but one listing can spend up to 40 StatusCake requests of
    // the tenant's rate limit, and only the admin setup wizard needs it.
    if (tenant.impersonation || (tenant.role !== 'owner' && tenant.role !== 'admin'))
      return c.json({ error: 'A workspace owner or administrator must set up StatusCake.' }, 403);
    const { tenantId } = tenant;
    const connectorId = connectorInstanceId(c.req.param('id'));
    if (!connectorId) return c.json({ error: 'invalid data source ID' }, 400);
    const run = await runStatusCakeSetup(setupDeps, tenantId, connectorId, false);
    if (run.status === 'not_found') return c.json({ error: 'save the API token first' }, 404);
    return c.json(run);
  });

  r.post('/statuscake/:id/setup', async (c) => {
    const { tenantId } = c.get('tenant');
    const connectorId = connectorInstanceId(c.req.param('id'));
    if (!connectorId) return c.json({ error: 'invalid data source ID' }, 400);
    // Shares the connector's mutation lane so a save cannot interleave with a setup pass.
    const run = await serializeMutation(tenantId, connectorId, () =>
      runStatusCakeSetup(setupDeps, tenantId, connectorId, true),
    );
    if (run.status === 'not_found') return c.json({ error: 'save the API token first' }, 404);
    if (run.status === 'busy')
      return c.json(
        { error: 'StatusCake setup is already running for this connection. Retry in a minute.' },
        409,
      );
    if (run.status === 'list' && !run.error)
      return c.json({ error: 'verify the connection and turn on notifications before setup' }, 409);
    return c.json(run);
  });
}
