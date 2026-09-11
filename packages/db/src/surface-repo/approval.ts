import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant, type Tx } from '../rls';
import { approvals, incidentMessages } from '../schema';

export interface ApprovalOption {
  id: string;
  label: string;
}

export interface NewApproval {
  incidentId: string;
  actionId: string;
  prompt: string;
  options: ApprovalOption[];
}

/**
 * Creates approval.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function createApproval(
  db: Db,
  tenantId: string,
  input: NewApproval,
): Promise<{ row: typeof approvals.$inferSelect; inserted: boolean }> {
  return withTenant(db, tenantId, (tx) => createApprovalTx(tx, tenantId, input));
}

/** Persist a proposal within the caller's input/publication fence.
 * @param tx - Existing tenant transaction.
 * @param tenantId - Server-selected tenant.
 * @param input - Validated proposal.
 */
export async function createApprovalTx(
  tx: Tx,
  tenantId: string,
  input: NewApproval,
): Promise<{ row: typeof approvals.$inferSelect; inserted: boolean }> {
  const rows = await tx
    .insert(approvals)
    .values({
      tenantId,
      incidentId: input.incidentId,
      actionId: input.actionId,
      prompt: input.prompt,
      options: input.options,
    })
    .onConflictDoNothing({
      target: [approvals.tenantId, approvals.incidentId, approvals.actionId],
    })
    .returning();
  if (rows[0]) return { row: rows[0], inserted: true };
  // Conflict: the approval already exists (redelivery). Return it, still tenant-scoped.
  const existing = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.incidentId, input.incidentId), eq(approvals.actionId, input.actionId)))
    .limit(1);
  return { row: existing[0]!, inserted: false };
}

/**
 * Provides approval message exists.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param approvalId - Approval targeted by the operation.
 */
export async function approvalMessageExists(
  db: Db,
  tenantId: string,
  approvalId: string,
): Promise<boolean> {
  return withTenant(db, tenantId, (tx) => approvalMessageExistsTx(tx, approvalId));
}

/** Check proposal delivery inside its publication transaction.
 * @param tx - Existing tenant transaction.
 * @param approvalId - Proposal being published.
 */
export async function approvalMessageExistsTx(tx: Tx, approvalId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: incidentMessages.id })
    .from(incidentMessages)
    .where(eq(incidentMessages.approvalId, approvalId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Returns approval.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param actionId - action id targeted by the operation.
 */
export async function getApproval(db: Db, tenantId: string, incidentId: string, actionId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.incidentId, incidentId), eq(approvals.actionId, actionId)))
      .limit(1);
    return rows[0];
  });
}

/**
 * Returns approval by id.
 *
 * @param db - Database connection used for the operation.
 * @param approvalId - Approval targeted by the operation.
 */
export async function getApprovalById(db: Db, approvalId: string) {
  const rows = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
  return rows[0];
}

/**
 * Provides decide approval tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param actionId - action id targeted by the operation.
 * @param decision - Value supplied for decision.
 * @param decidedBy - Value supplied for decided by.
 */
export async function decideApprovalTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  actionId: string,
  decision: string,
  decidedBy: string,
): Promise<boolean> {
  const rows = await tx
    .update(approvals)
    .set({ decision, decidedBy, decidedAt: sql`now()` })
    .where(
      and(
        eq(approvals.incidentId, incidentId),
        eq(approvals.actionId, actionId),
        sql`decision is null`,
      ),
    )
    .returning({ id: approvals.id });
  return rows.length > 0;
}

/**
 * Provides decide approval.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param actionId - action id targeted by the operation.
 * @param decision - Value supplied for decision.
 * @param decidedBy - Value supplied for decided by.
 */
export async function decideApproval(
  db: Db,
  tenantId: string,
  incidentId: string,
  actionId: string,
  decision: string,
  decidedBy: string,
): Promise<boolean> {
  return withTenant(db, tenantId, (tx) =>
    decideApprovalTx(tx, tenantId, incidentId, actionId, decision, decidedBy),
  );
}
