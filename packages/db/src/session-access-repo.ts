import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from './rls';
import { workspaceSessionProviderEligible } from './workspace-session-repo';
import {
  identityProviders,
  tenantIdentityBindings,
  tenants,
  memberships,
  users,
  browserSessions,
  type UserStatus,
  type TenantStatus,
  type MembershipStatus,
} from './schema';

/**
 * Reads the durable gates that remain authoritative after a WebSocket ticket is minted.
 *
 * @param db - Control-plane application connection used for the session check.
 * @param userId - Canonical user carried by the protected ticket.
 * @param tenantId - Tenant carried by the protected ticket.
 * @param providerId - Sign-in method carried by the protected ticket.
 * @param applicationSessionId - Exact browser session, omitted only for genuine bearer credentials.
 */
export async function getUserTenantSessionState(
  db: Executor,
  userId: string,
  tenantId: string,
  providerId: string,
  applicationSessionId?: string,
): Promise<{
  providerEligible: boolean;
  sessionEligible: boolean;
  userStatus: UserStatus;
  notBefore: Date | null;
  tenantStatus: TenantStatus | null;
  membershipStatus: MembershipStatus | null;
} | null> {
  const rows = await db
    .select({
      sessionEligible: applicationSessionId
        ? sql<boolean>`exists (
        select 1 from ${browserSessions} s where s.id = ${applicationSessionId}
        and s.user_id = ${userId} and s.provider_id = ${providerId}
        and exists (select 1 from ${identityProviders} p where p.id = s.provider_id and p.browser_client_id = s.client_id)
        and s.revoked_at is null and s.idle_expires_at > clock_timestamp()
        and s.absolute_expires_at > clock_timestamp()
        and (s.selected_tenant_id is null or s.selected_tenant_id = ${tenantId})
      )`
        : sql<boolean>`true`,
      providerEligible: sql<boolean>`case when ${applicationSessionId ?? null}::uuid is not null
        and exists (select 1 from ${browserSessions} s
          where s.id = ${applicationSessionId ?? null} and s.selected_tenant_id = ${tenantId})
        then ${workspaceSessionProviderEligible(providerId, tenantId, sql`(select s.binding_claim_value from ${browserSessions} s where s.id = ${applicationSessionId ?? null})`)}
        else exists (
        select 1 from ${identityProviders} p
        join ${tenantIdentityBindings} b on b.provider_id = p.id
        where p.id = ${providerId} and p.issuer = ${users.issuer}
          and p.status = 'active' and b.tenant_id = ${tenantId}
          and (not ${tenants.requireDirectory} or p.scope = 'tenant')
      ) end`,
      userStatus: users.status,
      notBefore: users.notBefore,
      tenantStatus: tenants.status,
      membershipStatus: memberships.status,
    })
    .from(users)
    .leftJoin(tenants, eq(tenants.id, tenantId))
    .leftJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.tenantId, tenantId)),
    )
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}
