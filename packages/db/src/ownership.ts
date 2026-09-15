import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import type { Tx } from './rls';
import { memberships, tenants, users } from './schema';

/** Summarizes stored ownership without claiming external sign-in availability.
 * @param db - Database connection.
 * @param tenantId - Workspace identifier.
 */
export async function getWorkspaceOwnership(db: Db | Tx, tenantId: string) {
  const owners = await db
    .select({ userId: users.id, accountStatus: users.status })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, 'active'),
        eq(memberships.role, 'owner'),
      ),
    );
  const activeOwnerCount = owners.filter((owner) => owner.accountStatus === 'active').length;
  return {
    state:
      activeOwnerCount > 0
        ? ('owned' as const)
        : owners.length > 0
          ? ('inactive_owners' as const)
          : ('missing_owner' as const),
    activeOwnerCount,
    inactiveOwnerCount: owners.length - activeOwnerCount,
  };
}

/** Locks workspace decisions before any account or membership row.
 * @param tx - Owning transaction.
 * @param tenantIds - Workspace identifiers, sorted internally to prevent lock inversions.
 * @param mode - Shared admission lock or exclusive ownership mutation lock.
 */
export async function lockOwnershipWorkspaces(
  tx: Tx,
  tenantIds: string[],
  mode: 'share' | 'update' = 'update',
) {
  if (!tenantIds.length) return;
  await tx
    .select({ id: tenants.id })
    .from(tenants)
    .where(inArray(tenants.id, tenantIds))
    .orderBy(asc(tenants.id))
    .for(mode);
}

/** Freezes account status while a workspace ownership decision is made.
 * @param tx - Transaction already holding the workspace lock.
 * @param tenantId - Workspace identifier.
 * @param extraUserIds - Additional actors whose live status must remain stable.
 */
export async function lockOwnershipAccounts(tx: Tx, tenantId: string, extraUserIds: string[] = []) {
  const members = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId));
  const ids = [...new Set([...members.map((member) => member.userId), ...extraUserIds])];
  if (!ids.length) return;
  await tx
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, ids))
    .orderBy(asc(users.id))
    // Freeze account status without blocking audit foreign-key checks against immutable user IDs.
    .for('no key update');
}

/** Locks all known workspaces before an account-wide change and detects stale scope discovery.
 * @param tx - Owning transaction.
 * @param userId - Account being changed.
 */
export async function lockUserOwnershipScopes(tx: Tx, userId: string): Promise<string[] | null> {
  const scopes = () =>
    tx
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .orderBy(asc(memberships.tenantId));
  const before = await scopes();
  await lockOwnershipWorkspaces(
    tx,
    before.map((scope) => scope.tenantId),
  );
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('no key update');
  const after = await scopes();
  if (
    before.length !== after.length ||
    before.some((scope, index) => scope.tenantId !== after[index]?.tenantId)
  )
    return null;
  return before.map((scope) => scope.tenantId);
}

/** Checks for another owner whose account and workspace membership remain active.
 * @param tx - Transaction holding workspace and relevant account locks.
 * @param tenantId - Workspace identifier.
 * @param exceptUserId - Owner being removed or demoted.
 */
export async function hasOtherActiveOwner(tx: Tx, tenantId: string, exceptUserId: string) {
  const owners = await tx
    .select({ userId: users.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, 'active'),
        eq(memberships.role, 'owner'),
        eq(users.status, 'active'),
      ),
    );
  return owners.some((owner) => owner.userId !== exceptUserId);
}
