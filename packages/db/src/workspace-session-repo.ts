import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Executor } from './rls';
import { browserSessions, memberships, tenants, users } from './schema';
import {
  browserCredentialHash,
  newBrowserCredential,
  lockOidcSession,
} from './browser-session-repo';

/** Keeps membership selection and live socket checks on the same provider policy.
 * @param providerId - Authenticated provider, never a user-selected provider.
 * @param tenantId - Workspace being authorized.
 * @param claimValue - Provider-verified tenant claim retained by the session.
 */
export function workspaceSessionProviderEligible(
  providerId: string | SQL,
  tenantId: string | SQL,
  claimValue: string | null | SQL,
): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from identity_providers p
    join tenants t on t.id = ${tenantId}
    where p.id = ${providerId} and p.issuer = ${users.issuer} and p.status = 'active'
      and (not t.require_directory or p.scope = 'tenant')
      and (
        exists (select 1 from tenant_identity_bindings b
          where b.tenant_id = t.id and b.provider_id = p.id
            and b.claim_value is not distinct from ${claimValue}
            and (p.scope = 'tenant' or (p.tenant_claim is not null and ${claimValue}::text is not null)))
        or (p.scope = 'installation' and p.tenant_claim is null and not t.require_directory
          and not exists (select 1 from tenant_identity_bindings b where b.tenant_id = t.id))
      )
  )`;
}

/** Authorizes an existing membership without accepting invitations or creating membership.
 * @param db - Control-plane connection or transaction.
 * @param input - Verified account, provider and requested workspace.
 */
export async function getWorkspaceMembershipAccess(
  db: Executor,
  input: { userId: string; providerId: string; tenantId: string; claimValue: string | null },
) {
  const [row] = await db
    .select({
      role: memberships.role,
      status: memberships.status,
      tenantStatus: tenants.status,
      eligible: workspaceSessionProviderEligible(
        input.providerId,
        input.tenantId,
        input.claimValue,
      ),
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(
      and(eq(users.id, input.userId), eq(users.status, 'active'), eq(tenants.id, input.tenantId)),
    )
    .limit(1);
  if (!row || row.status !== 'active') return { status: 'removed' as const };
  if (row.tenantStatus !== 'active') return { status: row.tenantStatus };
  if (!row.eligible) return { status: 'directory_required' as const };
  return { status: 'ok' as const, role: row.role, tenantId: input.tenantId, founderOnly: false };
}

/** Rotates the credential on workspace changes without extending authentication deadlines.
 * @param db - Control-plane connection.
 * @param sessionId - Browser session already authenticated by the runtime.
 * @param tenantId - Authorized workspace selection.
 */
export async function selectBrowserSessionWorkspace(
  db: Executor,
  sessionId: string,
  tenantId: string,
) {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, sessionId))
      .limit(1);
    if (!source) return null;
    await lockOidcSession(tx, source.providerId, source.clientId, source.oidcSessionId);
    const [row] = await tx
      .update(browserSessions)
      .set({ revokedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(browserSessions.id, sessionId),
          isNull(browserSessions.revokedAt),
          sql`${browserSessions.idleExpiresAt} > clock_timestamp()`,
          sql`${browserSessions.absoluteExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning();
    if (!row) return null;
    const credential = newBrowserCredential();
    const [session] = await tx
      .insert(browserSessions)
      .values({
        ...row,
        id: undefined,
        credentialHash: browserCredentialHash(credential),
        selectedTenantId: tenantId,
        revokedAt: null,
        createdAt: new Date(),
      })
      .returning();
    if (!session) throw new Error('workspace session insert returned no row');
    return { credential, session };
  });
}
