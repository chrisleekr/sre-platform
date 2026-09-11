import {
  countPendingAdminFoundings,
  findOpenFoundingForUser,
  dismissWorkspaceWelcome,
  getWorkspaceDomain,
  getWorkspaceSummary,
  getWorkspaceWelcome,
  isPlatformAdminIdentity,
  listWorkspacesForUser,
  markWorkspaceWelcomeShown,
  type Db,
  identityProviders,
} from '@sre/db';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { requireOnboardingUser, requireTenant, type AuthDeps, type AuthVariables } from '../auth';
import type { PublicRateLimiter } from './contracts';

/** Builds the identity-first current-user projection used by onboarding and workspace switching. */
export function meRoutes(deps: {
  auth: AuthDeps;
  db: Db;
  limiter?: PublicRateLimiter;
  sourceAddress?: (c: Context) => string;
}): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const requireMeUser = requireOnboardingUser(deps.auth, {
    limiter: deps.limiter,
    sourceAddress: deps.sourceAddress,
  });
  routes.get('/me', requireMeUser, async (c) => {
    const user = c.get('user');
    const tenant = c.get('tenant');
    const [founding, workspaces, platformAdmin, workspace, welcome, domain] = await Promise.all([
      findOpenFoundingForUser(deps.db, user.userId),
      listWorkspacesForUser(deps.db, user.userId, user.applicationSessionId),
      isPlatformAdminIdentity(deps.db, {
        userId: user.userId,
        providerId: user.providerId,
        allowLocal: deps.auth.allowLocalPlatformAdmin,
      }),
      tenant ? getWorkspaceSummary(deps.db, tenant.tenantId) : null,
      tenant
        ? getWorkspaceWelcome(deps.db, { tenantId: tenant.tenantId, userId: user.userId })
        : null,
      tenant ? getWorkspaceDomain(deps.db, { tenantId: tenant.tenantId }) : null,
    ]);
    const pendingRegistrationCount = platformAdmin ? await countPendingAdminFoundings(deps.db) : 0;
    const [directory] = founding?.providerId
      ? await deps.db
          .select({
            id: identityProviders.id,
            displayName: identityProviders.displayName,
            issuer: identityProviders.issuer,
          })
          .from(identityProviders)
          .where(eq(identityProviders.id, founding.providerId))
          .limit(1)
      : [];
    const accessState = c.get('tenantAccessState');
    const state = tenant
      ? 'active'
      : accessState && accessState !== 'unaffiliated'
        ? accessState
        : founding
          ? 'founding'
          : 'unaffiliated';
    return c.json({
      user: {
        id: user.userId,
        email: user.email ?? null,
        isPlatformAdmin: platformAdmin,
        pendingRegistrationCount,
      },
      state,
      tenant:
        tenant && workspace
          ? {
              ...workspace,
              role: tenant.role,
              founderOnly: tenant.founderOnly,
              impersonation: tenant.impersonation
                ? {
                    sessionId: tenant.impersonation.sessionId,
                    reason: tenant.impersonation.reason,
                    expiresAt: tenant.impersonation.expiresAt.toISOString(),
                  }
                : null,
            }
          : null,
      founding: founding
        ? {
            id: founding.id,
            status: founding.status,
            slug: founding.slug,
            requestedName: founding.requestedName,
            failureReason: founding.failureReason,
            domain: founding.declaredDomain,
            provider: directory ?? null,
          }
        : null,
      workspaces,
      welcome,
      domain,
    });
  });
  routes.post('/me/welcome/dismiss', requireMeUser, requireTenant(), async (c) => {
    const tenant = c.get('tenant')!;
    const dismissed = await dismissWorkspaceWelcome(deps.db, {
      tenantId: tenant.tenantId,
      userId: c.get('user').userId,
    });
    return dismissed ? c.json({ dismissed: true }) : c.json({ error: 'workspace not found' }, 404);
  });
  routes.post('/me/welcome/show', requireMeUser, requireTenant(), async (c) => {
    const tenant = c.get('tenant')!;
    const shown = await markWorkspaceWelcomeShown(deps.db, {
      tenantId: tenant.tenantId,
      userId: c.get('user').userId,
    });
    return shown ? c.json({ shown: true }) : c.json({ error: 'workspace not found' }, 404);
  });
  return routes;
}
