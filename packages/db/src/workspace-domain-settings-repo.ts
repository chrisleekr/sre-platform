import { and, count as countRows, eq } from 'drizzle-orm';
import type { Db } from './client';
import { issueDomainChallengeTx } from './domain-repo';
import { identityProviderDomains, identityProviders, tenantIdentityBindings } from './schema';
import {
  boundMethod,
  lockWorkspace,
  requireTenantOwnedMethod,
  WorkspaceSettingsMutationError,
} from './workspace-settings-support';

/** Adds another DNS ownership proof to a bound tenant method.
 * @param db - Control-plane database connection.
 * @param input - Workspace, bound method, and normalized domain.
 */
export function addWorkspaceDomain(
  db: Db,
  input: { tenantId: string; providerId: string; domain: string },
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, input.tenantId);
    requireTenantOwnedMethod(await boundMethod(tx, input.tenantId, input.providerId));
    return issueDomainChallengeTx(tx, input);
  });
}

/** Deletes a domain unless it is the last verified proof keeping an active method trusted.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace owning the domain.
 * @param domainId - Domain proof to remove.
 */
export function deleteWorkspaceDomain(db: Db, tenantId: string, domainId: string) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, tenantId);
    const [domain] = await tx
      .select({
        id: identityProviderDomains.id,
        providerId: identityProviderDomains.providerId,
        status: identityProviderDomains.status,
      })
      .from(identityProviderDomains)
      .innerJoin(identityProviders, eq(identityProviders.id, identityProviderDomains.providerId))
      .innerJoin(
        tenantIdentityBindings,
        eq(tenantIdentityBindings.providerId, identityProviderDomains.providerId),
      )
      .where(
        and(
          eq(identityProviderDomains.id, domainId),
          eq(tenantIdentityBindings.tenantId, tenantId),
        ),
      )
      .limit(1)
      .for('update', { of: identityProviderDomains });
    if (!domain) {
      throw new WorkspaceSettingsMutationError('method_not_found', 'email domain not found');
    }
    const provider = await boundMethod(tx, tenantId, domain.providerId);
    if (provider.scope !== 'tenant') {
      throw new WorkspaceSettingsMutationError(
        'invalid_state',
        'installation sign-in methods are managed by a platform administrator',
      );
    }
    if (domain.status === 'verified' && provider.status === 'active') {
      const [verified] = await tx
        .select({ value: countRows() })
        .from(identityProviderDomains)
        .where(
          and(
            eq(identityProviderDomains.providerId, domain.providerId),
            eq(identityProviderDomains.status, 'verified'),
          ),
        );
      if (Number(verified?.value ?? 0) <= 1) {
        throw new WorkspaceSettingsMutationError(
          'last_verified_domain',
          'verify another email domain before deleting this one',
        );
      }
    }
    await tx.delete(identityProviderDomains).where(eq(identityProviderDomains.id, domainId));
  });
}
