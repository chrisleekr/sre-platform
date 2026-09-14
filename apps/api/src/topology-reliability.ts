import { Hono } from 'hono';
import { listSlosByService, type Db } from '@sre/db';
import { sloStatusForService } from '@sre/slo';
import type { TenantAuthVariables } from './auth';

/** Expose the existing measured objective read model with the query supporting each figure. */
export function topologyReliabilityRoutes(db: Db) {
  const routes = new Hono<{ Variables: TenantAuthVariables }>();
  routes.get('/services/:name/reliability', async (c) => {
    const { tenantId } = c.get('tenant');
    const name = c.req.param('name');
    const [statuses, definitions] = await Promise.all([
      sloStatusForService(db, tenantId, name),
      listSlosByService(db, tenantId, name),
    ]);
    return c.json({
      objectives: statuses.map((status) => {
        const definition = definitions.find((row) => row.name === status.name);
        return {
          ...status,
          metricQuery: definition?.metricQuery ?? null,
          connectorType: definition?.connectorType ?? null,
        };
      }),
    });
  });
  return routes;
}
