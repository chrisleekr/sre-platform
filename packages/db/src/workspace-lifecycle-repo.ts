import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Tx } from './rls';
import { identityProviders, jobs, memberships, tenantIdentityBindings, tenants } from './schema';
import { lockWorkspace, WorkspaceSettingsMutationError } from './workspace-settings-support';

export interface WorkspacePurgeInsert {
  (tx: Tx, tenantId: string, availableAt: Date): Promise<{ jobId: string; created: boolean }>;
}

/** Schedules workspace deletion and its durable fourteen-day purge in one transaction.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace to schedule for deletion.
 * @param enqueue - Inserts the purge command within the transaction.
 * @param now - Reference time for the fourteen-day grace period.
 */
export function scheduleWorkspaceDeletion(
  db: Db,
  tenantId: string,
  enqueue: WorkspacePurgeInsert,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const current = await lockWorkspace(tx, tenantId);
    const deleteAfter =
      current.status === 'deleting' && current.deleteAfter
        ? current.deleteAfter
        : new Date(now.getTime() + 14 * 86_400_000);
    const [workspace] = await tx
      .update(tenants)
      .set({ status: 'deleting', deleteAfter })
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id, slug: tenants.slug, deleteAfter: tenants.deleteAfter });
    const purge = await enqueue(tx, tenantId, deleteAfter);
    return { workspace: workspace!, purge };
  });
}

/** Lists active member identities for tenant-wide session revocation.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace whose member sockets must close.
 */
export function listWorkspaceActiveUserIds(db: Db, tenantId: string) {
  return db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active')));
}

/** Cancels a scheduled deletion and retires its not-yet-run purge command.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace whose deletion is cancelled.
 */
export function cancelWorkspaceDeletion(db: Db, tenantId: string) {
  return db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, tenantId);
    if (
      workspace.status !== 'deleting' ||
      !workspace.deleteAfter ||
      workspace.deleteAfter <= new Date()
    ) {
      throw new WorkspaceSettingsMutationError(
        'invalid_state',
        'the deletion cancellation period has ended',
      );
    }
    const [updated] = await tx
      .update(tenants)
      .set({ status: 'active', deleteAfter: null })
      .where(eq(tenants.id, tenantId))
      .returning({ id: tenants.id, status: tenants.status, deleteAfter: tenants.deleteAfter });
    await tx
      .update(jobs)
      .set({ status: 'done', updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(jobs.type, 'tenant.purge'),
          sql`${jobs.payload}->>'tenantId' = ${tenantId}`,
          inArray(jobs.status, ['queued', 'processing']),
        ),
      );
    return updated!;
  });
}

/** Resolves an owner back to one deleting workspace without reopening general product access.
 * @param db - Control-plane database connection.
 * @param input - Authenticated owner, method, and confirmed workspace address.
 */
export async function findDeletingWorkspaceOwner(
  db: Db,
  input: { userId: string; providerId: string; slug: string; bindingClaimValue?: string | null },
): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: tenants.id })
    .from(tenants)
    .innerJoin(memberships, eq(memberships.tenantId, tenants.id))
    .innerJoin(tenantIdentityBindings, eq(tenantIdentityBindings.tenantId, tenants.id))
    .innerJoin(identityProviders, eq(identityProviders.id, tenantIdentityBindings.providerId))
    .where(
      and(
        eq(tenants.slug, input.slug),
        eq(tenants.status, 'deleting'),
        eq(memberships.userId, input.userId),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
        eq(tenantIdentityBindings.providerId, input.providerId),
        input.bindingClaimValue == null
          ? isNull(tenantIdentityBindings.claimValue)
          : eq(tenantIdentityBindings.claimValue, input.bindingClaimValue),
        eq(identityProviders.status, 'active'),
        sql`(not ${tenants.requireDirectory} or ${identityProviders.scope} = 'tenant')`,
      ),
    )
    .limit(1);
  return row?.tenantId ?? null;
}

/** Lists deletion dates and cancellation access for the signed-in member's bound workspaces.
 * @param db - Control-plane database connection.
 * @param input - Authenticated user and sign-in method identifiers.
 */
export function listDeletingWorkspaces(
  db: Db,
  input: { userId: string; providerId: string; bindingClaimValue?: string | null },
) {
  return db
    .select({
      name: tenants.name,
      slug: tenants.slug,
      deleteAfter: tenants.deleteAfter,
      role: memberships.role,
    })
    .from(tenants)
    .innerJoin(memberships, eq(memberships.tenantId, tenants.id))
    .innerJoin(tenantIdentityBindings, eq(tenantIdentityBindings.tenantId, tenants.id))
    .innerJoin(identityProviders, eq(identityProviders.id, tenantIdentityBindings.providerId))
    .where(
      and(
        eq(tenants.status, 'deleting'),
        eq(memberships.userId, input.userId),
        eq(memberships.status, 'active'),
        eq(tenantIdentityBindings.providerId, input.providerId),
        input.bindingClaimValue == null
          ? isNull(tenantIdentityBindings.claimValue)
          : eq(tenantIdentityBindings.claimValue, input.bindingClaimValue),
        eq(identityProviders.status, 'active'),
        sql`(not ${tenants.requireDirectory} or ${identityProviders.scope} = 'tenant')`,
      ),
    );
}

/** Permanently removes a due workspace, its tenant data, queue rows, and tenant-only providers.
 * @param db - Control-plane database connection.
 * @param tenantId - Workspace to purge after its deadline.
 * @param now - Reference time for the deadline check.
 */
export function purgeWorkspaceIfDue(db: Db, tenantId: string, now?: Date) {
  return db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, tenantId).catch((error) => {
      if (error instanceof WorkspaceSettingsMutationError && error.code === 'workspace_not_found') {
        return null;
      }
      throw error;
    });
    if (!workspace) return 'missing' as const;
    const [clock] = now
      ? []
      : await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    const referenceTime = now?.getTime() ?? new Date(clock!.now).getTime();
    if (
      workspace.status !== 'deleting' ||
      !workspace.deleteAfter ||
      workspace.deleteAfter.getTime() > referenceTime
    ) {
      return 'not_due' as const;
    }
    const providers = await tx
      .select({ id: identityProviders.id })
      .from(tenantIdentityBindings)
      .innerJoin(identityProviders, eq(identityProviders.id, tenantIdentityBindings.providerId))
      .where(
        and(eq(tenantIdentityBindings.tenantId, tenantId), eq(identityProviders.scope, 'tenant')),
      );
    await tx.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await tx.delete(tenants).where(eq(tenants.id, tenantId));
    if (providers.length) {
      await tx.delete(identityProviders).where(
        inArray(
          identityProviders.id,
          providers.map((provider) => provider.id),
        ),
      );
    }
    return 'purged' as const;
  });
}
