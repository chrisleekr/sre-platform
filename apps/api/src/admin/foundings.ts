import {
  FOUNDING_STATUSES,
  approveAdminFounding,
  listAdminFoundings,
  rejectAdminFounding,
  retryAdminFounding,
  type FoundingStatus,
} from '@sre/db';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminRoutesDeps, AdminVariables } from './contracts';
import { adminBody, adminMutationResponse } from './support';

const reasonBody = z.object({ reason: z.string().trim().min(3).max(2_000) }).strict();

/** Builds platform-administrator registration review routes. */
export function adminFoundingRoutes(deps: AdminRoutesDeps) {
  const routes = new Hono<{ Variables: AdminVariables }>();
  routes.get('/', async (c) => {
    const status = c.req.query('status');
    if (status && !FOUNDING_STATUSES.includes(status as FoundingStatus)) {
      return c.json({ error: 'invalid registration status' }, 400);
    }
    return c.json({
      foundings: await listAdminFoundings(deps.controlDb, status as FoundingStatus),
    });
  });
  routes.post('/:id/approve', async (c) => {
    if (!deps.queue || !deps.notifier)
      return c.json({ error: 'registration workflow is unavailable' }, 503);
    try {
      const result = await approveAdminFounding(deps.controlDb, {
        actorUserId: c.get('user').userId,
        foundingId: c.req.param('id'),
        insertJobTx: deps.queue.insertProvisionTx.bind(deps.queue),
      });
      await deps.queue.publishJob(result.jobId).catch(() => undefined);
      const founding = result.founding;
      await deps.notifier.notify(
        founding.founderUserId
          ? { userId: founding.founderUserId }
          : { email: result.recipient?.founderEmail ?? undefined },
        'founding.approved',
        { workspaceName: founding.requestedName },
        { eventKey: `founding:${founding.id}:approved` },
      );
      return c.json({ founding }, 202);
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.post('/:id/reject', async (c) => {
    if (!deps.notifier) return c.json({ error: 'registration workflow is unavailable' }, 503);
    const body = await adminBody(c, reasonBody);
    if (!body) return c.json({ error: 'a reason is required' }, 400);
    try {
      const result = await rejectAdminFounding(deps.controlDb, {
        actorUserId: c.get('user').userId,
        foundingId: c.req.param('id'),
        reason: body.reason,
      });
      const founding = result.founding;
      await deps.notifier.notify(
        founding.founderUserId
          ? { userId: founding.founderUserId }
          : { email: result.recipient?.founderEmail ?? undefined },
        'founding.rejected',
        { workspaceName: founding.requestedName, reason: body.reason },
        { eventKey: `founding:${founding.id}:rejected` },
      );
      return c.json({ founding });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.post('/:id/retry', async (c) => {
    if (!deps.queue) return c.json({ error: 'registration workflow is unavailable' }, 503);
    try {
      const result = await retryAdminFounding(deps.controlDb, {
        actorUserId: c.get('user').userId,
        foundingId: c.req.param('id'),
        insertJobTx: deps.queue.insertProvisionTx.bind(deps.queue),
      });
      await deps.queue.publishJob(result.jobId).catch(() => undefined);
      return c.json({ founding: result.founding }, 202);
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  return routes;
}
