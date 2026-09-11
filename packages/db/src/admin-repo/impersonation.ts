import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { impersonationSessions, tenants } from '../schema';
import { AdminMutationError, appendAdminAction } from './support';

/**
 * Starts one non-extendable, one-hour support session and audits it atomically.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, workspace, and required support reason.
 */
export function createAdminImpersonation(
  db: Db,
  input: { actorUserId: string; tenantId: string; reason: string },
) {
  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .select({ id: tenants.id, name: tenants.name, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, input.tenantId))
      .limit(1)
      .for('share');
    if (!tenant) throw new AdminMutationError('not_found', 'workspace not found');
    if (tenant.status !== 'active') {
      throw new AdminMutationError('conflict', `workspace is ${tenant.status}`);
    }
    const [session] = await tx
      .insert(impersonationSessions)
      .values({
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        reason: input.reason,
        expiresAt: sql`now() + interval '1 hour'`,
      })
      .returning();
    if (!session) throw new Error('impersonation session insert returned no row');
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'tenant.impersonate',
      targetKind: 'tenant',
      targetId: input.tenantId,
      reason: input.reason,
      details: { sessionId: session.id, expiresAt: session.expiresAt.toISOString() },
    });
    return { ...session, tenantName: tenant.name };
  });
}

/**
 * Resolves a live support session only for its original platform administrator.
 *
 * @param db - Control-plane database connection.
 * @param sessionId - Support-session identifier.
 * @param actorUserId - Administrator who started the session.
 */
export async function getActiveAdminImpersonation(db: Db, sessionId: string, actorUserId: string) {
  const [session] = await db
    .select({
      id: impersonationSessions.id,
      actorUserId: impersonationSessions.actorUserId,
      tenantId: impersonationSessions.tenantId,
      tenantName: tenants.name,
      reason: impersonationSessions.reason,
      startedAt: impersonationSessions.startedAt,
      expiresAt: impersonationSessions.expiresAt,
    })
    .from(impersonationSessions)
    .innerJoin(tenants, eq(tenants.id, impersonationSessions.tenantId))
    .where(
      and(
        eq(impersonationSessions.id, sessionId),
        eq(impersonationSessions.actorUserId, actorUserId),
        isNull(impersonationSessions.endedAt),
        gt(impersonationSessions.expiresAt, sql`clock_timestamp()`),
        eq(tenants.status, 'active'),
      ),
    )
    .limit(1);
  return session ?? null;
}

/**
 * Ends a support session early and audits the action atomically.
 *
 * @param db - Control-plane database connection.
 * @param input - Actor, support session, and optional reason.
 */
export function endAdminImpersonation(
  db: Db,
  input: { actorUserId: string; sessionId: string; reason?: string },
) {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .update(impersonationSessions)
      .set({ endedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(impersonationSessions.id, input.sessionId),
          eq(impersonationSessions.actorUserId, input.actorUserId),
          isNull(impersonationSessions.endedAt),
        ),
      )
      .returning();
    if (!session) throw new AdminMutationError('not_found', 'active support session not found');
    await appendAdminAction(tx, {
      actorUserId: input.actorUserId,
      action: 'tenant.impersonation_end',
      targetKind: 'tenant',
      targetId: session.tenantId,
      reason: input.reason,
      details: { sessionId: session.id },
    });
    return session;
  });
}
