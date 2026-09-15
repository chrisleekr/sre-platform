import { and, asc, count, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  identityProviderDomains,
  identityProviders,
  jobs,
  memberships,
  tenantIdentityBindings,
  tenants,
  users,
  type TenantStatus,
} from '../schema';
import { AdminMutationError, appendAdminAction } from './support';

async function tenantDetails(db: Db, tenantIds: string[]) {
  if (tenantIds.length === 0) return new Map<string, Record<string, unknown>>();
  const [memberCounts, owners, providers, domains] = await Promise.all([
    db
      .select({ tenantId: memberships.tenantId, count: count() })
      .from(memberships)
      .where(and(inArray(memberships.tenantId, tenantIds), eq(memberships.status, 'active')))
      .groupBy(memberships.tenantId),
    db
      .select({
        tenantId: memberships.tenantId,
        userId: users.id,
        email: users.email,
        accountStatus: users.status,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          inArray(memberships.tenantId, tenantIds),
          eq(memberships.status, 'active'),
          eq(memberships.role, 'owner'),
        ),
      )
      .orderBy(asc(users.email), asc(users.id)),
    db
      .select({
        tenantId: tenantIdentityBindings.tenantId,
        id: identityProviders.id,
        displayName: identityProviders.displayName,
        issuer: identityProviders.issuer,
        scope: identityProviders.scope,
        status: identityProviders.status,
        claimValue: tenantIdentityBindings.claimValue,
      })
      .from(tenantIdentityBindings)
      .innerJoin(identityProviders, eq(identityProviders.id, tenantIdentityBindings.providerId))
      .where(inArray(tenantIdentityBindings.tenantId, tenantIds)),
    db
      .select({
        tenantId: tenantIdentityBindings.tenantId,
        id: identityProviderDomains.id,
        domain: identityProviderDomains.domain,
        status: identityProviderDomains.status,
        expiresAt: identityProviderDomains.expiresAt,
      })
      .from(tenantIdentityBindings)
      .innerJoin(
        identityProviderDomains,
        eq(identityProviderDomains.providerId, tenantIdentityBindings.providerId),
      )
      .where(inArray(tenantIdentityBindings.tenantId, tenantIds)),
  ]);
  const grouped = new Map<
    string,
    {
      memberCount: number;
      owners: typeof owners;
      providers: unknown[];
      domains: unknown[];
      ownership: {
        state: 'owned' | 'missing_owner' | 'inactive_owners';
        activeOwnerCount: number;
        inactiveOwnerCount: number;
      };
    }
  >();
  for (const tenantId of tenantIds) {
    grouped.set(tenantId, {
      memberCount: 0,
      owners: [],
      providers: [],
      domains: [],
      ownership: { state: 'missing_owner', activeOwnerCount: 0, inactiveOwnerCount: 0 },
    });
  }
  for (const row of memberCounts) grouped.get(row.tenantId)!.memberCount = row.count;
  for (const row of owners) grouped.get(row.tenantId)!.owners.push(row);
  for (const row of providers) grouped.get(row.tenantId)!.providers.push(row);
  for (const row of domains) grouped.get(row.tenantId)!.domains.push(row);
  for (const details of grouped.values()) {
    const activeOwnerCount = details.owners.filter(
      (owner) => owner.accountStatus === 'active',
    ).length;
    details.ownership = {
      state: activeOwnerCount
        ? 'owned'
        : details.owners.length
          ? 'inactive_owners'
          : 'missing_owner',
      activeOwnerCount,
      inactiveOwnerCount: details.owners.length - activeOwnerCount,
    };
  }
  return grouped;
}

/**
 * Lists workspace lifecycle, ownership, provider, and directory state for administrators.
 *
 * @param db - Control-plane database connection.
 * @param input - Optional name and lifecycle filters.
 */
export async function listAdminTenants(
  db: Db,
  input: { query?: string; status?: TenantStatus } = {},
) {
  const filter = and(
    input.status ? eq(tenants.status, input.status) : undefined,
    input.query?.trim() ? ilike(tenants.name, `%${input.query.trim()}%`) : undefined,
  );
  const rows = await db
    .select()
    .from(tenants)
    .where(filter)
    .orderBy(asc(tenants.name), asc(tenants.id))
    .limit(100);
  const details = await tenantDetails(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, ...details.get(row.id) }));
}

/**
 * Returns one workspace control-plane projection for administrators.
 *
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace identifier.
 */
export async function getAdminTenant(db: Db, tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return null;
  return { ...tenant, ...(await tenantDetails(db, [tenantId])).get(tenantId) };
}

/**
 * Suspends or reactivates a workspace and audits the state change atomically.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, workspace, target status, and optional reason.
 */
export function setAdminTenantStatus(
  db: Db,
  input: { actorUserId: string; tenantId: string; status: 'active' | 'suspended'; reason?: string },
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1)
      .for('update');
    if (!current) throw new AdminMutationError('not_found', 'workspace not found');
    const allowed =
      (current.status === 'active' && input.status === 'suspended') ||
      (current.status === 'suspended' && input.status === 'active');
    if (!allowed) throw new AdminMutationError('conflict', `workspace is ${current.status}`);
    const [tenant] = await tx
      .update(tenants)
      .set({ status: input.status })
      .where(eq(tenants.id, input.tenantId))
      .returning();
    const members = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.tenantId, input.tenantId), eq(memberships.status, 'active')));
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: input.status === 'suspended' ? 'workspace.suspend' : 'workspace.reactivate',
      targetKind: 'tenant',
      targetId: input.tenantId,
      reason: input.reason,
    });
    return { tenant: tenant!, memberUserIds: members.map((row) => row.userId) };
  });
}

/**
 * Cancels a pending workspace deletion and restores active access atomically.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, workspace, and optional reason.
 */
export function cancelAdminTenantDeletion(
  db: Db,
  input: { actorUserId: string; tenantId: string; reason?: string },
) {
  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .update(tenants)
      .set({ status: 'active', deleteAfter: null })
      .where(
        and(
          eq(tenants.id, input.tenantId),
          eq(tenants.status, 'deleting'),
          sql`${tenants.deleteAfter} > clock_timestamp()`,
        ),
      )
      .returning();
    if (!tenant) throw new AdminMutationError('conflict', 'workspace is not pending deletion');
    await tx
      .update(jobs)
      .set({ status: 'done', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(jobs.type, 'tenant.purge'),
          sql`${jobs.payload}->>'tenantId' = ${input.tenantId}`,
          inArray(jobs.status, ['queued', 'processing']),
        ),
      );
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'workspace.cancel_deletion',
      targetKind: 'tenant',
      targetId: input.tenantId,
      reason: input.reason,
    });
    return tenant;
  });
}

/** Clears directory-only sign-in as an audited administrator break-glass action.
 * @param db - Control-plane database connection.
 * @param input - Administrator identity, target workspace, and reason.
 */
export function clearAdminTenantRequireDirectory(
  db: Db,
  input: { actorUserId: string; tenantId: string; reason: string },
) {
  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .update(tenants)
      .set({ requireDirectory: false })
      .where(and(eq(tenants.id, input.tenantId), eq(tenants.requireDirectory, true)))
      .returning();
    if (!tenant) {
      throw new AdminMutationError('conflict', 'workspace does not require its directory');
    }
    const owners = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, input.tenantId),
          eq(memberships.role, 'owner'),
          eq(memberships.status, 'active'),
        ),
      );
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'workspace.require_directory_clear',
      targetKind: 'tenant',
      targetId: input.tenantId,
      reason: input.reason,
    });
    return { tenant, ownerUserIds: owners.map((owner) => owner.userId) };
  });
}

/**
 * Adds one installation-provider binding used by the next identity resolution.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, workspace, provider, and provider claim.
 */
export function createAdminTenantBinding(
  db: Db,
  input: { actorUserId: string; tenantId: string; providerId: string; claimValue: string },
) {
  return db.transaction(async (tx) => {
    const [provider] = await tx
      .select({ id: identityProviders.id })
      .from(identityProviders)
      .where(
        and(
          eq(identityProviders.id, input.providerId),
          eq(identityProviders.scope, 'installation'),
          eq(identityProviders.status, 'active'),
        ),
      )
      .limit(1);
    if (!provider)
      throw new AdminMutationError(
        'invalid_target',
        'provider is not active and installation scoped',
      );
    const [tenant] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1);
    if (!tenant) throw new AdminMutationError('not_found', 'workspace not found');
    const [binding] = await tx
      .insert(tenantIdentityBindings)
      .values({
        tenantId: input.tenantId,
        providerId: input.providerId,
        claimValue: input.claimValue,
      })
      .onConflictDoNothing()
      .returning();
    if (!binding) throw new AdminMutationError('conflict', 'provider claim is already bound');
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'workspace.binding_create',
      targetKind: 'tenant',
      targetId: input.tenantId,
      details: { providerId: input.providerId, claimValue: input.claimValue },
    });
    return binding;
  });
}
