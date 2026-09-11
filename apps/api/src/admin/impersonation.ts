import {
  createAdminImpersonation,
  endAdminImpersonation,
  getAdminTenant,
  listOwners,
} from '@sre/db';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminRoutesDeps, AdminVariables } from './contracts';
import { adminBody, adminMutationResponse } from './support';

const startBody = z.object({ reason: z.string().trim().min(10).max(2_000) }).strict();

async function notifyOwners(
  deps: AdminRoutesDeps,
  input: {
    tenantId: string;
    tenantName: string;
    actorEmail?: string;
    state: 'started' | 'ended';
    reason: string;
    expiresAt?: Date;
    sessionId: string;
  },
) {
  if (!deps.notifier) return;
  const owners = await listOwners(deps.controlDb, input.tenantId);
  await Promise.all(
    owners.map((owner) =>
      deps.notifier!.notify(
        { userId: owner.userId },
        'workspace.impersonated',
        {
          workspaceName: input.tenantName,
          actorEmail: input.actorEmail,
          reason: input.reason,
          state: input.state,
          expiresAt: input.expiresAt?.toISOString(),
        },
        {
          tenantId: input.tenantId,
          eventKey: `impersonation:${input.sessionId}:${input.state}`,
        },
      ),
    ),
  );
}

/** Builds bounded platform-support session routes. */
export function adminImpersonationRoutes(deps: AdminRoutesDeps) {
  const routes = new Hono<{ Variables: AdminVariables }>();
  routes.post('/tenants/:id/impersonate', async (c) => {
    if (!deps.notifier) return c.json({ error: 'notification delivery is unavailable' }, 503);
    const body = await adminBody(c, startBody);
    if (!body) return c.json({ error: 'a reason of at least 10 characters is required' }, 400);
    try {
      const session = await createAdminImpersonation(deps.controlDb, {
        actorUserId: c.get('user').userId,
        tenantId: c.req.param('id'),
        reason: body.reason,
      });
      await notifyOwners(deps, {
        tenantId: session.tenantId,
        tenantName: session.tenantName,
        actorEmail: c.get('user').email,
        state: 'started',
        reason: session.reason,
        expiresAt: session.expiresAt,
        sessionId: session.id,
      });
      return c.json({
        session: {
          id: session.id,
          tenantId: session.tenantId,
          tenantName: session.tenantName,
          reason: session.reason,
          expiresAt: session.expiresAt,
        },
      });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  routes.post('/impersonation/:id/end', async (c) => {
    try {
      const session = await endAdminImpersonation(deps.controlDb, {
        actorUserId: c.get('user').userId,
        sessionId: c.req.param('id'),
      });
      const tenant = await getAdminTenantName(deps, session.tenantId);
      await notifyOwners(deps, {
        tenantId: session.tenantId,
        tenantName: tenant,
        actorEmail: c.get('user').email,
        state: 'ended',
        reason: session.reason,
        sessionId: session.id,
      });
      return c.json({ ended: true });
    } catch (error) {
      return adminMutationResponse(c, error) ?? Promise.reject(error);
    }
  });
  return routes;
}

async function getAdminTenantName(deps: AdminRoutesDeps, tenantId: string): Promise<string> {
  return (await getAdminTenant(deps.controlDb, tenantId))?.name ?? 'your workspace';
}
