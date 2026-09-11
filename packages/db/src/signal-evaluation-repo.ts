import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  SEMANTIC_DISPOSITION_CONTRACT_VERSION,
  SIGNAL_DISPOSITION_CORPUS_SIZE,
  SIGNAL_DISPOSITION_CORPUS_VERSION,
} from '@sre/contracts';
import type { Db } from './client';
import { withTenant, type Tx } from './rls';
import { signalDispositionEvaluations, tenantSignalPolicies } from './schema';

export interface SignalEvaluationScore {
  total: number;
  correct: number;
  criticalSafetyMisses: number;
  classMetrics: Record<string, unknown>;
  scenarioResults: unknown[];
}

export interface EvaluationJobInput {
  tenantId: string;
  type: 'signal.disposition.evaluate';
  payload: { evaluationId: string };
}

export type InsertEvaluationJobTx = (tx: Tx, input: EvaluationJobInput) => Promise<string>;

/**
 * Creates one queued evaluation or returns the tenant's active evaluation.
 * @param db - Tenant-scoped database.
 * @param tenantId - Tenant that owns the evaluation.
 * @param input - Requester and runtime identity for the evaluation.
 */
export function requestSignalDispositionEvaluation(
  db: Db,
  tenantId: string,
  input: {
    requestedByUserId: string;
    runtimeFingerprint: string;
    insertJobTx: InsertEvaluationJobTx;
  },
) {
  return withTenant(db, tenantId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`signal-evaluation:${tenantId}`}, 0))`,
    );
    await tx
      .update(signalDispositionEvaluations)
      .set({
        status: 'failed',
        failureCategory: 'worker_interrupted',
        completedAt: sql`now()`,
      })
      .where(
        and(
          eq(signalDispositionEvaluations.status, 'running'),
          sql`${signalDispositionEvaluations.startedAt} < now() - interval '1 hour'`,
        ),
      );
    await tx
      .insert(tenantSignalPolicies)
      .values({ tenantId, classificationMode: 'shadow' })
      .onConflictDoUpdate({
        target: tenantSignalPolicies.tenantId,
        set: { classificationMode: 'shadow', updatedAt: sql`now()` },
      });
    const active = await tx
      .select()
      .from(signalDispositionEvaluations)
      .where(inArray(signalDispositionEvaluations.status, ['queued', 'running']))
      .orderBy(desc(signalDispositionEvaluations.createdAt))
      .limit(1);
    if (active[0]) return { evaluation: active[0], inserted: false };
    const evaluationId = randomUUID();
    const jobId = await input.insertJobTx(tx, {
      tenantId,
      type: 'signal.disposition.evaluate',
      payload: { evaluationId },
    });
    const rows = await tx
      .insert(signalDispositionEvaluations)
      .values({
        id: evaluationId,
        tenantId,
        jobId,
        requestedByUserId: input.requestedByUserId,
        runtimeFingerprint: input.runtimeFingerprint,
        corpusVersion: SIGNAL_DISPOSITION_CORPUS_VERSION,
        contractVersion: SEMANTIC_DISPOSITION_CONTRACT_VERSION,
      })
      .returning();
    return { evaluation: rows[0]!, inserted: true };
  });
}

/**
 * Returns the newest evaluation for the tenant.
 * @param db - Tenant-scoped database.
 * @param tenantId - Tenant whose evaluation is requested.
 */
export function latestSignalDispositionEvaluation(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(signalDispositionEvaluations)
      .orderBy(desc(signalDispositionEvaluations.createdAt), desc(signalDispositionEvaluations.id))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Claims a queued evaluation or resumes the same durable job after redelivery.
 * @param db - Tenant-scoped database.
 * @param tenantId - Tenant that owns the evaluation.
 * @param evaluationId - Evaluation to claim.
 * @param jobId - Durable job allowed to claim or resume the evaluation.
 */
export function claimSignalDispositionEvaluation(
  db: Db,
  tenantId: string,
  evaluationId: string,
  jobId: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(signalDispositionEvaluations)
      .set({ status: 'running', startedAt: sql`now()` })
      .where(
        and(
          eq(signalDispositionEvaluations.id, evaluationId),
          eq(signalDispositionEvaluations.jobId, jobId),
          inArray(signalDispositionEvaluations.status, ['queued', 'running']),
        ),
      )
      .returning();
    return rows[0] ?? null;
  });
}

/**
 * Persists the aggregate score without retaining model output.
 * @param db - Tenant-scoped database.
 * @param tenantId - Tenant that owns the evaluation.
 * @param evaluationId - Running evaluation to complete.
 * @param score - Aggregate corpus accuracy and safety metrics.
 */
export function completeSignalDispositionEvaluation(
  db: Db,
  tenantId: string,
  evaluationId: string,
  score: SignalEvaluationScore,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(signalDispositionEvaluations)
      .set({
        status: 'completed',
        total: score.total,
        correct: score.correct,
        criticalSafetyMisses: score.criticalSafetyMisses,
        classMetrics: score.classMetrics,
        scenarioResults: score.scenarioResults,
        completedAt: sql`now()`,
      })
      .where(
        and(
          eq(signalDispositionEvaluations.id, evaluationId),
          eq(signalDispositionEvaluations.status, 'running'),
        ),
      )
      .returning();
    return rows[0] ?? null;
  });
}

/**
 * Marks a claimed evaluation failed with a bounded category only.
 * @param db - Tenant-scoped database.
 * @param tenantId - Tenant that owns the evaluation.
 * @param evaluationId - Queued or running evaluation to fail.
 * @param failureCategory - Bounded operational failure category.
 */
export function failSignalDispositionEvaluation(
  db: Db,
  tenantId: string,
  evaluationId: string,
  failureCategory: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(signalDispositionEvaluations)
      .set({
        status: 'failed',
        failureCategory: failureCategory.trim().slice(0, 100) || 'evaluation_failed',
        completedAt: sql`now()`,
      })
      .where(
        and(
          eq(signalDispositionEvaluations.id, evaluationId),
          inArray(signalDispositionEvaluations.status, ['queued', 'running']),
        ),
      )
      .returning();
    return rows[0] ?? null;
  });
}

/**
 * Approves enforcement only from a current zero-critical-miss evaluation.
 * @param db - Tenant-scoped database.
 * @param tenantId - Tenant whose classifier is being approved.
 * @param input - Evaluation, approver, and current runtime identity.
 */
export function approveSignalDispositionEnforcement(
  db: Db,
  tenantId: string,
  input: {
    evaluationId: string;
    userId: string;
    runtimeFingerprint: string;
    reviewedTicketScenarioIds: string[];
  },
) {
  return withTenant(db, tenantId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`signal-evaluation:${tenantId}`}, 0))`,
    );
    const newestRows = await tx
      .select({ id: signalDispositionEvaluations.id })
      .from(signalDispositionEvaluations)
      .orderBy(desc(signalDispositionEvaluations.createdAt), desc(signalDispositionEvaluations.id))
      .limit(1)
      .for('update');
    if (newestRows[0]?.id !== input.evaluationId) {
      throw new Error('enforcement requires the newest evaluation');
    }
    const evaluations = await tx
      .select()
      .from(signalDispositionEvaluations)
      .where(eq(signalDispositionEvaluations.id, input.evaluationId))
      .limit(1)
      .for('update');
    const evaluation = evaluations[0];
    const scenarioResults = Array.isArray(evaluation?.scenarioResults)
      ? (evaluation.scenarioResults as Array<{ id?: unknown; expected?: unknown }>)
      : [];
    const scenarioIds = scenarioResults
      .map((result) => result.id)
      .filter((id): id is string => typeof id === 'string');
    const expectedTicketIds = scenarioResults
      .filter((result) => result.expected === 'ticket' && typeof result.id === 'string')
      .map((result) => result.id as string);
    const reviewedTicketIds = new Set(input.reviewedTicketScenarioIds);
    if (
      !evaluation ||
      evaluation.status !== 'completed' ||
      evaluation.criticalSafetyMisses !== 0 ||
      evaluation.total !== SIGNAL_DISPOSITION_CORPUS_SIZE ||
      evaluation.correct !== evaluation.total ||
      evaluation.corpusVersion !== SIGNAL_DISPOSITION_CORPUS_VERSION ||
      evaluation.contractVersion !== SEMANTIC_DISPOSITION_CONTRACT_VERSION ||
      evaluation.runtimeFingerprint !== input.runtimeFingerprint
    ) {
      throw new Error(
        'enforcement requires perfect current-corpus accuracy and zero safety misses',
      );
    }
    if (
      scenarioResults.length !== SIGNAL_DISPOSITION_CORPUS_SIZE ||
      scenarioIds.length !== SIGNAL_DISPOSITION_CORPUS_SIZE ||
      new Set(scenarioIds).size !== SIGNAL_DISPOSITION_CORPUS_SIZE
    ) {
      throw new Error('enforcement requires every reviewed scenario result');
    }
    if (
      expectedTicketIds.length === 0 ||
      reviewedTicketIds.size !== expectedTicketIds.length ||
      expectedTicketIds.some((id) => !reviewedTicketIds.has(id))
    ) {
      throw new Error('enforcement requires explicit review of every ticket scenario');
    }
    await tx
      .update(signalDispositionEvaluations)
      .set({
        ticketSemanticsReviewedAt: sql`now()`,
        ticketSemanticsReviewedByUserId: input.userId,
      })
      .where(eq(signalDispositionEvaluations.id, evaluation.id));
    const rows = await tx
      .insert(tenantSignalPolicies)
      .values({
        tenantId,
        classificationMode: 'enforce',
        enforcementApprovedAt: new Date(),
        enforcementApprovedByUserId: input.userId,
        approvedEvaluationId: evaluation.id,
        approvedCorpusVersion: evaluation.corpusVersion,
        approvedContractVersion: evaluation.contractVersion,
        approvedRuntimeFingerprint: evaluation.runtimeFingerprint,
      })
      .onConflictDoUpdate({
        target: tenantSignalPolicies.tenantId,
        set: {
          classificationMode: 'enforce',
          enforcementApprovedAt: sql`now()`,
          enforcementApprovedByUserId: input.userId,
          approvedEvaluationId: evaluation.id,
          approvedCorpusVersion: evaluation.corpusVersion,
          approvedContractVersion: evaluation.contractVersion,
          approvedRuntimeFingerprint: evaluation.runtimeFingerprint,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return rows[0]!;
  });
}

/**
 * Returns a tenant to shadow mode while preserving the last approval audit.
 * @param db - Tenant-scoped database.
 * @param tenantId - Tenant whose classifier returns to shadow mode.
 */
export function returnSignalDispositionToShadow(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(tenantSignalPolicies)
      .values({ tenantId, classificationMode: 'shadow' })
      .onConflictDoUpdate({
        target: tenantSignalPolicies.tenantId,
        set: { classificationMode: 'shadow', updatedAt: sql`now()` },
      })
      .returning();
    return rows[0]!;
  });
}

/**
 * Computes the fail-closed effective mode for the current runtime contract.
 * @param policy - Persisted classifier policy and approval binding.
 * @param runtimeFingerprint - Current secret-free runtime identity.
 */
export function effectiveSignalClassificationMode(
  policy: {
    classificationMode?: string;
    approvedCorpusVersion?: string | null;
    approvedContractVersion?: string | null;
    approvedRuntimeFingerprint?: string | null;
  },
  runtimeFingerprint: string,
): 'shadow' | 'enforce' {
  return policy.classificationMode === 'enforce' &&
    policy.approvedCorpusVersion === SIGNAL_DISPOSITION_CORPUS_VERSION &&
    policy.approvedContractVersion === SEMANTIC_DISPOSITION_CONTRACT_VERSION &&
    policy.approvedRuntimeFingerprint === runtimeFingerprint
    ? 'enforce'
    : 'shadow';
}
