// One grade per trusted assessment run: the falsifier behind incidents.confidence. Under RLS.
// The claimed confidence is SNAPSHOT here rather than read back from incidents: a later resume
// overwrites incidents.confidence and moves trusted_assessment_run_id, which would silently
// re-attribute an old grade to a new number and make the calibration curve a lie.
import {
  ASSESSMENT_VERDICTS,
  GROUND_TRUTH_SOURCES,
  type AssessmentVerdict,
  type GroundTruthSource,
} from '@sre/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, tenants } from './control-plane';
import { incidents } from './incidents';
import { investigationRuns } from './investigation-runs';
import { tenantIsolation } from './rls';

const vocabulary = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`);

export const assessmentGrades = pgTable(
  'assessment_grades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    // The run whose rca_summary and ranked hypotheses were graded. Immutable identity for the claim.
    runId: uuid('run_id').notNull(),
    // The confidence the run CLAIMED, snapshot at grade time. Never read live from incidents.
    claimedConfidence: integer('claimed_confidence').notNull(),
    // Did the graded run cite a search_runbooks receipt. Snapshot for the same reason: evidence ids
    // are per run, but the adoption-vs-correctness question must survive re-assessment.
    runbookCited: boolean('runbook_cited').notNull(),
    // The model judge's grade, set only when a published postmortem exists to judge against.
    modelVerdict: text('model_verdict').$type<AssessmentVerdict>(),
    modelRationale: text('model_rationale'),
    groundTruthSource: text('ground_truth_source').$type<GroundTruthSource>(),
    // The human verdict. Authoritative: the read model derives coalesce(human, model), so a human
    // grade wins without destroying the judge's grade. The disagreement rate is how the judge itself
    // gets measured.
    humanVerdict: text('human_verdict').$type<AssessmentVerdict>(),
    humanRationale: text('human_rationale'),
    gradedByUserId: uuid('graded_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'assessment_grades_incident_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.runId],
      foreignColumns: [investigationRuns.tenantId, investigationRuns.id],
      name: 'assessment_grades_run_fk',
    }),
    foreignKey({
      columns: [t.gradedByUserId, t.tenantId],
      foreignColumns: [memberships.userId, memberships.tenantId],
      name: 'assessment_grades_membership_fk',
    }),
    // One grade per assessment. A postmortem landing after a human grade updates model_verdict in
    // place; it never mints a second row, so a run can never be double-counted in the curve.
    uniqueIndex('assessment_grades_run_uq').on(t.tenantId, t.runId),
    index('assessment_grades_calibration_idx').on(t.tenantId, t.claimedConfidence, t.createdAt),
    check(
      'assessment_grades_confidence_range',
      sql`${t.claimedConfidence} >= 0 and ${t.claimedConfidence} <= 100`,
    ),
    check(
      'assessment_grades_model_verdict_vocabulary',
      sql`${t.modelVerdict} is null or ${vocabulary('model_verdict', ASSESSMENT_VERDICTS)}`,
    ),
    check(
      'assessment_grades_human_verdict_vocabulary',
      sql`${t.humanVerdict} is null or ${vocabulary('human_verdict', ASSESSMENT_VERDICTS)}`,
    ),
    check(
      'assessment_grades_ground_truth_vocabulary',
      sql`${t.groundTruthSource} is null or ${vocabulary('ground_truth_source', GROUND_TRUTH_SOURCES)}`,
    ),
    // Ground truth belongs to the judge: it is present exactly when a model verdict is.
    check(
      'assessment_grades_ground_truth_shape',
      sql`(${t.modelVerdict} is null) = (${t.groundTruthSource} is null)`,
    ),
    // A grade with neither verdict is not a grade.
    check(
      'assessment_grades_has_a_verdict',
      sql`${t.modelVerdict} is not null or ${t.humanVerdict} is not null`,
    ),
    // Attribution is who to ask, never causation. A human verdict must be attributed.
    check(
      'assessment_grades_human_attribution',
      sql`(${t.humanVerdict} is null) = (${t.gradedByUserId} is null)`,
    ),
    tenantIsolation(),
  ],
);
