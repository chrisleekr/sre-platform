import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  connectorConfigs,
  identityProviderDomains,
  identityProviders,
  memberships,
  surfaceConfigs,
  tenantIdentityBindings,
  tenants,
  workspaceFoundings,
} from './schema';

const RESERVED_FOUNDING_STATUSES = [
  'awaiting_founder',
  'authenticating_founder',
  'founder_authenticated',
  'pending',
  'approved',
  'provisioning',
  'active',
  'failed',
] as const;

/**
 * Returns whether a normalized workspace address is free across workspaces and live requests.
 *
 * @param db - Database connection used for the lookup.
 * @param slug - Normalized workspace address to check.
 */
export async function getWorkspaceAddressAvailability(
  db: Db,
  slug: string,
): Promise<
  { available: true } | { available: false; code: 'workspace_exists' | 'workspace_reserved' }
> {
  const [workspace] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (workspace) return { available: false, code: 'workspace_exists' };
  const [founding] = await db
    .select({
      reclaimable: sql<boolean>`
        ${workspaceFoundings.status} in ('awaiting_founder','authenticating_founder','founder_authenticated','pending','approved','failed')
        and ${workspaceFoundings.expiresAt} < clock_timestamp()
        and ((${workspaceFoundings.status} = 'awaiting_founder' and ${workspaceFoundings.providerId} is null)
          or ${identityProviders.status} = 'provisional')`,
    })
    .from(workspaceFoundings)
    .leftJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
    .where(
      and(
        eq(workspaceFoundings.slug, slug),
        inArray(workspaceFoundings.status, [...RESERVED_FOUNDING_STATUSES]),
      ),
    )
    .limit(1);
  return founding && !founding.reclaimable
    ? { available: false, code: 'workspace_reserved' }
    : { available: true };
}

export interface WorkspaceWelcome {
  workspaceCreated: true;
  domainVerified: boolean;
  observabilityConnected: boolean;
  slackConnected: boolean;
  shown: boolean;
  dismissed: boolean;
}

/**
 * Derives the durable first-run checklist for one active workspace member.
 *
 * @param db - Database connection used for evidence queries.
 * @param input - Workspace and user identifiers that scope the checklist.
 */
export async function getWorkspaceWelcome(
  db: Db,
  input: { tenantId: string; userId: string },
): Promise<WorkspaceWelcome | null> {
  const [member] = await db
    .select({
      welcomeShownAt: memberships.welcomeShownAt,
      welcomeDismissedAt: memberships.welcomeDismissedAt,
    })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, input.tenantId),
        eq(memberships.userId, input.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .limit(1);
  if (!member) return null;
  const [evidence] = await db
    .select({
      domainVerified: sql<boolean>`exists (
        select 1 from ${tenantIdentityBindings} binding
        inner join ${identityProviderDomains} domain on domain.provider_id = binding.provider_id
        where binding.tenant_id = ${input.tenantId} and domain.status = 'verified'
      )`,
      observabilityConnected: sql<boolean>`exists (
        select 1 from ${connectorConfigs} connector
        where connector.tenant_id = ${input.tenantId}
          and connector.deleted_at is null
          and connector.enabled = true
          and connector.type in ('prometheus','datadog','statuscake')
      )`,
      slackConnected: sql<boolean>`exists (
        select 1 from ${surfaceConfigs} surface
        where surface.tenant_id = ${input.tenantId} and surface.surface = 'slack'
      )`,
    })
    .from(sql`(select 1) as evidence`);
  return {
    workspaceCreated: true,
    domainVerified: evidence?.domainVerified ?? false,
    observabilityConnected: evidence?.observabilityConnected ?? false,
    slackConnected: evidence?.slackConnected ?? false,
    shown: member.welcomeShownAt !== null,
    dismissed: member.welcomeDismissedAt !== null,
  };
}

/**
 * Marks the one-time welcome as presented for the named active membership.
 *
 * @param db - Database connection.
 * @param input - Tenant and user that identify the active membership.
 */
export async function markWorkspaceWelcomeShown(
  db: Db,
  input: { tenantId: string; userId: string },
): Promise<boolean> {
  const rows = await db
    .update(memberships)
    .set({ welcomeShownAt: sql`coalesce(${memberships.welcomeShownAt}, clock_timestamp())` })
    .where(
      and(
        eq(memberships.tenantId, input.tenantId),
        eq(memberships.userId, input.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .returning({ userId: memberships.userId });
  return rows.length === 1;
}

/**
 * Persists first-run checklist dismissal only for the named active membership.
 *
 * @param db - Database connection used for the update.
 * @param input - Workspace and user identifiers that scope the dismissal.
 */
export async function dismissWorkspaceWelcome(
  db: Db,
  input: { tenantId: string; userId: string },
): Promise<boolean> {
  const rows = await db
    .update(memberships)
    .set({
      welcomeDismissedAt: sql`coalesce(${memberships.welcomeDismissedAt}, clock_timestamp())`,
    })
    .where(
      and(
        eq(memberships.tenantId, input.tenantId),
        eq(memberships.userId, input.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .returning({ userId: memberships.userId });
  return rows.length === 1;
}

/**
 * Returns the DNS proof visible to a member of the bound workspace.
 *
 * @param db - Database connection used for the lookup.
 * @param input - Workspace identifier and optional domain identifier.
 */
export async function getWorkspaceDomain(db: Db, input: { tenantId: string; domainId?: string }) {
  const conditions = [eq(tenantIdentityBindings.tenantId, input.tenantId)];
  if (input.domainId) conditions.push(eq(identityProviderDomains.id, input.domainId));
  const [row] = await db
    .select({
      id: identityProviderDomains.id,
      domain: identityProviderDomains.domain,
      status: identityProviderDomains.status,
      challenge: identityProviderDomains.challenge,
      lastCheckedAt: identityProviderDomains.lastCheckedAt,
      expiresAt: identityProviderDomains.expiresAt,
      foundingId: workspaceFoundings.id,
    })
    .from(tenantIdentityBindings)
    .innerJoin(
      identityProviderDomains,
      eq(identityProviderDomains.providerId, tenantIdentityBindings.providerId),
    )
    .leftJoin(
      workspaceFoundings,
      and(
        eq(workspaceFoundings.providerId, tenantIdentityBindings.providerId),
        eq(workspaceFoundings.tenantId, input.tenantId),
      ),
    )
    .where(and(...conditions))
    .orderBy(identityProviderDomains.createdAt)
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    challengeHost: `_sre-platform.${row.domain}`,
    challengeValue: row.challenge,
  };
}
