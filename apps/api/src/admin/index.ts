import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import { requirePlatformAdmin, requireUser } from '../auth';
import { adminActionRoutes } from './actions';
import type { AdminRoutesDeps, AdminVariables } from './contracts';
import { adminFoundingRoutes } from './foundings';
import { adminImpersonationRoutes } from './impersonation';
import { adminProviderRoutes } from './providers';
import { adminSettingRoutes } from './settings';
import { adminTenantRoutes } from './tenants';
import { adminUserRoutes } from './users';

const MAX_ADMIN_BODY_BYTES = 16 * 1024;

/** Composes the authenticated platform-administrator control plane. */
export function adminRoutes(deps: AdminRoutesDeps) {
  const routes = new Hono<{ Variables: AdminVariables }>();
  routes.use('*', requireUser(deps.auth));
  routes.use('*', requirePlatformAdmin(deps.auth));
  routes.use(
    '*',
    bodyLimit({
      maxSize: MAX_ADMIN_BODY_BYTES,
      onError: (c) => c.json({ error: 'request body is too large' }, 413),
    }),
  );
  routes.route('/foundings', adminFoundingRoutes(deps));
  routes.route('/tenants', adminTenantRoutes(deps));
  routes.route('/users', adminUserRoutes(deps));
  routes.route('/providers', adminProviderRoutes(deps));
  routes.route('/settings', adminSettingRoutes(deps));
  routes.route('/actions', adminActionRoutes(deps));
  routes.route('/', adminImpersonationRoutes(deps));
  return routes;
}
