import { and, asc, count as countRows, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import { issueDomainChallengeTx } from './domain-repo';
import type { Tx } from './rls';
import {
  identityProviderDomains,
  identityProviders,
  memberships,
  tenantIdentityBindings,
  tenants,
  users,
} from './schema';

import {
  boundMethod,
  lockWorkspace,
  requireTenantOwnedMethod,
  WorkspaceSettingsMutationError,
} from './workspace-settings-support';
export { WorkspaceSettingsMutationError } from './workspace-settings-support';

async function activeMethodCount(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ value: countRows() })
    .from(tenantIdentityBindings)
    .innerJoin(identityProviders, eq(identityProviders.id, tenantIdentityBindings.providerId))
    .innerJoin(tenants, eq(tenants.id, tenantIdentityBindings.tenantId))
    .where(
      and(
        eq(tenantIdentityBindings.tenantId, tenantId),
        eq(identityProviders.status, 'active'),
        sql`(not ${tenants.requireDirectory} or ${identityProviders.scope} = 'tenant')`,
        isNotNull(identityProviders.authorizationEndpoint),
        isNotNull(identityProviders.browserClientId),
      ),
    );
  return Number(row?.value ?? 0);
}

/** Reads the complete workspace-owned authentication and lifecycle settings projection.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace whose settings are returned.
 */
export async function getWorkspaceSettings(db: Db, tenantId: string) {
  const [workspace] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!workspace) return null;
  const methods = await db
    .select({
      id: identityProviders.id,
      displayName: identityProviders.displayName,
      issuer: identityProviders.issuer,
      kind: identityProviders.kind,
      scope: identityProviders.scope,
      status: identityProviders.status,
      browserClientId: identityProviders.browserClientId,
      subjectClaim: identityProviders.subjectClaim,
      backchannelLogout: identityProviders.backchannelLogout,
      backchannelLogoutTypRequired: identityProviders.backchannelLogoutTypRequired,
      scimEnabled: identityProviders.scimEnabled,
      scimTokenCreatedAt: identityProviders.scimTokenCreatedAt,
      scimTokenExpiresAt: identityProviders.scimTokenExpiresAt,
      requireProvisioned: identityProviders.requireProvisioned,
      scimIdentityAttribute: identityProviders.scimIdentityAttribute,
      sortOrder: tenantIdentityBindings.sortOrder,
      createdAt: identityProviders.createdAt,
    })
    .from(tenantIdentityBindings)
    .innerJoin(identityProviders, eq(identityProviders.id, tenantIdentityBindings.providerId))
    .where(eq(tenantIdentityBindings.tenantId, tenantId))
    .orderBy(asc(tenantIdentityBindings.sortOrder), asc(identityProviders.createdAt));
  const providerIds = methods.map((method) => method.id);
  const domains = providerIds.length
    ? await db
        .select({
          id: identityProviderDomains.id,
          providerId: identityProviderDomains.providerId,
          domain: identityProviderDomains.domain,
          status: identityProviderDomains.status,
          challenge: identityProviderDomains.challenge,
          expiresAt: identityProviderDomains.expiresAt,
          lastCheckedAt: identityProviderDomains.lastCheckedAt,
        })
        .from(identityProviderDomains)
        .where(inArray(identityProviderDomains.providerId, providerIds))
        .orderBy(asc(identityProviderDomains.createdAt))
    : [];
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      status: workspace.status,
      requireDirectory: workspace.requireDirectory,
      deleteAfter: workspace.deleteAfter,
    },
    methods,
    domains,
  };
}

/** Changes the mutable workspace display name.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace to rename.
 * @param name - Validated workspace display name.
 */
export async function updateWorkspaceName(db: Db, tenantId: string, name: string) {
  const [workspace] = await db
    .update(tenants)
    .set({ name })
    .where(eq(tenants.id, tenantId))
    .returning({ id: tenants.id, name: tenants.name, slug: tenants.slug });
  if (!workspace) {
    throw new WorkspaceSettingsMutationError('workspace_not_found', 'workspace not found');
  }
  return workspace;
}

/** Creates and binds one pending tenant OIDC method with its first DNS proof.
 * @param db - Control-plane database connection.
 * @param input - Workspace, discovered endpoints, client identifiers, and initial domain.
 */
export function createWorkspaceOidcMethod(
  db: Db,
  input: {
    tenantId: string;
    displayName: string;
    clientId: string;
    apiAudience: string | null;
    clientAuthentication?: 'none' | 'client_secret_post' | 'client_secret_basic';
    subjectClaim: 'sub' | 'oid';
    authorizationScopes?: string[];
    authorizationAudience?: string | null;
    sortOrder: number;
    domain: string;
    metadata: {
      issuer: string;
      jwksUri: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
    };
  },
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, input.tenantId);
    const [provider] = await tx
      .insert(identityProviders)
      .values({
        displayName: input.displayName,
        issuer: input.metadata.issuer,
        jwksUri: input.metadata.jwksUri,
        authorizationEndpoint: input.metadata.authorizationEndpoint,
        tokenEndpoint: input.metadata.tokenEndpoint,
        audience: input.apiAudience,
        kind: 'oidc',
        scope: 'tenant',
        supportsSignup: false,
        emailClaim: 'email',
        tenantClaim: null,
        subjectClaim: input.subjectClaim,
        browserClientId: input.clientId,
        clientAuthentication: input.clientAuthentication ?? 'none',
        authorizationScopes: input.authorizationScopes ?? [],
        authorizationAudience: input.authorizationAudience || null,
        sortOrder: input.sortOrder,
        status: 'pending_verification',
      })
      .returning();
    if (!provider) throw new Error('sign-in method insert returned no row');
    await tx.insert(tenantIdentityBindings).values({
      tenantId: input.tenantId,
      providerId: provider.id,
      claimValue: null,
      sortOrder: input.sortOrder,
    });
    const domain = await issueDomainChallengeTx(tx, {
      providerId: provider.id,
      tenantId: input.tenantId,
      domain: input.domain,
    });
    return { provider, domain };
  });
}

/** Changes the human label and order of one bound sign-in method.
 * @param db - Control-plane database connection.
 * @param input - Bound method identifier, display name, and workspace order.
 */
export function updateWorkspaceMethod(
  db: Db,
  input: { tenantId: string; providerId: string; displayName: string; sortOrder: number },
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, input.tenantId);
    requireTenantOwnedMethod(await boundMethod(tx, input.tenantId, input.providerId));
    const [provider] = await tx
      .update(identityProviders)
      .set({
        displayName: input.displayName,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(identityProviders.id, input.providerId))
      .returning();
    await tx
      .update(tenantIdentityBindings)
      .set({ sortOrder: input.sortOrder })
      .where(
        and(
          eq(tenantIdentityBindings.tenantId, input.tenantId),
          eq(tenantIdentityBindings.providerId, input.providerId),
        ),
      );
    return provider!;
  });
}

/** Enables or disables provider-initiated logout for one workspace-owned OIDC method.
 * @param db - Control-plane database connection.
 * @param input - Workspace, bound method, and desired capability state.
 */
export function setWorkspaceMethodBackchannelLogout(
  db: Db,
  input: { tenantId: string; providerId: string; enabled: boolean; typRequired: boolean },
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, input.tenantId);
    const method = await boundMethod(tx, input.tenantId, input.providerId);
    requireTenantOwnedMethod(method);
    if (method.kind !== 'oidc' || !method.browserClientId) {
      throw new WorkspaceSettingsMutationError('invalid_state', 'OIDC browser client required');
    }
    const [provider] = await tx
      .update(identityProviders)
      .set({
        backchannelLogout: input.enabled,
        backchannelLogoutTypRequired: input.typRequired,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(identityProviders.id, input.providerId))
      .returning();
    return provider!;
  });
}

/** Reorders every sign-in method for one workspace as one atomic change.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace whose method order changes.
 * @param providerIds - Every bound sign-in method, once, in display order.
 */
export function reorderWorkspaceMethods(db: Db, tenantId: string, providerIds: string[]) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, tenantId);
    const bound = await tx
      .select({ providerId: tenantIdentityBindings.providerId })
      .from(tenantIdentityBindings)
      .where(eq(tenantIdentityBindings.tenantId, tenantId));
    const expected = new Set(bound.map(({ providerId }) => providerId));
    if (
      providerIds.length !== expected.size ||
      new Set(providerIds).size !== providerIds.length ||
      providerIds.some((providerId) => !expected.has(providerId))
    ) {
      throw new WorkspaceSettingsMutationError(
        'invalid_state',
        'method order must include every configured sign-in method once',
      );
    }
    for (const [index, providerId] of providerIds.entries()) {
      await tx
        .update(tenantIdentityBindings)
        .set({ sortOrder: index * 10 })
        .where(
          and(
            eq(tenantIdentityBindings.tenantId, tenantId),
            eq(tenantIdentityBindings.providerId, providerId),
          ),
        );
    }
  });
}

/** Disables one active method while preserving another active browser sign-in path.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace owning the method.
 * @param providerId - Active sign-in method to disable.
 * @param actorProviderId - Method the owner used for this request.
 */
export function disableWorkspaceMethod(
  db: Db,
  tenantId: string,
  providerId: string,
  actorProviderId: string,
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, tenantId);
    const method = await boundMethod(tx, tenantId, providerId);
    requireTenantOwnedMethod(method);
    if (method.status !== 'active') {
      throw new WorkspaceSettingsMutationError('invalid_state', 'sign-in method is not active');
    }
    if ((await activeMethodCount(tx, tenantId)) <= 1) {
      throw new WorkspaceSettingsMutationError(
        'last_method',
        'connect another sign-in method before disabling this one',
      );
    }
    if (providerId === actorProviderId) {
      throw new WorkspaceSettingsMutationError(
        'current_method',
        'sign in as an owner through another method before disabling the one you are using',
      );
    }
    const [updated] = await tx
      .update(identityProviders)
      .set({ status: 'disabled', updatedAt: sql`clock_timestamp()` })
      .where(eq(identityProviders.id, providerId))
      .returning();
    return updated!;
  });
}

/** Re-enables a disabled method only after at least one domain has been verified.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace owning the method.
 * @param providerId - Disabled sign-in method to enable.
 */
export function enableWorkspaceMethod(db: Db, tenantId: string, providerId: string) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, tenantId);
    const method = await boundMethod(tx, tenantId, providerId);
    requireTenantOwnedMethod(method);
    if (method.status !== 'disabled') {
      throw new WorkspaceSettingsMutationError('invalid_state', 'sign-in method is not disabled');
    }
    const [verified] = await tx
      .select({ id: identityProviderDomains.id })
      .from(identityProviderDomains)
      .where(
        and(
          eq(identityProviderDomains.providerId, providerId),
          eq(identityProviderDomains.status, 'verified'),
        ),
      )
      .limit(1);
    if (!verified) {
      throw new WorkspaceSettingsMutationError(
        'invalid_state',
        'verify an email domain before enabling this method',
      );
    }
    const [updated] = await tx
      .update(identityProviders)
      .set({ status: 'active', updatedAt: sql`clock_timestamp()` })
      .where(eq(identityProviders.id, providerId))
      .returning();
    return updated!;
  });
}

/** Deletes an unused tenant method while preserving every member's only identity.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace owning the method.
 * @param providerId - Unused sign-in method to remove.
 */
export function deleteWorkspaceMethod(db: Db, tenantId: string, providerId: string) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, tenantId);
    const method = await boundMethod(tx, tenantId, providerId);
    requireTenantOwnedMethod(method);
    if (method.status === 'active' && (await activeMethodCount(tx, tenantId)) <= 1) {
      throw new WorkspaceSettingsMutationError(
        'last_method',
        'connect another sign-in method before deleting this one',
      );
    }
    const [affected] = await tx
      .select({ value: countRows() })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.status, 'active'),
          eq(users.issuer, method.issuer),
        ),
      );
    const affectedCount = Number(affected?.value ?? 0);
    if (affectedCount > 0) {
      throw new WorkspaceSettingsMutationError(
        'method_in_use',
        `${affectedCount} active member${affectedCount === 1 ? '' : 's'} still use this sign-in method`,
        affectedCount,
      );
    }
    await tx
      .delete(tenantIdentityBindings)
      .where(
        and(
          eq(tenantIdentityBindings.tenantId, tenantId),
          eq(tenantIdentityBindings.providerId, providerId),
        ),
      );
    await tx.delete(identityProviders).where(eq(identityProviders.id, providerId));
  });
}

/** Enables or clears the rule that refuses installation-scoped sign-ins.
 * @param db - Control-plane database connection.
 * @param input - Workspace, desired policy, and actor sign-in method.
 */
export function setWorkspaceRequireDirectory(
  db: Db,
  input: { tenantId: string; enabled: boolean; actorProviderId: string },
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, input.tenantId);
    if (input.enabled) {
      const method = await boundMethod(tx, input.tenantId, input.actorProviderId);
      if (method.scope === 'installation' || method.status !== 'active') {
        throw new WorkspaceSettingsMutationError(
          'directory_required_lockout',
          'sign in with a workspace directory before requiring it',
        );
      }
    }
    const [workspace] = await tx
      .update(tenants)
      .set({ requireDirectory: input.enabled })
      .where(eq(tenants.id, input.tenantId))
      .returning({ id: tenants.id, requireDirectory: tenants.requireDirectory });
    return workspace!;
  });
}
