import { and, count, desc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import type { InsertFoundingJobTx } from '../founding-repo';
import { identityProviders, users, workspaceFoundings, type FoundingStatus } from '../schema';
import { AdminMutationError, appendAdminAction } from './support';

/**
 * Lists workspace-registration requests for the platform control room.
 *
 * @param db - Control-plane database connection.
 * @param status - Optional lifecycle filter.
 */
export function listAdminFoundings(db: Db, status?: FoundingStatus) {
  return db
    .select({
      id: workspaceFoundings.id,
      status: workspaceFoundings.status,
      requestedName: workspaceFoundings.requestedName,
      slug: workspaceFoundings.slug,
      path: workspaceFoundings.path,
      declaredDomain: workspaceFoundings.declaredDomain,
      failureReason: workspaceFoundings.failureReason,
      founderUserId: workspaceFoundings.founderUserId,
      founderEmail: users.email,
      issuer: identityProviders.issuer,
      createdAt: workspaceFoundings.createdAt,
      updatedAt: workspaceFoundings.updatedAt,
    })
    .from(workspaceFoundings)
    .leftJoin(users, eq(users.id, workspaceFoundings.founderUserId))
    .leftJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
    .where(status ? eq(workspaceFoundings.status, status) : undefined)
    .orderBy(desc(workspaceFoundings.createdAt), desc(workspaceFoundings.id))
    .limit(100);
}

/**
 * Counts pending registration decisions for the administrator account badge.
 *
 * @param db - Control-plane database connection.
 */
export async function countPendingAdminFoundings(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(workspaceFoundings)
    .where(eq(workspaceFoundings.status, 'pending'));
  return row?.count ?? 0;
}

interface FoundingMutationInput {
  actorUserId: string;
  foundingId: string;
  insertJobTx: InsertFoundingJobTx;
}

async function foundingRecipient(db: Db, foundingId: string) {
  const [row] = await db
    .select({
      founding: workspaceFoundings,
      founderEmail: users.email,
    })
    .from(workspaceFoundings)
    .leftJoin(users, eq(users.id, workspaceFoundings.founderUserId))
    .where(eq(workspaceFoundings.id, foundingId))
    .limit(1);
  return row ?? null;
}

/**
 * Approves a pending founding and creates its durable provisioning command atomically.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, founding, and transactional queue writer.
 */
export async function approveAdminFounding(db: Db, input: FoundingMutationInput) {
  const result = await db.transaction(async (tx) => {
    const [founding] = await tx
      .select()
      .from(workspaceFoundings)
      .where(eq(workspaceFoundings.id, input.foundingId))
      .limit(1)
      .for('update');
    if (!founding) throw new AdminMutationError('not_found', 'registration not found');
    if (founding.status !== 'pending') {
      throw new AdminMutationError('conflict', `registration is ${founding.status}`);
    }
    const [approved] = await tx
      .update(workspaceFoundings)
      .set({ status: 'approved', failureReason: null, updatedAt: new Date() })
      .where(
        and(eq(workspaceFoundings.id, input.foundingId), eq(workspaceFoundings.status, 'pending')),
      )
      .returning();
    if (!approved) throw new AdminMutationError('conflict', 'registration changed');
    const job = await input.insertJobTx(tx, input.foundingId);
    if (!job.created) throw new AdminMutationError('conflict', 'provisioning is already queued');
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'founding.approve',
      targetKind: 'founding',
      targetId: input.foundingId,
      details: { jobId: job.jobId },
    });
    return { founding: approved, jobId: job.jobId };
  });
  return { ...result, recipient: await foundingRecipient(db, input.foundingId) };
}

/**
 * Rejects a pending founding with the reason retained in both state and audit.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, founding, and rejection reason.
 */
export async function rejectAdminFounding(
  db: Db,
  input: { actorUserId: string; foundingId: string; reason: string },
) {
  const founding = await db.transaction(async (tx) => {
    const [rejected] = await tx
      .update(workspaceFoundings)
      .set({ status: 'rejected', failureReason: input.reason, updatedAt: new Date() })
      .where(
        and(eq(workspaceFoundings.id, input.foundingId), eq(workspaceFoundings.status, 'pending')),
      )
      .returning();
    if (!rejected) throw new AdminMutationError('conflict', 'registration is not pending');
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'founding.reject',
      targetKind: 'founding',
      targetId: input.foundingId,
      reason: input.reason,
    });
    return rejected;
  });
  return { founding, recipient: await foundingRecipient(db, input.foundingId) };
}

/**
 * Requeues a failed founding without bypassing the worker-owned provisioning transition.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, founding, and transactional queue writer.
 */
export async function retryAdminFounding(db: Db, input: FoundingMutationInput) {
  return db.transaction(async (tx) => {
    const [founding] = await tx
      .update(workspaceFoundings)
      .set({ status: 'approved', failureReason: null, updatedAt: new Date() })
      .where(
        and(eq(workspaceFoundings.id, input.foundingId), eq(workspaceFoundings.status, 'failed')),
      )
      .returning();
    if (!founding) throw new AdminMutationError('conflict', 'registration is not failed');
    const job = await input.insertJobTx(tx, input.foundingId);
    if (!job.created) throw new AdminMutationError('conflict', 'provisioning is already queued');
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'founding.retry',
      targetKind: 'founding',
      targetId: input.foundingId,
      details: { jobId: job.jobId },
    });
    return { founding, jobId: job.jobId };
  });
}
