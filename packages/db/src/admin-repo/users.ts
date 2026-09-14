import { and, asc, countDistinct, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import type { Tx } from '../rls';
import {
  hasOtherActiveOwner,
  lockOwnershipAccounts,
  lockOwnershipWorkspaces,
  lockUserOwnershipScopes,
} from '../ownership';
import {
  identityProviders,
  memberships,
  platformOperators,
  tenants,
  users,
  type UserStatus,
} from '../schema';
import { AdminMutationError, appendAdminAction } from './support';

async function userDetails(db: Db, userIds: string[]) {
  if (userIds.length === 0)
    return new Map<string, { memberships: unknown[]; isPlatformAdmin: boolean }>();
  const [membershipRows, operatorRows] = await Promise.all([
    db
      .select({
        userId: memberships.userId,
        tenantId: memberships.tenantId,
        workspaceName: tenants.name,
        workspaceSlug: tenants.slug,
        role: memberships.role,
        status: memberships.status,
        workspaceStatus: tenants.status,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(inArray(memberships.userId, userIds)),
    db
      .select({ userId: platformOperators.userId })
      .from(platformOperators)
      .where(inArray(platformOperators.userId, userIds)),
  ]);
  const result = new Map<string, { memberships: unknown[]; isPlatformAdmin: boolean }>();
  const operators = new Set(operatorRows.map((row) => row.userId));
  for (const userId of userIds)
    result.set(userId, { memberships: [], isPlatformAdmin: operators.has(userId) });
  for (const membership of membershipRows)
    result.get(membership.userId)!.memberships.push(membership);
  return result;
}

/**
 * Lists identities, sign-in state, memberships, and platform access for administrators.
 *
 * @param db - Control-plane database connection.
 * @param input - Optional identity and lifecycle filters.
 */
export async function listAdminUsers(db: Db, input: { query?: string; status?: UserStatus } = {}) {
  const term = input.query?.trim();
  const rows = await db
    .select({
      id: users.id,
      issuer: users.issuer,
      subject: users.subject,
      email: users.email,
      status: users.status,
      lastSignInAt: users.lastSignInAt,
      notBefore: users.notBefore,
      createdAt: users.createdAt,
      providerScope: identityProviders.scope,
      providerName: identityProviders.displayName,
      providerStatus: identityProviders.status,
    })
    .from(users)
    .leftJoin(
      identityProviders,
      and(eq(identityProviders.issuer, users.issuer), eq(identityProviders.status, 'active')),
    )
    .where(
      and(
        input.status ? eq(users.status, input.status) : undefined,
        term ? or(ilike(users.email, `%${term}%`), ilike(users.subject, `%${term}%`)) : undefined,
      ),
    )
    .orderBy(asc(users.email), asc(users.subject), asc(users.id))
    .limit(100);
  const details = await userDetails(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, ...details.get(row.id) }));
}

/**
 * Returns one identity and its workspace memberships for administrators.
 *
 * @param db - Control-plane database connection.
 * @param userId - User identifier.
 */
export async function getAdminUser(db: Db, userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;
  return { ...user, ...(await userDetails(db, [userId])).get(userId) };
}

/**
 * Enables or disables a user and appends the matching audit action atomically.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, user, target status, and optional reason.
 */
export function setAdminUserStatus(
  db: Db,
  input: { actorUserId: string; userId: string; status: 'active' | 'disabled'; reason?: string },
) {
  return db.transaction(async (tx) => {
    if ((await lockUserOwnershipScopes(tx, input.userId)) === null) {
      throw new AdminMutationError(
        'conflict',
        'workspace membership changed; refresh and try again',
      );
    }
    const [current] = await tx
      .select({ status: users.status, email: users.email })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for('no key update');
    if (!current) throw new AdminMutationError('not_found', 'user not found');
    if (current.status === 'deleted' || current.status === input.status) {
      throw new AdminMutationError('conflict', `user is ${current.status}`);
    }
    const [user] = await tx
      .update(users)
      .set({ status: input.status })
      .where(eq(users.id, input.userId))
      .returning();
    const adminActionId = await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: input.status === 'disabled' ? 'user.disable' : 'user.enable',
      targetKind: 'user',
      targetId: input.userId,
      reason: input.reason,
    });
    return { ...user!, adminActionId };
  });
}

/**
 * Moves the user's durable token cutoff to the current database time.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, user, and optional reason.
 */
export function signOutAdminUser(
  db: Db,
  input: { actorUserId: string; userId: string; reason?: string },
): Promise<Date> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ notBefore: sql`clock_timestamp()` })
      .where(and(eq(users.id, input.userId), inArray(users.status, ['active', 'disabled'])))
      .returning({ notBefore: users.notBefore });
    if (!user?.notBefore) throw new AdminMutationError('not_found', 'user not found');
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'user.sign_out_everywhere',
      targetKind: 'user',
      targetId: input.userId,
      reason: input.reason,
    });
    return user.notBefore;
  });
}

/**
 * Removes one workspace membership while preserving at least one active owner.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, user, workspace, and optional reason.
 */
export function removeAdminMembership(
  db: Db,
  input: { actorUserId: string; userId: string; tenantId: string; reason?: string },
) {
  return db.transaction(async (tx) => {
    await lockOwnershipWorkspaces(tx, [input.tenantId]);
    await lockOwnershipAccounts(tx, input.tenantId);
    const [membership] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, input.userId),
          eq(memberships.tenantId, input.tenantId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1)
      .for('update');
    if (!membership) throw new AdminMutationError('not_found', 'active membership not found');
    if (membership.role === 'owner') {
      if (!(await hasOtherActiveOwner(tx, input.tenantId, input.userId))) {
        throw new AdminMutationError('last_owner', 'assign another owner before removal');
      }
    }
    const [removed] = await tx
      .update(memberships)
      .set({ status: 'removed' })
      .where(and(eq(memberships.userId, input.userId), eq(memberships.tenantId, input.tenantId)))
      .returning();
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'user.membership_remove',
      targetKind: 'user',
      targetId: input.userId,
      reason: input.reason,
      details: { tenantId: input.tenantId },
    });
    return removed!;
  });
}

async function assertInstallationIdentity(db: Tx, userId: string) {
  const [target] = await db
    .select({ scope: identityProviders.scope })
    .from(users)
    .innerJoin(
      identityProviders,
      and(eq(identityProviders.issuer, users.issuer), eq(identityProviders.status, 'active')),
    )
    .where(and(eq(users.id, userId), eq(users.status, 'active')))
    .limit(1);
  if (target?.scope !== 'installation') {
    throw new AdminMutationError(
      'invalid_target',
      'platform administrators must use an active staff identity',
    );
  }
}

async function countUsablePlatformAdmins(db: Tx): Promise<number> {
  const [row] = await db
    .select({ count: countDistinct(platformOperators.userId) })
    .from(platformOperators)
    .innerJoin(users, eq(users.id, platformOperators.userId))
    .innerJoin(
      identityProviders,
      and(
        eq(identityProviders.issuer, users.issuer),
        eq(identityProviders.scope, 'installation'),
        eq(identityProviders.status, 'active'),
      ),
    )
    .where(eq(users.status, 'active'));
  return row?.count ?? 0;
}

async function isUsablePlatformAdmin(db: Tx, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: platformOperators.userId })
    .from(platformOperators)
    .innerJoin(users, eq(users.id, platformOperators.userId))
    .innerJoin(
      identityProviders,
      and(
        eq(identityProviders.issuer, users.issuer),
        eq(identityProviders.scope, 'installation'),
        eq(identityProviders.status, 'active'),
      ),
    )
    .where(and(eq(platformOperators.userId, userId), eq(users.status, 'active')))
    .limit(1);
  return Boolean(row);
}

/**
 * Grants platform-administrator access to a staff-directory identity.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, target user, and optional reason.
 */
export function grantAdminRole(
  db: Db,
  input: { actorUserId: string; userId: string; reason?: string },
) {
  return db.transaction(async (tx) => {
    await assertInstallationIdentity(tx, input.userId);
    const [operator] = await tx
      .insert(platformOperators)
      .values({ userId: input.userId })
      .onConflictDoNothing()
      .returning();
    if (!operator)
      throw new AdminMutationError('conflict', 'user is already a platform administrator');
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'user.grant_admin',
      targetKind: 'user',
      targetId: input.userId,
      reason: input.reason,
    });
    return operator;
  });
}

/**
 * Revokes platform-administrator access while preserving a final administrator.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, target user, and optional reason.
 */
export function revokeAdminRole(
  db: Db,
  input: { actorUserId: string; userId: string; reason?: string },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table platform_operators in share row exclusive mode`);
    const [target] = await tx
      .select({ userId: platformOperators.userId })
      .from(platformOperators)
      .where(eq(platformOperators.userId, input.userId))
      .limit(1)
      .for('update');
    if (!target) throw new AdminMutationError('not_found', 'platform administrator not found');
    if (
      (await isUsablePlatformAdmin(tx, input.userId)) &&
      (await countUsablePlatformAdmins(tx)) <= 1
    ) {
      throw new AdminMutationError(
        'last_admin',
        'the final platform administrator cannot be revoked',
      );
    }
    await tx.delete(platformOperators).where(eq(platformOperators.userId, input.userId));
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'user.revoke_admin',
      targetKind: 'user',
      targetId: input.userId,
      reason: input.reason,
    });
    return { revoked: true };
  });
}

/**
 * Tombstones an identity while retaining foreign-key attribution.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, target user, and optional reason.
 */
export function tombstoneAdminUser(
  db: Db,
  input: { actorUserId: string; userId: string; reason?: string },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table platform_operators in share row exclusive mode`);
    const scopeIds = await lockUserOwnershipScopes(tx, input.userId);
    if (scopeIds === null) {
      throw new AdminMutationError(
        'conflict',
        'workspace membership changed; refresh and try again',
      );
    }
    const ownerMemberships = await tx
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, input.userId),
          eq(memberships.status, 'active'),
          eq(memberships.role, 'owner'),
        ),
      );
    for (const membership of ownerMemberships) {
      if (!(await hasOtherActiveOwner(tx, membership.tenantId, input.userId))) {
        throw new AdminMutationError(
          'last_owner',
          'assign another active-account owner in each workspace before deleting this user',
        );
      }
    }
    const [operator] = await tx
      .select({ userId: platformOperators.userId })
      .from(platformOperators)
      .where(eq(platformOperators.userId, input.userId))
      .limit(1)
      .for('update');
    if (operator) {
      if (
        (await isUsablePlatformAdmin(tx, input.userId)) &&
        (await countUsablePlatformAdmins(tx)) <= 1
      ) {
        throw new AdminMutationError(
          'last_admin',
          'the final platform administrator cannot be deleted',
        );
      }
      await tx.delete(platformOperators).where(eq(platformOperators.userId, input.userId));
    }
    const [user] = await tx
      .update(users)
      .set({
        email: null,
        // Retain the identity key so a still-valid provider token cannot create a replacement user.
        status: 'deleted',
        notBefore: sql`clock_timestamp()`,
      })
      .where(and(eq(users.id, input.userId), inArray(users.status, ['active', 'disabled'])))
      .returning();
    if (!user) throw new AdminMutationError('not_found', 'user not found');
    await tx
      .update(memberships)
      .set({ status: 'removed' })
      .where(eq(memberships.userId, input.userId));
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'user.delete',
      targetKind: 'user',
      targetId: input.userId,
      reason: input.reason,
    });
    return user;
  });
}
