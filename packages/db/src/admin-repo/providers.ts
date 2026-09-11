import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { identityProviders, type ProviderStatus } from '../schema';
import { AdminMutationError, appendAdminAction } from './support';

export interface AdminProviderPatch {
  displayName?: string;
  issuer?: string;
  jwksUri?: string;
  authorizationEndpoint?: string | null;
  tokenEndpoint?: string | null;
  audience?: string;
  supportsSignup?: boolean;
  emailClaim?: string;
  tenantClaim?: string | null;
  subjectClaim?: string;
  browserClientId?: string | null;
  backchannelLogout?: boolean;
  backchannelLogoutTypRequired?: boolean;
  clientAuthentication?: 'none' | 'client_secret_post' | 'client_secret_basic';
  status?: ProviderStatus;
}

/**
 * Lists only installation-scoped identity providers available to platform administrators.
 *
 * @param db - Control-plane database connection.
 */
export function listAdminProviders(db: Db) {
  return db
    .select({
      id: identityProviders.id,
      displayName: identityProviders.displayName,
      issuer: identityProviders.issuer,
      jwksUri: identityProviders.jwksUri,
      authorizationEndpoint: identityProviders.authorizationEndpoint,
      tokenEndpoint: identityProviders.tokenEndpoint,
      audience: identityProviders.audience,
      kind: identityProviders.kind,
      scope: identityProviders.scope,
      supportsSignup: identityProviders.supportsSignup,
      emailClaim: identityProviders.emailClaim,
      tenantClaim: identityProviders.tenantClaim,
      subjectClaim: identityProviders.subjectClaim,
      browserClientId: identityProviders.browserClientId,
      backchannelLogout: identityProviders.backchannelLogout,
      backchannelLogoutTypRequired: identityProviders.backchannelLogoutTypRequired,
      scimEnabled: identityProviders.scimEnabled,
      scimTokenCreatedAt: identityProviders.scimTokenCreatedAt,
      scimTokenExpiresAt: identityProviders.scimTokenExpiresAt,
      requireProvisioned: identityProviders.requireProvisioned,
      scimIdentityAttribute: identityProviders.scimIdentityAttribute,
      clientAuthentication: identityProviders.clientAuthentication,
      authorizationScopes: identityProviders.authorizationScopes,
      authorizationAudience: identityProviders.authorizationAudience,
      sortOrder: identityProviders.sortOrder,
      status: identityProviders.status,
      expiresAt: identityProviders.expiresAt,
      createdAt: identityProviders.createdAt,
      updatedAt: identityProviders.updatedAt,
    })
    .from(identityProviders)
    .where(eq(identityProviders.scope, 'installation'))
    .orderBy(asc(identityProviders.displayName), asc(identityProviders.id));
}

/**
 * Updates an installation-scoped provider and audits the exact changed fields atomically.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, provider, changed fields, and optional reason.
 */
export function updateAdminProvider(
  db: Db,
  input: {
    actorUserId: string;
    providerId: string;
    patch: AdminProviderPatch;
    reason?: string;
  },
) {
  return db.transaction(async (tx) => {
    const [provider] = await tx
      .update(identityProviders)
      .set({ ...input.patch, updatedAt: new Date() })
      .where(
        and(
          eq(identityProviders.id, input.providerId),
          eq(identityProviders.scope, 'installation'),
        ),
      )
      .returning();
    if (!provider) {
      throw new AdminMutationError('not_found', 'installation provider not found');
    }
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'provider.update',
      targetKind: 'provider',
      targetId: input.providerId,
      reason: input.reason,
      details: { fields: Object.keys(input.patch).sort() },
    });
    return provider;
  });
}
