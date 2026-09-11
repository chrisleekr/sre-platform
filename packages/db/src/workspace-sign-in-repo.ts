import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from './client';
import { identityProviders, tenantIdentityBindings, tenants, workspaceFoundings } from './schema';

/** Lists active sign-in methods and a separate owner-only path for unfinished DNS setup.
 * @param db - Control-plane database connection.
 * @param slug - Public workspace address.
 */
export async function listWorkspaceSignInMethods(db: Db, slug: string) {
  const [workspace] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      deleteAfter: tenants.deleteAfter,
    })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  const provider = {
    providerId: identityProviders.id,
    displayName: identityProviders.displayName,
    issuer: identityProviders.issuer,
    authorizationEndpoint: identityProviders.authorizationEndpoint,
    browserClientId: identityProviders.browserClientId,
    scope: identityProviders.scope,
    authorizationScopes: identityProviders.authorizationScopes,
    authorizationAudience: identityProviders.authorizationAudience,
  };
  const browserRegistration = and(
    eq(identityProviders.kind, 'oidc'),
    isNotNull(identityProviders.authorizationEndpoint),
    isNotNull(identityProviders.browserClientId),
  );
  if (!workspace) return null;
  const methods = await db
    .select(provider)
    .from(tenantIdentityBindings)
    .innerJoin(identityProviders, eq(identityProviders.id, tenantIdentityBindings.providerId))
    .where(
      and(
        eq(tenantIdentityBindings.tenantId, workspace.id),
        eq(identityProviders.status, 'active'),
        browserRegistration,
      ),
    )
    .orderBy(
      asc(tenantIdentityBindings.sortOrder),
      asc(identityProviders.createdAt),
      asc(identityProviders.id),
    );
  const [setup] =
    workspace.status === 'active'
      ? await db
          .select({ foundingId: workspaceFoundings.id, provider })
          .from(workspaceFoundings)
          .innerJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
          .innerJoin(
            tenantIdentityBindings,
            and(
              eq(tenantIdentityBindings.providerId, identityProviders.id),
              eq(tenantIdentityBindings.tenantId, workspace.id),
            ),
          )
          .where(
            and(
              eq(workspaceFoundings.tenantId, workspace.id),
              eq(workspaceFoundings.status, 'active'),
              isNotNull(workspaceFoundings.founderUserId),
              eq(identityProviders.status, 'pending_verification'),
              browserRegistration,
            ),
          )
          .limit(1)
      : [];
  return { workspace, methods, setup: setup ? { ...setup, returnTo: '/welcome' } : null };
}
