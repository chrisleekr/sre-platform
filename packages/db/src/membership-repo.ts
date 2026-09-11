import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Tx } from './rls';
import {
  identityProviders,
  identityProviderDomains,
  memberships,
  tenantIdentityBindings,
  tenantInvitations,
  tenants,
  users,
  type MembershipRole,
} from './schema';

type MutationCode = 'forbidden' | 'last_owner' | 'member_not_found' | 'invalid_target';

/** Carries a stable HTTP-facing reason for a refused membership mutation. */
export class MembershipMutationError extends Error {
  constructor(
    readonly code: MutationCode,
    message: string,
  ) {
    super(message);
  }
}

interface MemberMutationInput {
  tenantId: string;
  actorUserId: string;
  targetUserId: string;
}

/** Lock and authorize a responder at the transaction that commits their action.
 * @param tx - Transaction performing the tenant-scoped mutation.
 * @param tenantId - Server-selected workspace.
 * @param userId - Persisted authenticated actor, never model output.
 */
export async function activeResponderTx(
  tx: Tx,
  tenantId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const rows = await tx
    .select({ id: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(users.id, userId),
        eq(memberships.status, 'active'),
        eq(users.status, 'active'),
        eq(tenants.status, 'active'),
      ),
    )
    .limit(1)
    .for('share');
  return rows.length === 1;
}

async function lockTenant(tx: Tx, tenantId: string): Promise<void> {
  const rows = await tx
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .for('update');
  if (!rows[0]) throw new MembershipMutationError('member_not_found', 'workspace not found');
}

async function activeMember(tx: Tx, tenantId: string, userId: string) {
  const rows = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.userId, userId),
        eq(memberships.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function assertAnotherOwner(tx: Tx, tenantId: string, targetUserId: string): Promise<void> {
  const rows = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
        sql`${memberships.userId} <> ${targetUserId}`,
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new MembershipMutationError(
      'last_owner',
      'assign another owner before changing the last owner',
    );
  }
}

/**
 * Lists workspace members with the provider identity needed by an administration screen.
 *
 * @param db - Tenant-scoped database connection.
 * @param tenantId - Workspace whose members are requested.
 */
export function listTenantMembers(db: Db, tenantId: string) {
  return listMembersWithProviders(db, tenantId);
}

/**
 * Lists active workspace owners as notification recipients.
 *
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace whose active owners are requested.
 */
export function listOwners(db: Db, tenantId: string) {
  return db
    .select({ userId: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
      ),
    )
    .orderBy(asc(users.id));
}

async function listMembersWithProviders(db: Db, tenantId: string) {
  const memberRows = await db
    .select({
      userId: users.id,
      email: users.email,
      issuer: users.issuer,
      userStatus: users.status,
      lastSignInAt: users.lastSignInAt,
      role: memberships.role,
      status: memberships.status,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId))
    .orderBy(asc(users.email), asc(users.id));
  if (memberRows.length === 0) return [];

  const providerRows = await db
    .select({
      id: identityProviders.id,
      issuer: identityProviders.issuer,
      displayName: identityProviders.displayName,
      scope: identityProviders.scope,
      status: identityProviders.status,
      createdAt: identityProviders.createdAt,
      boundTenantId: tenantIdentityBindings.tenantId,
      domainStatus: identityProviderDomains.status,
    })
    .from(identityProviders)
    .leftJoin(
      tenantIdentityBindings,
      and(
        eq(tenantIdentityBindings.providerId, identityProviders.id),
        eq(tenantIdentityBindings.tenantId, tenantId),
      ),
    )
    .leftJoin(identityProviderDomains, eq(identityProviderDomains.providerId, identityProviders.id))
    .where(inArray(identityProviders.issuer, [...new Set(memberRows.map((row) => row.issuer))]))
    .orderBy(asc(identityProviders.createdAt), asc(identityProviders.id));

  type Provider = Omit<(typeof providerRows)[number], 'domainStatus'> & {
    directoryStatus: string | null;
  };
  const directoryRank = { failed: 1, pending: 2, verified: 3 } as const;
  const providers = new Map<string, Provider>();
  for (const row of providerRows) {
    const current = providers.get(row.id);
    const candidateRank = row.domainStatus
      ? (directoryRank[row.domainStatus as keyof typeof directoryRank] ?? 0)
      : 0;
    const currentRank = current?.directoryStatus
      ? (directoryRank[current.directoryStatus as keyof typeof directoryRank] ?? 0)
      : 0;
    if (!current || candidateRank > currentRank) {
      const { domainStatus: _domainStatus, ...provider } = row;
      providers.set(row.id, { ...provider, directoryStatus: row.domainStatus });
    }
  }

  const providerRank = (provider: Provider): number =>
    (provider.boundTenantId === tenantId ? 4 : 0) + (provider.status === 'active' ? 2 : 0);
  const providerByIssuer = new Map<string, Provider>();
  for (const provider of providers.values()) {
    const current = providerByIssuer.get(provider.issuer);
    if (!current || providerRank(provider) > providerRank(current)) {
      providerByIssuer.set(provider.issuer, provider);
    }
  }

  return memberRows.map(({ issuer, ...member }) => {
    const provider = providerByIssuer.get(issuer);
    return {
      ...member,
      provider: provider
        ? {
            displayName: provider.displayName,
            scope: provider.scope,
            status: provider.status,
            directoryStatus: provider.directoryStatus,
          }
        : null,
    };
  });
}

/**
 * Changes an active member's role while preserving at least one active owner.
 *
 * @param db - Tenant-scoped database connection.
 * @param input - Acting owner, target member, and replacement role.
 */
export function setTenantMemberRole(
  db: Db,
  input: MemberMutationInput & { role: Exclude<MembershipRole, 'owner'> },
): Promise<{ role: MembershipRole }> {
  return db.transaction(async (tx) => {
    await lockTenant(tx, input.tenantId);
    const actor = await activeMember(tx, input.tenantId, input.actorUserId);
    const target = await activeMember(tx, input.tenantId, input.targetUserId);
    if (actor?.role !== 'owner') throw new MembershipMutationError('forbidden', 'owner required');
    if (!target) throw new MembershipMutationError('member_not_found', 'member not found');
    if (target.role === 'owner') {
      await assertAnotherOwner(tx, input.tenantId, input.targetUserId);
    }
    await tx
      .update(memberships)
      .set({ role: input.role })
      .where(
        and(
          eq(memberships.tenantId, input.tenantId),
          eq(memberships.userId, input.targetUserId),
          eq(memberships.status, 'active'),
        ),
      );
    return { role: input.role };
  });
}

/**
 * Removes a member under owner/admin policy and preserves the last active owner.
 *
 * @param db - Tenant-scoped database connection.
 * @param input - Acting administrator and target member.
 */
export function removeTenantMember(
  db: Db,
  input: MemberMutationInput,
): Promise<{ removed: boolean; userId: string }> {
  return db.transaction(async (tx) => {
    await lockTenant(tx, input.tenantId);
    const actor = await activeMember(tx, input.tenantId, input.actorUserId);
    const target = await activeMember(tx, input.tenantId, input.targetUserId);
    if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) {
      throw new MembershipMutationError('forbidden', 'workspace administrator required');
    }
    if (!target) throw new MembershipMutationError('member_not_found', 'member not found');
    if (actor.role === 'admin' && target.role !== 'member') {
      throw new MembershipMutationError('forbidden', 'administrators can remove members only');
    }
    if (target.role === 'owner') {
      await assertAnotherOwner(tx, input.tenantId, input.targetUserId);
    }
    const rows = await tx
      .update(memberships)
      .set({ status: 'removed' })
      .where(
        and(
          eq(memberships.tenantId, input.tenantId),
          eq(memberships.userId, input.targetUserId),
          eq(memberships.status, 'active'),
        ),
      )
      .returning({ userId: memberships.userId });
    return { removed: rows.length === 1, userId: input.targetUserId };
  });
}

/**
 * Transfers ownership from the caller to one active member in a tenant-locked transaction.
 *
 * @param db - Tenant-scoped database connection.
 * @param input - Current owner and replacement owner.
 */
export function transferTenantOwnership(db: Db, input: MemberMutationInput): Promise<void> {
  return db.transaction(async (tx) => {
    await lockTenant(tx, input.tenantId);
    if (input.actorUserId === input.targetUserId) {
      throw new MembershipMutationError('invalid_target', 'choose another member');
    }
    const actor = await activeMember(tx, input.tenantId, input.actorUserId);
    const target = await activeMember(tx, input.tenantId, input.targetUserId);
    if (actor?.role !== 'owner') throw new MembershipMutationError('forbidden', 'owner required');
    if (!target) throw new MembershipMutationError('member_not_found', 'member not found');
    await tx
      .update(memberships)
      .set({ role: 'owner' })
      .where(
        and(
          eq(memberships.tenantId, input.tenantId),
          eq(memberships.userId, input.targetUserId),
          eq(memberships.status, 'active'),
        ),
      );
    await tx
      .update(memberships)
      .set({ role: 'admin' })
      .where(
        and(
          eq(memberships.tenantId, input.tenantId),
          eq(memberships.userId, input.actorUserId),
          eq(memberships.status, 'active'),
        ),
      );
  });
}

/**
 * Creates one normalized pending invitation with a seven-day expiry.
 *
 * @param db - Tenant-scoped database connection.
 * @param input - Workspace, recipient, role, and inviter.
 */
export async function createTenantInvitation(
  db: Db,
  input: {
    tenantId: string;
    email: string;
    role: 'admin' | 'member';
    invitedByUserId: string;
  },
) {
  const rows = await db
    .insert(tenantInvitations)
    .values({
      ...input,
      email: input.email.trim().toLowerCase(),
      status: 'pending',
      expiresAt: sql`clock_timestamp() + interval '7 days'`,
    })
    .returning();
  if (!rows[0]) throw new Error('tenant invitation insert returned no row');
  return rows[0];
}

/**
 * Extends one pending invitation without changing its identity or role.
 *
 * @param db - Tenant-scoped database connection.
 * @param tenantId - Workspace that owns the invitation.
 * @param invitationId - Pending invitation to extend.
 */
export async function resendTenantInvitation(db: Db, tenantId: string, invitationId: string) {
  const rows = await db
    .update(tenantInvitations)
    .set({ expiresAt: sql`clock_timestamp() + interval '7 days'` })
    .where(
      and(
        eq(tenantInvitations.id, invitationId),
        eq(tenantInvitations.tenantId, tenantId),
        eq(tenantInvitations.status, 'pending'),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Revokes one pending invitation without deleting its audit record.
 *
 * @param db - Tenant-scoped database connection.
 * @param tenantId - Workspace that owns the invitation.
 * @param invitationId - Pending invitation to revoke.
 */
export async function revokeTenantInvitation(db: Db, tenantId: string, invitationId: string) {
  const rows = await db
    .update(tenantInvitations)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(tenantInvitations.id, invitationId),
        eq(tenantInvitations.tenantId, tenantId),
        eq(tenantInvitations.status, 'pending'),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Lists current invitations for a workspace, newest first.
 *
 * @param db - Tenant-scoped database connection.
 * @param tenantId - Workspace whose invitations are requested.
 */
export function listTenantInvitations(db: Db, tenantId: string) {
  return db
    .select()
    .from(tenantInvitations)
    .where(eq(tenantInvitations.tenantId, tenantId))
    .orderBy(sql`${tenantInvitations.createdAt} desc`, tenantInvitations.id);
}
