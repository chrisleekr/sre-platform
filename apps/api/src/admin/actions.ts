import { listAdminActions } from '@sre/db';
import { Hono } from 'hono';
import type { AdminRoutesDeps, AdminVariables } from './contracts';
import { UUID } from './support';

function cursor(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    return typeof parsed.createdAt === 'string' &&
      typeof parsed.id === 'string' &&
      UUID.test(parsed.id)
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

/** Builds the keyset-paginated administrator audit route. */
export function adminActionRoutes(deps: AdminRoutesDeps) {
  const routes = new Hono<{ Variables: AdminVariables }>();
  routes.get('/', async (c) => {
    const after = cursor(c.req.query('after'));
    if (after === null) return c.json({ error: 'invalid cursor' }, 400);
    const result = await listAdminActions(deps.controlDb, {
      limit: 50,
      targetKind: c.req.query('targetKind'),
      targetId: c.req.query('targetId'),
      after,
    });
    return c.json({
      ...result,
      nextCursor: result.nextCursor
        ? Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url')
        : null,
    });
  });
  return routes;
}
