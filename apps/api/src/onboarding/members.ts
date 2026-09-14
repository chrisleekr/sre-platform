import {
  MembershipMutationError,
  createTenantInvitation,
  getWorkspaceSummary,
  getWorkspaceOwnership,
  listTenantInvitations,
  listTenantMembers,
  removeTenantMember,
  resendTenantInvitation,
  revokeTenantInvitation,
  setTenantMemberRole,
  transferTenantOwnership,
  type Db,
} from '@sre/db';
import type { Notifier } from '@sre/notifications';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  refuseImpersonatedChange,
  requireTenant,
  requireUser,
  type AuthDeps,
  type AuthVariables,
} from '../auth';

const MAX_MEMBER_MUTATION_BODY_BYTES = 4 * 1024;

function uniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === '23505' || candidate.cause?.code === '23505';
}

function mutationResponse(c: Context, error: unknown) {
  if (!(error instanceof MembershipMutationError)) throw error;
  const status =
    error.code === 'last_owner' || error.code === 'invalid_target'
      ? 409
      : error.code === 'member_not_found'
        ? 404
        : 403;
  return c.json({ error: error.message, code: error.code }, status);
}

/** Builds workspace member and invitation administration routes. */
export function memberRoutes(deps: {
  auth: AuthDeps;
  db: Db;
  notifier?: Notifier;
}): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  // Sibling identity-only recovery routes must remain reachable without tenant access.
  for (const path of [
    '/tenant/members',
    '/tenant/members/*',
    '/tenant/invitations',
    '/tenant/invitations/*',
  ]) {
    routes.use(path, requireUser(deps.auth), requireTenant());
    // Who belongs to a workspace is the workspace's own decision. A support session may read the
    // roster while diagnosing, but inviting, revoking, re-roling or removing is never support work.
    routes.use(path, refuseImpersonatedChange());
  }
  for (const path of ['/tenant/invitations', '/tenant/members/:userId/role']) {
    routes.use(
      path,
      bodyLimit({
        maxSize: MAX_MEMBER_MUTATION_BODY_BYTES,
        onError: (c) => c.json({ error: 'payload too large' }, 413),
      }),
    );
  }

  routes.get('/tenant/members', async (c) => {
    const tenant = c.get('tenant')!;
    const members = await listTenantMembers(deps.db, tenant.tenantId);
    const ownership = await getWorkspaceOwnership(deps.db, tenant.tenantId);
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      return c.json({
        members: members
          .filter((member) => member.status === 'active')
          .map(({ userId, email, role, status }) => ({ userId, email, role, status })),
        ownership,
      });
    }
    const invitations = await listTenantInvitations(deps.db, tenant.tenantId);
    return c.json({ members, invitations, ownership });
  });

  routes.post('/tenant/invitations', async (c) => {
    const tenant = c.get('tenant')!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      return c.json({ error: 'workspace administrator required' }, 403);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const email =
      typeof (body as { email?: unknown } | null)?.email === 'string'
        ? (body as { email: string }).email.trim().toLowerCase()
        : '';
    const role = (body as { role?: unknown } | null)?.role;
    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+$/.test(email) ||
      (role !== 'admin' && role !== 'member')
    ) {
      return c.json({ error: 'valid email and role are required' }, 400);
    }
    try {
      const invitation = await createTenantInvitation(deps.db, {
        tenantId: tenant.tenantId,
        email,
        role,
        invitedByUserId: tenant.userId,
      });
      const workspace = await getWorkspaceSummary(deps.db, tenant.tenantId);
      await deps.notifier?.notify(
        { email: invitation.email },
        'invitation.created',
        {
          workspaceName: workspace?.name ?? 'your workspace',
          role: invitation.role,
        },
        { tenantId: tenant.tenantId, eventKey: `invitation:${invitation.id}:created` },
      );
      return c.json({ invitation }, 201);
    } catch (error) {
      if (uniqueViolation(error))
        return c.json({ error: 'pending invitation already exists' }, 409);
      throw error;
    }
  });

  routes.post('/tenant/invitations/:id/resend', async (c) => {
    const tenant = c.get('tenant')!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      return c.json({ error: 'workspace administrator required' }, 403);
    }
    const invitation = await resendTenantInvitation(deps.db, tenant.tenantId, c.req.param('id'));
    if (invitation) {
      const workspace = await getWorkspaceSummary(deps.db, tenant.tenantId);
      await deps.notifier?.notify(
        { email: invitation.email },
        'invitation.created',
        {
          workspaceName: workspace?.name ?? 'your workspace',
          role: invitation.role,
        },
        {
          tenantId: tenant.tenantId,
          eventKey: `invitation:${invitation.id}:resend:${invitation.expiresAt.toISOString()}`,
        },
      );
    }
    return invitation ? c.json({ invitation }) : c.json({ error: 'invitation not found' }, 404);
  });

  routes.delete('/tenant/invitations/:id', async (c) => {
    const tenant = c.get('tenant')!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      return c.json({ error: 'workspace administrator required' }, 403);
    }
    const invitation = await revokeTenantInvitation(deps.db, tenant.tenantId, c.req.param('id'));
    return invitation ? c.json({ invitation }) : c.json({ error: 'invitation not found' }, 404);
  });

  routes.put('/tenant/members/:userId/role', async (c) => {
    const tenant = c.get('tenant')!;
    const body: unknown = await c.req.json().catch(() => null);
    const role = (body as { role?: unknown } | null)?.role;
    if (role !== 'admin' && role !== 'member')
      return c.json({ error: 'valid role is required' }, 400);
    try {
      const result = await setTenantMemberRole(deps.db, {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        targetUserId: c.req.param('userId'),
        role,
      });
      return c.json(result);
    } catch (error) {
      return mutationResponse(c, error);
    }
  });

  routes.post('/tenant/members/:userId/transfer-ownership', async (c) => {
    const tenant = c.get('tenant')!;
    try {
      await transferTenantOwnership(deps.db, {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        targetUserId: c.req.param('userId'),
      });
      const targetUserId = c.req.param('userId');
      const workspace = await getWorkspaceSummary(deps.db, tenant.tenantId);
      await Promise.all(
        [tenant.userId, targetUserId].map((userId) =>
          deps.notifier?.notify(
            { userId },
            'workspace.ownership_transferred',
            { workspaceName: workspace?.name ?? 'your workspace' },
            { tenantId: tenant.tenantId },
          ),
        ),
      );
      return c.json({ ok: true });
    } catch (error) {
      return mutationResponse(c, error);
    }
  });

  routes.delete('/tenant/members/:userId', async (c) => {
    const tenant = c.get('tenant')!;
    try {
      const result = await removeTenantMember(deps.db, {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        targetUserId: c.req.param('userId'),
      });
      await deps.auth.revoke.publish({ userId: result.userId, tenantId: tenant.tenantId });
      return c.json(result);
    } catch (error) {
      return mutationResponse(c, error);
    }
  });
  return routes;
}
