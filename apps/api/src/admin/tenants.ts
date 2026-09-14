import {
  TENANT_STATUSES,
  cancelAdminTenantDeletion,
  clearAdminTenantRequireDirectory,
  createAdminTenantBinding,
  listAdminTenants,
  getAdminTenant,
  setAdminTenantStatus,
  recoverWorkspaceOwner,
  listOwnershipRecoveryMembers,
  type TenantStatus,
} from '@sre/db';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminRoutesDeps, AdminVariables } from './contracts';
import { adminBody, adminMutationResponse } from './support';
import { refuseImpersonatedChange } from '../auth';

const reasonBody = z.object({ reason: z.string().trim().min(3).max(2_000) }).strict();
const bindingBody = z
  .object({ providerId: z.uuid(), claimValue: z.string().trim().min(1).max(500) })
  .strict();

async function publishRevocations(deps: AdminRoutesDeps, userIds: string[], tenantId: string) {
  await Promise.allSettled(userIds.map((userId) => deps.auth.revoke.publish({ userId, tenantId })));
}

/** Builds platform-administrator workspace lifecycle routes. */
export function adminTenantRoutes(deps: AdminRoutesDeps) {
  const routes = new Hono<{ Variables: AdminVariables }>();
  routes.use('/:id/recover-owner', refuseImpersonatedChange());
  routes.get('/:id/recovery-members', async (c) => {
    if (!z.uuid().safeParse(c.req.param('id')).success)
      return c.json({ error: 'valid workspace ID is required' }, 400);
    return c.json({
      members: await listOwnershipRecoveryMembers(deps.controlDb, c.req.param('id')),
    });
  });
  routes.post('/:id/recover-owner', async (c) => {
    const body = await adminBody(c, reasonBody.extend({ userId: z.uuid() }));
    if (!body || !z.uuid().safeParse(c.req.param('id')).success)
      return c.json({ error: 'an exact member and a recovery reason are required' }, 400);
    try {
      const user = c.get('user');
      const result = await recoverWorkspaceOwner(deps.controlDb, {
        actorUserId: user.userId,
        actorProviderId: user.providerId,
        allowLocal: deps.auth.allowLocalPlatformAdmin,
        tenantId: c.req.param('id'),
        ...body,
      });
      await publishRevocations(deps, [result.userId], result.tenantId);
      return c.json(result);
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.get('/', async (c) => {
    const status = c.req.query('status');
    if (status && !TENANT_STATUSES.includes(status as TenantStatus)) {
      return c.json({ error: 'invalid workspace status' }, 400);
    }
    return c.json({
      tenants: await listAdminTenants(deps.controlDb, {
        query: c.req.query('q'),
        status: status as TenantStatus,
      }),
    });
  });
  routes.get('/:id', async (c) => {
    const tenant = await getAdminTenant(deps.controlDb, c.req.param('id'));
    return tenant ? c.json({ tenant }) : c.json({ error: 'workspace not found' }, 404);
  });
  routes.post('/:id/suspend', async (c) => {
    const body = await adminBody(c, reasonBody);
    if (!body) return c.json({ error: 'a reason is required' }, 400);
    try {
      const result = await setAdminTenantStatus(deps.appDb, {
        actorUserId: c.get('user').userId,
        tenantId: c.req.param('id'),
        status: 'suspended',
        reason: body.reason,
      });
      await publishRevocations(deps, result.memberUserIds, result.tenant.id);
      return c.json({ tenant: result.tenant });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.post('/:id/reactivate', async (c) => {
    try {
      const result = await setAdminTenantStatus(deps.appDb, {
        actorUserId: c.get('user').userId,
        tenantId: c.req.param('id'),
        status: 'active',
      });
      return c.json({ tenant: result.tenant });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.post('/:id/cancel-deletion', async (c) => {
    try {
      return c.json({
        tenant: await cancelAdminTenantDeletion(deps.appDb, {
          actorUserId: c.get('user').userId,
          tenantId: c.req.param('id'),
        }),
      });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.post('/:id/clear-require-directory', async (c) => {
    const body = await adminBody(c, reasonBody);
    if (!body) return c.json({ error: 'a reason is required' }, 400);
    try {
      const result = await clearAdminTenantRequireDirectory(deps.appDb, {
        actorUserId: c.get('user').userId,
        tenantId: c.req.param('id'),
        reason: body.reason,
      });
      await Promise.allSettled(
        result.ownerUserIds.map((userId) =>
          deps.notifier?.notify(
            { userId },
            'workspace.require_directory_cleared',
            { workspaceName: result.tenant.name },
            { tenantId: result.tenant.id },
          ),
        ),
      );
      return c.json({ tenant: result.tenant });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.post('/:id/bindings', async (c) => {
    const body = await adminBody(c, bindingBody);
    if (!body) return c.json({ error: 'valid provider binding is required' }, 400);
    try {
      return c.json(
        {
          binding: await createAdminTenantBinding(deps.appDb, {
            actorUserId: c.get('user').userId,
            tenantId: c.req.param('id'),
            ...body,
          }),
        },
        201,
      );
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  return routes;
}
