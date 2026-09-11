import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { identityProviders, type ScimIdentityAttribute } from './schema';
import { appendAdminAction, AdminMutationError } from './admin-repo/support';
import {
  boundMethod,
  lockWorkspace,
  requireTenantOwnedMethod,
  WorkspaceSettingsMutationError,
} from './workspace-settings-support';

export interface ScimCredential {
  hash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface ScimPolicy {
  identityAttribute: ScimIdentityAttribute;
  requireProvisioned: boolean;
}

function values(
  enabled: boolean,
  policy: ScimPolicy,
  credential: ScimCredential | null | undefined,
) {
  return enabled
    ? {
        scimEnabled: true,
        requireProvisioned: policy.requireProvisioned,
        scimIdentityAttribute: policy.identityAttribute,
        ...(credential
          ? {
              scimTokenHash: credential.hash,
              scimTokenCreatedAt: credential.createdAt,
              scimTokenExpiresAt: credential.expiresAt,
            }
          : {}),
        updatedAt: sql`clock_timestamp()`,
      }
    : {
        scimEnabled: false,
        scimTokenHash: null,
        scimTokenCreatedAt: null,
        scimTokenExpiresAt: null,
        requireProvisioned: false,
        scimIdentityAttribute: policy.identityAttribute,
        updatedAt: sql`clock_timestamp()`,
      };
}

function eligible(provider: typeof identityProviders.$inferSelect): boolean {
  return (
    provider.kind === 'oidc' && provider.status === 'active' && Boolean(provider.browserClientId)
  );
}

/** Configures or disables SCIM for one workspace-owned OIDC provider.
 * @param db - Control-plane database connection.
 * @param input - Workspace, provider, policy and credential values.
 */
export function configureWorkspaceScim(
  db: Db,
  input: {
    tenantId: string;
    providerId: string;
    enabled: boolean;
    policy: ScimPolicy;
    credential?: ScimCredential;
  },
) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, input.tenantId);
    const method = await boundMethod(tx, input.tenantId, input.providerId);
    requireTenantOwnedMethod(method);
    if (!eligible(method)) {
      throw new WorkspaceSettingsMutationError(
        'invalid_state',
        'an active OIDC browser method is required for SCIM',
      );
    }
    if (input.enabled && !input.credential && !method.scimTokenHash) {
      throw new WorkspaceSettingsMutationError('invalid_state', 'a SCIM credential is required');
    }
    const [provider] = await tx
      .update(identityProviders)
      .set(values(input.enabled, input.policy, input.credential))
      .where(eq(identityProviders.id, input.providerId))
      .returning();
    if (!provider) throw new Error('SCIM provider update returned no row');
    return provider;
  });
}

/** Configures or disables SCIM for one installation OIDC provider and audits the change.
 * @param db - Control-plane database connection.
 * @param input - Administrator, provider, policy and credential values.
 */
export function configureAdminScim(
  db: Db,
  input: {
    actorUserId: string;
    providerId: string;
    enabled: boolean;
    policy: ScimPolicy;
    credential?: ScimCredential;
    reason?: string;
  },
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(identityProviders)
      .where(
        and(
          eq(identityProviders.id, input.providerId),
          eq(identityProviders.scope, 'installation'),
        ),
      )
      .limit(1)
      .for('update');
    if (!current) throw new AdminMutationError('not_found', 'installation provider not found');
    if (!eligible(current)) {
      throw new AdminMutationError(
        'conflict',
        'an active OIDC browser provider is required for SCIM',
      );
    }
    if (input.enabled && !input.credential && !current.scimTokenHash) {
      throw new AdminMutationError('conflict', 'a SCIM credential is required');
    }
    const [provider] = await tx
      .update(identityProviders)
      .set(values(input.enabled, input.policy, input.credential))
      .where(eq(identityProviders.id, input.providerId))
      .returning();
    if (!provider) throw new Error('SCIM provider update returned no row');
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: input.credential ? 'provider.scim.rotate' : 'provider.scim.update',
      targetKind: 'provider',
      targetId: input.providerId,
      reason: input.reason,
      details: {
        enabled: input.enabled,
        identityAttribute: input.policy.identityAttribute,
        requireProvisioned: input.policy.requireProvisioned,
      },
    });
    return provider;
  });
}
