import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  getWorkspaceOwnership,
  lockOwnershipAccounts,
  lockOwnershipWorkspaces,
} from '../ownership';
import { identityProviders, memberships, platformOperators, tenants, users } from '../schema';
import { AdminMutationError, appendAdminAction } from './support';

/** Lists existing members eligible for explicit ownership recovery.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace identifier.
 */
export function listOwnershipRecoveryMembers(db: Db, tenantId: string) {
  return db
    .select({ userId: users.id, email: users.email, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, 'active'),
        eq(users.status, 'active'),
      ),
    )
    .orderBy(asc(users.email), asc(users.id));
}

/** Restores ownership only after checking live administrator authority and auditing the exact target.
 * @param db - Privileged control-plane database connection, also used for administrator revocation.
 * @param input - Verified acting provider, exact workspace/member and recovery reason.
 */
export function recoverWorkspaceOwner(
  db: Db,
  input: {
    actorUserId: string;
    actorProviderId: string;
    tenantId: string;
    userId: string;
    reason: string;
    allowLocal?: boolean;
  },
) {
  return db.transaction(async (tx) => {
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 2000)
      throw new AdminMutationError(
        'invalid_target',
        'a recovery reason between 3 and 2000 characters is required',
      );
    // Revoke/delete take the conflicting table lock before workspace or user locks.
    await tx.execute(sql`lock table platform_operators in share mode`);
    await lockOwnershipWorkspaces(tx, [input.tenantId]);
    await lockOwnershipAccounts(tx, input.tenantId, [input.actorUserId, input.userId]);
    const [actor] = await tx
      .select({ id: users.id, scope: identityProviders.scope, kind: identityProviders.kind })
      .from(users)
      .innerJoin(platformOperators, eq(platformOperators.userId, users.id))
      .innerJoin(
        identityProviders,
        and(
          eq(identityProviders.id, input.actorProviderId),
          eq(identityProviders.issuer, users.issuer),
        ),
      )
      .where(
        and(
          eq(users.id, input.actorUserId),
          eq(users.status, 'active'),
          eq(identityProviders.status, 'active'),
        ),
      )
      .for('share', { of: identityProviders });
    if (!actor || (actor.scope !== 'installation' && !(input.allowLocal && actor.kind === 'local')))
      throw new AdminMutationError(
        'forbidden',
        'an active platform administrator using an authorized sign-in method is required',
      );
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, input.tenantId));
    if (!tenant) throw new AdminMutationError('not_found', 'workspace not found');
    if (tenant.status !== 'active')
      throw new AdminMutationError(
        'conflict',
        'reactivate the workspace before recovering ownership',
      );
    const ownership = await getWorkspaceOwnership(tx, input.tenantId);
    if (ownership.activeOwnerCount > 0)
      throw new AdminMutationError(
        'conflict',
        'an active-account owner already exists; ask that owner to transfer ownership',
      );
    const [member] = await tx
      .select({ role: memberships.role, status: users.status })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, input.tenantId),
          eq(memberships.userId, input.userId),
          eq(memberships.status, 'active'),
        ),
      );
    if (!member || member.status !== 'active')
      throw new AdminMutationError(
        'invalid_target',
        'choose an existing active member with an active account in this workspace',
      );
    await tx
      .update(memberships)
      .set({ role: 'owner' })
      .where(and(eq(memberships.tenantId, input.tenantId), eq(memberships.userId, input.userId)));
    const adminActionId = await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'workspace.owner_recover',
      targetKind: 'tenant',
      targetId: input.tenantId,
      reason,
      details: {
        userId: input.userId,
        previousRole: member.role,
        role: 'owner',
        inactiveOwnerCount: ownership.inactiveOwnerCount,
      },
    });
    return {
      userId: input.userId,
      tenantId: input.tenantId,
      role: 'owner' as const,
      adminActionId,
    };
  });
}
