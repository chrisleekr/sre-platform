import {
  CONFIDENCE_BUCKETS,
  RCA_CALIBRATION_FLOOR,
  type AssessmentGrade,
  type AssessmentVerdict,
  type CalibrationVerdict,
  type ConfidenceBucketReport,
  type RcaCalibrationReport,
} from '@sre/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { runbookCitedPredicate } from './reliability-predicates';
import { withTenant, type Tx } from './rls';
import { assessmentGrades, investigationRuns } from './schema';

// Accuracy gap between the highest and lowest confidence bucket that makes the score informative.
const INFORMATIVE_MARGIN = 0.15;

export type GradedRunSnapshot = {
  incidentId: string;
  confidence: number;
  runbookCited: boolean;
};

export interface ModelGradeInput {
  incidentId: string;
  runId: string;
  verdict: AssessmentVerdict;
  rationale: string;
}

export interface HumanGradeInput extends ModelGradeInput {
  gradedByUserId: string;
}

/**
 * Returns one investigation run of the tenant, or null. Used by the postmortem consumers to read the
 * pinned assessment's claim.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the run.
 * @param runId - Investigation run identifier.
 */
export async function getInvestigationRunById(db: Db, tenantId: string, runId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: investigationRuns.id,
        incidentId: investigationRuns.incidentId,
        outcome: investigationRuns.outcome,
        result: investigationRuns.result,
        evidenceIds: investigationRuns.evidenceIds,
        completedAt: investigationRuns.completedAt,
      })
      .from(investigationRuns)
      .where(eq(investigationRuns.id, runId))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * The claim a grade is about: the run's confidence and whether it cited a runbook. A run with no
 * confidence never produced a claim, so there is nothing to falsify and the result is null.
 */
async function gradedRunSnapshotTx(
  tx: Tx,
  incidentId: string,
  runId: string,
): Promise<GradedRunSnapshot | null> {
  const rows = await tx.execute<GradedRunSnapshot>(sql`
    select runs.incident_id as "incidentId",
           (runs.result->>'confidence')::int as "confidence",
           ${runbookCitedPredicate('runs')} as "runbookCited"
    from investigation_runs runs
    where runs.id = ${runId} and runs.incident_id = ${incidentId}
      and (runs.result->>'confidence') is not null
  `);
  return rows[0] ?? null;
}

const effectiveVerdict = (row: {
  humanVerdict: AssessmentVerdict | null;
  modelVerdict: AssessmentVerdict | null;
}): AssessmentVerdict => {
  const verdict = row.humanVerdict ?? row.modelVerdict;
  if (!verdict) throw new Error('assessment grade without a verdict');
  return verdict;
};

function toAssessmentGrade(row: typeof assessmentGrades.$inferSelect): AssessmentGrade {
  return {
    id: row.id,
    incidentId: row.incidentId,
    runId: row.runId,
    claimedConfidence: row.claimedConfidence,
    runbookCited: row.runbookCited,
    modelVerdict: row.modelVerdict ?? null,
    modelRationale: row.modelRationale ?? null,
    groundTruthSource: row.groundTruthSource ?? null,
    humanVerdict: row.humanVerdict ?? null,
    humanRationale: row.humanRationale ?? null,
    gradedByUserId: row.gradedByUserId ?? null,
    effectiveVerdict: effectiveVerdict(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Verdict columns are the only ones written on conflict: the snapshot columns are never re-attributed
// and the other side's verdict is never erased.
async function upsertGradeTx(
  tx: Tx,
  tenantId: string,
  input: Pick<ModelGradeInput, 'incidentId' | 'runId'>,
  verdictColumns: Partial<typeof assessmentGrades.$inferInsert>,
): Promise<boolean> {
  const snapshot = await gradedRunSnapshotTx(tx, input.incidentId, input.runId);
  if (!snapshot) return false;
  await tx
    .insert(assessmentGrades)
    .values({
      tenantId,
      incidentId: input.incidentId,
      runId: input.runId,
      claimedConfidence: snapshot.confidence,
      runbookCited: snapshot.runbookCited,
      ...verdictColumns,
    })
    .onConflictDoUpdate({
      target: [assessmentGrades.tenantId, assessmentGrades.runId],
      set: { ...verdictColumns, updatedAt: sql`now()` },
    });
  return true;
}

/**
 * Records or replaces the model judge's grade for one assessment run.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the incident and run.
 * @param input - Graded run, verdict and the judge's rationale.
 */
export function upsertModelAssessmentGradeTx(
  tx: Tx,
  tenantId: string,
  input: ModelGradeInput,
): Promise<boolean> {
  return upsertGradeTx(tx, tenantId, input, {
    modelVerdict: input.verdict,
    modelRationale: input.rationale,
    groundTruthSource: 'postmortem',
  });
}

// Records nothing when the run carried no confidence, because the feedback that triggered it must
// still succeed.
/**
 * Records or replaces the authoritative human grade for one assessment run.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the incident and run.
 * @param input - Graded run, verdict, rationale and attributed responder.
 */
export function upsertHumanAssessmentGradeTx(
  tx: Tx,
  tenantId: string,
  input: HumanGradeInput,
): Promise<boolean> {
  return upsertGradeTx(tx, tenantId, input, {
    humanVerdict: input.verdict,
    humanRationale: input.rationale,
    gradedByUserId: input.gradedByUserId,
  });
}

/**
 * Reads the grade of one assessment run inside an existing tenant transaction.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param runId - Graded investigation run.
 */
export async function getAssessmentGradeForRunTx(
  tx: Tx,
  runId: string,
): Promise<AssessmentGrade | null> {
  const rows = await tx
    .select()
    .from(assessmentGrades)
    .where(eq(assessmentGrades.runId, runId))
    .limit(1);
  return rows[0] ? toAssessmentGrade(rows[0]) : null;
}

/**
 * Reads the grade of one assessment run under tenant RLS.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the run.
 * @param runId - Graded investigation run.
 */
export function getAssessmentGradeForRun(db: Db, tenantId: string, runId: string) {
  return withTenant(db, tenantId, (tx) => getAssessmentGradeForRunTx(tx, runId));
}

type CohortRow = {
  graded: number;
  correct: number;
  partial: number;
  incorrect: number;
  claimedMean: number | null;
};

const accuracyOf = (row: CohortRow): number | null =>
  row.graded >= RCA_CALIBRATION_FLOOR ? row.correct / row.graded : null;

/** Cohort counts on the effective verdict, `coalesce(human, model)`, over an optional predicate. */
async function cohortTx(tx: Tx, predicate: ReturnType<typeof sql>): Promise<CohortRow> {
  const rows = await tx.execute<CohortRow>(sql`
    with graded as (
      select coalesce(human_verdict, model_verdict) as verdict, claimed_confidence, runbook_cited
      from assessment_grades
    )
    select count(*)::int as "graded",
           count(*) filter (where verdict = 'correct')::int as "correct",
           count(*) filter (where verdict = 'partial')::int as "partial",
           count(*) filter (where verdict = 'incorrect')::int as "incorrect",
           avg(claimed_confidence)::float as "claimedMean"
    from graded where ${predicate}
  `);
  return rows[0] ?? { graded: 0, correct: 0, partial: 0, incorrect: 0, claimedMean: null };
}

function calibrationVerdict(buckets: ConfidenceBucketReport[]): CalibrationVerdict {
  const lowest = buckets[0];
  const highest = buckets[buckets.length - 1];
  if (!lowest || !highest || lowest.observedAccuracy === null || highest.observedAccuracy === null)
    return 'insufficient_data';
  return highest.observedAccuracy - lowest.observedAccuracy >= INFORMATIVE_MARGIN
    ? 'informative'
    : 'uninformative';
}

// Accuracy is null below the reporting floor, never a rounded number over a handful of samples, and
// nothing here rescales a confidence; calibration is measured, never applied.
/**
 * Reads the RCA calibration for one tenant: does a claimed confidence predict being right.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose grades are read; never pooled across tenants.
 */
export async function readRcaCalibration(db: Db, tenantId: string): Promise<RcaCalibrationReport> {
  return withTenant(db, tenantId, async (tx) => {
    const overall = await cohortTx(tx, sql`true`);
    const byConfidenceBucket: ConfidenceBucketReport[] = [];
    for (const bucket of CONFIDENCE_BUCKETS) {
      const row = await cohortTx(
        tx,
        sql`claimed_confidence >= ${bucket.lower} and claimed_confidence < ${bucket.upper}`,
      );
      byConfidenceBucket.push({
        lower: bucket.lower,
        upper: bucket.upper,
        graded: row.graded,
        observedAccuracy: accuracyOf(row),
        claimedMean: row.graded > 0 ? row.claimedMean : null,
      });
    }
    const cited = await cohortTx(tx, sql`runbook_cited`);
    const uncited = await cohortTx(tx, sql`not runbook_cited`);
    const coverage = (
      await tx.execute<{ assessmentsWithConfidence: number }>(sql`
        select count(*)::int as "assessmentsWithConfidence"
        from investigation_runs runs
        where runs.completed_at is not null and (runs.result->>'confidence') is not null
      `)
    )[0] ?? { assessmentsWithConfidence: 0 };
    const agreement = (
      await tx.execute<{ bothGraded: number; agreed: number }>(sql`
        select count(*)::int as "bothGraded",
               count(*) filter (where human_verdict = model_verdict)::int as "agreed"
        from assessment_grades
        where human_verdict is not null and model_verdict is not null
      `)
    )[0] ?? { bothGraded: 0, agreed: 0 };
    return {
      floor: RCA_CALIBRATION_FLOOR,
      coverage: {
        assessmentsWithConfidence: coverage.assessmentsWithConfidence,
        graded: overall.graded,
        gradedRate:
          coverage.assessmentsWithConfidence > 0
            ? overall.graded / coverage.assessmentsWithConfidence
            : null,
      },
      overall: {
        graded: overall.graded,
        correct: overall.correct,
        partial: overall.partial,
        incorrect: overall.incorrect,
        accuracy: accuracyOf(overall),
      },
      byConfidenceBucket,
      runbookAdoption: {
        cited: { graded: cited.graded, accuracy: accuracyOf(cited) },
        uncited: { graded: uncited.graded, accuracy: accuracyOf(uncited) },
      },
      judgeAgreement: {
        bothGraded: agreement.bothGraded,
        agreed: agreement.agreed,
        rate: agreement.bothGraded > 0 ? agreement.agreed / agreement.bothGraded : null,
      },
      verdict: calibrationVerdict(byConfidenceBucket),
      definitions: [
        'A grade scores one trusted assessment run against ground truth; a human verdict overrides the model judge.',
        'Accuracy is the share of graded runs whose effective verdict is correct; partial counts as not correct.',
        `Accuracy is reported only from ${RCA_CALIBRATION_FLOOR} graded runs; below that the rate is null, never a rounded number.`,
        'Runbook adoption means a cited search_runbooks evidence receipt in the graded run.',
        'Calibration is measured, never applied; no confidence value is rescaled from this view.',
      ],
    };
  });
}
