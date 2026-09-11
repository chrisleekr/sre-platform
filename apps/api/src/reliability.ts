import { Hono } from 'hono';
import {
  readPostmortemReport,
  readRcaCalibration,
  readReliabilityReport,
  type Db,
  type ReliabilityPeriod,
} from '@sre/db';
import { authMiddleware, type AuthDeps, type TenantAuthVariables } from './auth';

/** Authenticated reliability and weekly-report read routes. */
export function reliabilityRoutes(deps: { auth: AuthDeps; db: Db }) {
  const app = new Hono<{ Variables: TenantAuthVariables }>();
  app.use('*', authMiddleware(deps.auth));
  app.get('/', async (c) => {
    const raw = c.req.query('period') ?? 'week';
    if (!['week', 'month', 'quarter'].includes(raw))
      return c.json({ error: 'invalid period' }, 400);
    const tenantId = c.get('tenant').tenantId;
    const serviceAfter = c.req.query('serviceAfter');
    if (serviceAfter && serviceAfter.length > 200)
      return c.json({ error: 'invalid service cursor' }, 400);
    return c.json(
      await readReliabilityReport(deps.db, tenantId, {
        period: raw as ReliabilityPeriod,
        serviceAfter,
        serviceLimit: Math.min(100, Number(c.req.query('serviceLimit') ?? 50) || 50),
      }),
    );
  });
  app.get('/weekly', async (c) => {
    const tenantId = c.get('tenant').tenantId;
    const serviceAfter = c.req.query('serviceAfter');
    if (serviceAfter && serviceAfter.length > 200)
      return c.json({ error: 'invalid service cursor' }, 400);
    return c.json(
      await readReliabilityReport(deps.db, tenantId, {
        period: 'week',
        serviceAfter,
        serviceLimit: Math.min(100, Number(c.req.query('serviceLimit') ?? 50) || 50),
      }),
    );
  });
  // Postmortem action item reporting and the RCA calibration read model. Both are
  // per-tenant read models; neither can open an incident.
  app.get('/postmortems', async (c) =>
    c.json(await readPostmortemReport(deps.db, c.get('tenant').tenantId)),
  );
  app.get('/rca-calibration', async (c) =>
    c.json(await readRcaCalibration(deps.db, c.get('tenant').tenantId)),
  );
  return app;
}
