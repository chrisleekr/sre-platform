import { and, eq } from 'drizzle-orm';
import type { Tx } from './rls';
import { identityProviders, tenantIdentityBindings, tenants } from './schema';

export type WorkspaceSettingsMutationCode =
  | 'workspace_not_found'
  | 'method_not_found'
  | 'last_method'
  | 'current_method'
  | 'method_in_use'
  | 'directory_required_lockout'
  | 'last_verified_domain'
  | 'invalid_state';

/** Stable refusal returned by workspace-settings mutations. */
export class WorkspaceSettingsMutationError extends Error {
  constructor(
    readonly code: WorkspaceSettingsMutationCode,
    message: string,
    readonly count?: number,
  ) {
    super(message);
  }
}

/** Serializes settings and deletion changes for a workspace.
 * @param tx - Transaction that will mutate the workspace.
 * @param tenantId - Workspace whose row must remain locked.
 */
export async function lockWorkspace(tx: Tx, tenantId: string) {
  const [workspace] = await tx
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .for('update');
  if (!workspace) {
    throw new WorkspaceSettingsMutationError('workspace_not_found', 'workspace not found');
  }
  return workspace;
}

/** Restricts a method lookup to a workspace's explicit sign-in connection.
 * @param tx - Current settings transaction.
 * @param tenantId - Workspace owning the connection.
 * @param providerId - Sign-in method being changed.
 */
export async function boundMethod(tx: Tx, tenantId: string, providerId: string) {
  const [method] = await tx
    .select({ provider: identityProviders })
    .from(tenantIdentityBindings)
    .innerJoin(identityProviders, eq(identityProviders.id, tenantIdentityBindings.providerId))
    .where(
      and(
        eq(tenantIdentityBindings.tenantId, tenantId),
        eq(tenantIdentityBindings.providerId, providerId),
      ),
    )
    .limit(1);
  if (!method) {
    throw new WorkspaceSettingsMutationError('method_not_found', 'sign-in method not found');
  }
  return method.provider;
}

/** Keeps shared installation methods under platform administrator control.
 * @param method - Bound method selected for a workspace mutation.
 */
export function requireTenantOwnedMethod(method: typeof identityProviders.$inferSelect): void {
  if (method.scope !== 'tenant') {
    throw new WorkspaceSettingsMutationError(
      'invalid_state',
      'installation sign-in methods are managed by a platform administrator',
    );
  }
}
