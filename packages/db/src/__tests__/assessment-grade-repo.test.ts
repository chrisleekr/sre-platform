import { seedMembership } from '../test-support';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  assessmentGrades,
  createIncident,
  getAssessmentGradeForRun,
  incidents,
  makeDb,
  memberships,
  readRcaCalibration,
  tenants,
  upsertHumanAssessmentGradeTx,
  upsertModelAssessmentGradeTx,
  users,
  withTenant,
  type DbHandle,
} from '../index';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;
let incidentA: string;
let incidentB: string;
let runA: string;
let runB: string;
let runNoConfidence: string;

async function seedRun(
  tenantId: string,
  incidentId: string,
  result: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await admin.db.execute(sql`
    insert into investigation_runs (id, tenant_id, incident_id, operation, outcome, result, completed_at)
    values (${id}, ${tenantId}, ${incidentId}, 'investigate', 'conclusive',
            ${JSON.stringify(result)}::jsonb, now())
  `);
  return id;
}

async function expectConstraint(operation: Promise<unknown>, name: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
    expect(String(cause)).toContain(name);
    return;
  }
  throw new Error(`operation unexpectedly succeeded without ${name}`);
}

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'Grade tenant A' },
    { id: tenantB, name: 'Grade tenant B' },
  ]);
  userA = await seedMembership(admin.db, { issuer: 'grade-test', subject: randomUUID() }, tenantA);
  userB = await seedMembership(admin.db, { issuer: 'grade-test', subject: randomUUID() }, tenantB);
  const seed = (tenantId: string) =>
    createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'test',
      service: 'checkout',
      severity: 'sev2',
    });
  incidentA = (await seed(tenantA)).id;
  incidentB = (await seed(tenantB)).id;
  runA = await seedRun(tenantA, incidentA, { summary: 'pool exhausted', confidence: 85 });
  runB = await seedRun(tenantB, incidentB, { summary: 'other tenant', confidence: 60 });
  runNoConfidence = await seedRun(tenantA, incidentA, { summary: 'reply only' });
  await admin.db
    .update(incidents)
    .set({ confidence: 85, trustedAssessmentRunId: runA })
    .where(eq(incidents.id, incidentA));
});

afterAll(async () => {
  await admin.db
    .delete(assessmentGrades)
    .where(inArray(assessmentGrades.tenantId, [tenantA, tenantB]));
  await admin.db
    .update(incidents)
    .set({ trustedAssessmentRunId: null })
    .where(inArray(incidents.tenantId, [tenantA, tenantB]));
  await admin.db.execute(
    sql`delete from investigation_runs where tenant_id in (${tenantA}, ${tenantB})`,
  );
  await admin.db.delete(incidents).where(inArray(incidents.tenantId, [tenantA, tenantB]));
  await admin.db.delete(memberships).where(inArray(memberships.tenantId, [tenantA, tenantB]));
  await admin.db.delete(users).where(inArray(users.id, [userA, userB]));
  await admin.db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  await admin.close();
  await app.close();
});

describe('assessment grade repo', () => {
  test('a human grade snapshots the claim and a revision leaves the snapshot and model verdict alone', async () => {
    expect(
      await withTenant(app.db, tenantA, (tx) =>
        upsertHumanAssessmentGradeTx(tx, tenantA, {
          incidentId: incidentA,
          runId: runA,
          verdict: 'incorrect',
          rationale: 'The pool was a symptom.',
          gradedByUserId: userA,
        }),
      ),
    ).toBe(true);
    expect(
      await withTenant(app.db, tenantA, (tx) =>
        upsertModelAssessmentGradeTx(tx, tenantA, {
          incidentId: incidentA,
          runId: runA,
          verdict: 'correct',
          rationale: 'Matches the postmortem cause.',
        }),
      ),
    ).toBe(true);
    // A later resume rewrites the incident's live confidence; the grade keeps the claim it scored.
    await admin.db
      .update(incidents)
      .set({ confidence: 20, trustedAssessmentRunId: runNoConfidence })
      .where(eq(incidents.id, incidentA));
    await withTenant(app.db, tenantA, (tx) =>
      upsertHumanAssessmentGradeTx(tx, tenantA, {
        incidentId: incidentA,
        runId: runA,
        verdict: 'partial',
        rationale: 'On reflection, half right.',
        gradedByUserId: userA,
      }),
    );
    const grade = await getAssessmentGradeForRun(app.db, tenantA, runA);
    expect(grade).toMatchObject({
      claimedConfidence: 85,
      runbookCited: false,
      modelVerdict: 'correct',
      groundTruthSource: 'postmortem',
      humanVerdict: 'partial',
      effectiveVerdict: 'partial',
      gradedByUserId: userA,
    });
    expect(grade).not.toHaveProperty('tenantId');
    // One grade per run: both writers landed on the same row.
    expect(
      await admin.db.select().from(assessmentGrades).where(eq(assessmentGrades.runId, runA)),
    ).toHaveLength(1);
  });

  test('a run that claimed no confidence records no grade', async () => {
    expect(
      await withTenant(app.db, tenantA, (tx) =>
        upsertHumanAssessmentGradeTx(tx, tenantA, {
          incidentId: incidentA,
          runId: runNoConfidence,
          verdict: 'correct',
          rationale: 'Nothing to falsify.',
          gradedByUserId: userA,
        }),
      ),
    ).toBe(false);
    expect(await getAssessmentGradeForRun(app.db, tenantA, runNoConfidence)).toBeNull();
  });

  test('tenant isolation: foreign runs, foreign members and foreign reads are all refused', async () => {
    expect(await getAssessmentGradeForRun(app.db, tenantB, runA)).toBeNull();
    // A tenant-B run is invisible under tenant A's RLS, so the snapshot query finds nothing.
    expect(
      await withTenant(app.db, tenantA, (tx) =>
        upsertHumanAssessmentGradeTx(tx, tenantA, {
          incidentId: incidentB,
          runId: runB,
          verdict: 'correct',
          rationale: 'Cross-tenant attempt.',
          gradedByUserId: userA,
        }),
      ),
    ).toBe(false);
    // Bypassing the repo, the composite FKs still refuse a foreign run and a foreign member.
    await expectConstraint(
      admin.db.insert(assessmentGrades).values({
        tenantId: tenantA,
        incidentId: incidentA,
        runId: runB,
        claimedConfidence: 60,
        runbookCited: false,
        humanVerdict: 'correct',
        humanRationale: 'foreign run',
        gradedByUserId: userA,
      }),
      'assessment_grades_run_fk',
    );
    await expectConstraint(
      admin.db.insert(assessmentGrades).values({
        tenantId: tenantA,
        incidentId: incidentA,
        runId: runNoConfidence,
        claimedConfidence: 60,
        runbookCited: false,
        humanVerdict: 'correct',
        humanRationale: 'foreign member',
        gradedByUserId: userB,
      }),
      'assessment_grades_membership_fk',
    );
    await expectConstraint(
      admin.db.insert(assessmentGrades).values({
        tenantId: tenantA,
        incidentId: incidentA,
        runId: runNoConfidence,
        claimedConfidence: 60,
        runbookCited: false,
      }),
      'assessment_grades_has_a_verdict',
    );
  });

  test('calibration reports null accuracy below the floor and an insufficient_data verdict', async () => {
    const report = await readRcaCalibration(app.db, tenantA);
    expect(report.floor).toBe(10);
    expect(report.overall).toMatchObject({ graded: 1, partial: 1, accuracy: null });
    expect(report.coverage).toMatchObject({
      assessmentsWithConfidence: 1,
      graded: 1,
      gradedRate: 1,
    });
    expect(
      report.byConfidenceBucket.map((b) => [b.lower, b.upper, b.graded, b.observedAccuracy]),
    ).toEqual([
      [0, 50, 0, null],
      [50, 80, 0, null],
      [80, 101, 1, null],
    ]);
    expect(report.byConfidenceBucket[2]?.claimedMean).toBe(85);
    expect(report.runbookAdoption.uncited).toEqual({ graded: 1, accuracy: null });
    expect(report.judgeAgreement).toEqual({ bothGraded: 1, agreed: 0, rate: 0 });
    expect(report.verdict).toBe('insufficient_data');
    // Tenant B's curve never sees tenant A's grade.
    expect((await readRcaCalibration(app.db, tenantB)).overall.graded).toBe(0);
  });
});
