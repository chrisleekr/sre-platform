import {
  USER_STATUSES,
  getAdminUser,
  grantAdminRole,
  listAdminUsers,
  removeAdminMembership,
  revokeAdminRole,
  setAdminUserStatus,
  signOutAdminUser,
  tombstoneAdminUser,
  type UserStatus,
} from '@sre/db';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminRoutesDeps, AdminVariables } from './contracts';
import { adminBody, adminMutationResponse } from './support';

const reasonBody = z.object({ reason: z.string().trim().min(3).max(2_000) }).strict();
const optionalReasonBody = z
  .object({ reason: z.string().trim().min(3).max(2_000).optional() })
  .strict();

async function optionalReason(c: Parameters<typeof adminBody>[0]) {
  return adminBody(c, optionalReasonBody);
}

async function publishUserRevocation(deps: AdminRoutesDeps, userId: string, tenantId?: string) {
  await deps.auth.revoke
    .publish({ userId, ...(tenantId ? { tenantId } : {}) })
    .catch(() => undefined);
}

/** Builds platform-administrator identity and session-control routes. */
export function adminUserRoutes(deps: AdminRoutesDeps) {
  const routes = new Hono<{ Variables: AdminVariables }>();
  routes.get('/', async (c) => {
    const status = c.req.query('status');
    if (status && !USER_STATUSES.includes(status as UserStatus)) {
      return c.json({ error: 'invalid user status' }, 400);
    }
    return c.json({
      users: await listAdminUsers(deps.controlDb, {
        query: c.req.query('q'),
        status: status as UserStatus,
      }),
    });
  });
  routes.get('/:id', async (c) => {
    const user = await getAdminUser(deps.controlDb, c.req.param('id'));
    return user ? c.json({ user }) : c.json({ error: 'user not found' }, 404);
  });
  routes.post('/:id/disable', async (c) => {
    if (!deps.notifier) return c.json({ error: 'notification delivery is unavailable' }, 503);
    const body = await adminBody(c, reasonBody);
    if (!body) return c.json({ error: 'a reason is required' }, 400);
    try {
      const user = await setAdminUserStatus(deps.appDb, {
        actorUserId: c.get('user').userId,
        userId: c.req.param('id'),
        status: 'disabled',
        reason: body.reason,
      });
      await publishUserRevocation(deps, user.id);
      await deps.notifier.notify(
        { userId: user.id },
        'account.disabled',
        { reason: body.reason },
        { eventKey: `account:${user.id}:disabled:${user.adminActionId}` },
      );
      return c.json({ user });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.post('/:id/enable', async (c) => {
    const body = await optionalReason(c);
    if (!body) return c.json({ error: 'invalid request' }, 400);
    try {
      return c.json({
        user: await setAdminUserStatus(deps.appDb, {
          actorUserId: c.get('user').userId,
          userId: c.req.param('id'),
          status: 'active',
          reason: body.reason,
        }),
      });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.post('/:id/sign-out-everywhere', async (c) => {
    if (!deps.notifier) return c.json({ error: 'notification delivery is unavailable' }, 503);
    const body = await optionalReason(c);
    if (!body) return c.json({ error: 'invalid request' }, 400);
    const userId = c.req.param('id');
    try {
      const notBefore = await signOutAdminUser(deps.appDb, {
        actorUserId: c.get('user').userId,
        userId,
        reason: body.reason,
      });
      await publishUserRevocation(deps, userId);
      await deps.notifier.notify(
        { userId },
        'account.signed_out',
        {},
        { eventKey: `account:${userId}:signed-out:${notBefore.toISOString()}` },
      );
      return c.json({ notBefore });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.delete('/:id/memberships/:tenantId', async (c) => {
    const body = await optionalReason(c);
    if (!body) return c.json({ error: 'invalid request' }, 400);
    try {
      const membership = await removeAdminMembership(deps.appDb, {
        actorUserId: c.get('user').userId,
        userId: c.req.param('id'),
        tenantId: c.req.param('tenantId'),
        reason: body.reason,
      });
      await publishUserRevocation(deps, membership.userId, membership.tenantId);
      return c.json({ removed: true });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.post('/:id/grant-admin', async (c) => adminRoleMutation(c, deps, true));
  routes.post('/:id/revoke-admin', async (c) => adminRoleMutation(c, deps, false));
  routes.delete('/:id', async (c) => {
    const body = await adminBody(c, reasonBody);
    if (!body) return c.json({ error: 'a reason is required' }, 400);
    try {
      const user = await tombstoneAdminUser(deps.controlDb, {
        actorUserId: c.get('user').userId,
        userId: c.req.param('id'),
        reason: body.reason,
      });
      await publishUserRevocation(deps, user.id);
      return c.json({ deleted: true });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  return routes;
}

async function adminRoleMutation(
  c: Parameters<typeof adminBody>[0],
  deps: AdminRoutesDeps,
  grant: boolean,
) {
  const body = await optionalReason(c);
  if (!body) return c.json({ error: 'invalid request' }, 400);
  const userId = c.req.param('id');
  if (!userId) return c.json({ error: 'user not found' }, 404);
  try {
    const mutate = grant ? grantAdminRole : revokeAdminRole;
    const result = await mutate(deps.controlDb, {
      actorUserId: c.get('user').userId,
      userId,
      reason: body.reason,
    });
    return c.json(result);
  } catch (error) {
    return adminMutationResponse(c, error) ?? Promise.reject(error);
  }
}
