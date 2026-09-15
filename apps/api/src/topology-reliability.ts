import { Hono } from 'hono';
import { type Db } from '@sre/db';
import { sloStatusForService } from '@sre/slo';
import type { TenantAuthVariables } from './auth';

/** Expose the existing measured objective read model with the query supporting each figure. */
export function topologyReliabilityRoutes(db: Db) {
  const routes = new Hono<{ Variables: TenantAuthVariables }>();
  routes.get('/services/:name/reliability', async (c) => {
    const { tenantId } = c.get('tenant');
    const name = c.req.param('name');
    return c.json({ objectives: await sloStatusForService(db, tenantId, name) });
  });
  return routes;
}
