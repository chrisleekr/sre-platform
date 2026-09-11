import type {
  IncidentFeedbackDecision,
  IncidentFeedbackRecord,
  IncidentFeedbackTarget,
} from '@sre/contracts';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Tx } from './rls';
import { incidentFeedback } from './schema';

export interface RecordIncidentFeedbackInput {
  targetType: IncidentFeedbackTarget;
  targetId: string;
  decision: IncidentFeedbackDecision;
  rationale: string;
  correction?: Record<string, unknown> | null;
  createdByUserId: string;
}

const WORKSPACE_FEEDBACK_TARGET_LIMIT = 200;
const FEEDBACK_WRITES_PER_MINUTE = 30;

/** Raised when one responder exceeds the bounded append-only feedback rate. */
export class IncidentFeedbackRateLimitError extends Error {
  constructor() {
    super('feedback rate limit exceeded');
    this.name = 'IncidentFeedbackRateLimitError';
  }
}

/**
 * Serializes and checks one responder's feedback admission before domain records are locked.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the feedback ledger.
 * @param userId - Attributed responder submitting feedback.
 */
export async function enforceIncidentFeedbackAdmissionTx(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`incident-feedback:${tenantId}:${userId}`}, 0))`,
  );
  const recent = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(incidentFeedback)
    .where(
      and(
        eq(incidentFeedback.tenantId, tenantId),
        eq(incidentFeedback.createdByUserId, userId),
        gte(incidentFeedback.createdAt, sql<Date>`statement_timestamp() - interval '1 minute'`),
      ),
    );
  if ((recent[0]?.count ?? 0) >= FEEDBACK_WRITES_PER_MINUTE)
    throw new IncidentFeedbackRateLimitError();
}

function toIncidentFeedbackRecord(
  row: typeof incidentFeedback.$inferSelect,
): IncidentFeedbackRecord {
  return {
    id: row.id,
    incidentId: row.incidentId,
    targetType: row.targetType,
    targetId: row.targetId,
    decision: row.decision,
    rationale: row.rationale,
    correction: row.correction,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Persists one attributed responder verdict inside an existing tenant transaction.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the feedback.
 * @param incidentId - Incident whose evidence was reviewed.
 * @param input - Attributed verdict and optional correction.
 */
export async function recordIncidentFeedbackTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  input: RecordIncidentFeedbackInput,
): Promise<IncidentFeedbackRecord> {
  const targetId = input.targetId.trim();
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`incident-feedback-target:${tenantId}:${input.targetType}:${targetId}`}, 0))`,
  );
  const [latest] = await tx
    .select({ revision: sql<number>`coalesce(max(${incidentFeedback.revision}), 0)::int` })
    .from(incidentFeedback)
    .where(
      and(
        eq(incidentFeedback.tenantId, tenantId),
        eq(incidentFeedback.targetType, input.targetType),
        eq(incidentFeedback.targetId, targetId),
      ),
    );
  const [row] = await tx
    .insert(incidentFeedback)
    .values({
      tenantId,
      incidentId,
      ...input,
      targetId,
      revision: (latest?.revision ?? 0) + 1,
      rationale: input.rationale.trim(),
      correction: input.correction ?? null,
    })
    .returning();
  if (!row) throw new Error('incident feedback insert failed');
  return toIncidentFeedbackRecord(row);
}

/**
 * Persists one attributed responder verdict under tenant RLS.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the feedback.
 * @param incidentId - Incident whose evidence was reviewed.
 * @param input - Attributed verdict and optional correction.
 */
export function recordIncidentFeedback(
  db: Db,
  tenantId: string,
  incidentId: string,
  input: RecordIncidentFeedbackInput,
) {
  return withTenant(db, tenantId, (tx) =>
    recordIncidentFeedbackTx(tx, tenantId, incidentId, input),
  );
}

/**
 * Returns the incident's append-only responder feedback, newest first.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose feedback is read.
 * @param incidentId - Incident whose feedback is read.
 * @param options - Maximum number of newest ledger rows to return.
 */
export async function listIncidentFeedback(
  db: Db,
  tenantId: string,
  incidentId: string,
  options: { limit?: number } = {},
): Promise<IncidentFeedbackRecord[]> {
  return withTenant(db, tenantId, async (tx) => {
    const limit = Math.max(1, Math.min(WORKSPACE_FEEDBACK_TARGET_LIMIT, options.limit ?? 100));
    const rows = await tx
      .select()
      .from(incidentFeedback)
      .where(eq(incidentFeedback.incidentId, incidentId))
      .orderBy(desc(incidentFeedback.createdAt), desc(incidentFeedback.id))
      .limit(limit);
    return rows.map(toIncidentFeedbackRecord);
  });
}

/**
 * Returns only the newest responder verdict per target for the incident workspace.
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose feedback is read.
 * @param incidentId - Incident whose current verdicts are read.
 */
export async function listLatestIncidentFeedback(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<IncidentFeedbackRecord[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .selectDistinctOn([incidentFeedback.targetType, incidentFeedback.targetId])
      .from(incidentFeedback)
      .where(eq(incidentFeedback.incidentId, incidentId))
      .orderBy(
        incidentFeedback.targetType,
        incidentFeedback.targetId,
        desc(incidentFeedback.revision),
      )
      .limit(WORKSPACE_FEEDBACK_TARGET_LIMIT);
    return rows.map(toIncidentFeedbackRecord);
  });
}
