import {
  acceptPlatformAdminInvitation,
  resolveTenantByBinding,
  getWorkspaceMembershipAccess,
  upsertUserForSignIn,
} from '@sre/db';
import type { AuthDeps, IdentityResolution, UserContext } from '../auth';

/** Applies the same durable account and workspace policy to bearer and browser identities.
 * @param deps - Current identity and policy stores.
 * @param identity - Cryptographically verified or server-session-bound identity.
 */
export async function resolveIdentityAccess(
  deps: AuthDeps,
  identity: {
    providerId: string;
    issuer: string;
    subject: string;
    email?: string;
    emailVerified?: boolean;
    issuedAt: number;
    expiresAt: number;
    scope: 'tenant' | 'installation';
    bindingClaimValue: string | null;
    scopes: string[];
    applicationSessionId?: string;
    selectedTenantId?: string | null;
  },
): Promise<IdentityResolution> {
  const { issuer, subject, email, issuedAt, expiresAt, scopes } = identity;
  const signedIn = await upsertUserForSignIn(deps.db, {
    providerId: identity.providerId,
    issuer,
    subject,
    email,
    emailVerified: identity.emailVerified === true,
  });
  if (signedIn.status === 'directory_unverified') {
    return {
      ok: false,
      status: 403,
      error: 'directory account unavailable',
      state: 'directory_unverified',
    };
  }
  if (signedIn.status === 'disabled')
    return { ok: false, status: 403, error: 'account disabled', state: 'disabled' };
  if (signedIn.status === 'deleted') return { ok: false, status: 401, error: 'invalid token' };
  if (signedIn.notBefore && issuedAt * 1_000 < signedIn.notBefore.getTime()) {
    return { ok: false, status: 401, error: 'signed out, sign in again' };
  }
  if (email && identity.scope === 'installation')
    await acceptPlatformAdminInvitation(deps.adminDb, { issuer, email, userId: signedIn.userId });
  const user: UserContext = {
    userId: signedIn.userId,
    issuer,
    subject,
    ...(email ? { email } : {}),
    providerId: identity.providerId,
    issuedAt,
    expiresAt,
    bindingClaimValue: identity.bindingClaimValue,
    ...(identity.applicationSessionId
      ? { applicationSessionId: identity.applicationSessionId }
      : {}),
  };
  if (
    !identity.selectedTenantId &&
    identity.scope === 'installation' &&
    identity.bindingClaimValue === null
  ) {
    return { ok: true, user, tenantAccessState: 'unaffiliated', scopes };
  }
  const binding =
    identity.applicationSessionId && identity.selectedTenantId
      ? await getWorkspaceMembershipAccess(deps.db, {
          userId: signedIn.userId,
          providerId: identity.providerId,
          tenantId: identity.selectedTenantId,
          claimValue: identity.bindingClaimValue,
        })
      : await resolveTenantByBinding(deps.db, {
          providerId: identity.providerId,
          claimValue: identity.bindingClaimValue,
          userId: signedIn.userId,
          invitationEmail: email,
        });
  if (binding.status !== 'ok') return { ok: true, user, tenantAccessState: binding.status, scopes };
  return {
    ok: true,
    user,
    tenant: {
      tenantId: binding.tenantId,
      issuer,
      sub: subject,
      userId: signedIn.userId,
      issuedAt,
      expiresAt,
      role: binding.role,
      founderOnly: binding.founderOnly,
    },
    scopes,
  };
}
