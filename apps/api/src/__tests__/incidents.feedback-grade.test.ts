import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { assessmentGrades, createIncident, incidentFeedback, investigationRuns } from '@sre/db';
import type { InvestigationRunOutcome } from '@sre/contracts';
import { eq } from 'drizzle-orm';
import { createFixture } from './incidents.fixture';

// a finding verdict is an RCA grade. Confirming a finding records humanVerdict 'correct' on the
// run that produced it, in the same transaction as the feedback; a run that never claimed a
// confidence records feedback only, because there is no number to falsify.
const __fixture = createFixture();

async function seedIncidentWithRun(
  result: Record<string, unknown>,
  outcome: InvestigationRunOutcome = 'conclusive',
) {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `feedback-grade-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'checkout',
    severity: 'sev2',
  });
  const runId = randomUUID();
  await __fixture.admin.db.insert(investigationRuns).values({
    id: runId,
    tenantId: __fixture.tenantC,
    incidentId: incident.id,
    operation: 'investigate',
    outcome,
    result,
    completedAt: new Date(),
  });
  await __fixture.hub.append(__fixture.tenantC, incident.id, {
    author: 'agent',
    kind: 'finding',
    content: 'Pool saturation caused the errors.',
    finding: {
      runId,
      outcome,
      promotion: 'trusted_assessment',
      promotionReason: 'conclusive_assessment',
      evidenceIds: [],
      currentState: 'Checkout requests are failing.',
      impact: 'Checkout is degraded.',
      nextStep: 'Inspect connection ownership.',
    },
  });
  return { incidentId: incident.id, runId };
}

async function sendFeedback(incidentId: string, body: unknown): Promise<Response> {
  const auth = __fixture.auth(await __fixture.sign(__fixture.orgC));
  return __fixture.api.request(`/incidents/${incidentId}/feedback`, {
    ...auth,
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('finding feedback as an RCA grade', () => {
  test.each(['failed', 'inconclusive', 'blocked_missing_capability', 'budget_exhausted'] as const)(
    '%s runs are neither advertised for review nor accepted as feedback targets',
    async (outcome) => {
      const { incidentId, runId } = await seedIncidentWithRun(
        { summary: 'No conclusion.', confidence: 0 },
        outcome,
      );
      const auth = __fixture.auth(await __fixture.sign(__fixture.orgC));
      const workspace = await __fixture.api.request(`/incidents/${incidentId}/workspace`, auth);
      expect(workspace.status).toBe(200);
      expect(await workspace.json()).toMatchObject({ feedbackEligibleFindingRunIds: [] });
      for (const decision of ['confirm', 'correct']) {
        const res = await sendFeedback(incidentId, {
          targetType: 'finding',
          targetId: runId,
          decision,
          rationale: 'The request must not grade a status message.',
          replacement: decision === 'correct' ? 'A proposed correction.' : null,
        });
        expect(res.status).toBe(404);
      }
      expect(
        await __fixture.admin.db
          .select()
          .from(incidentFeedback)
          .where(eq(incidentFeedback.incidentId, incidentId)),
      ).toEqual([]);
      expect(
        await __fixture.admin.db
          .select()
          .from(assessmentGrades)
          .where(eq(assessmentGrades.runId, runId)),
      ).toEqual([]);
    },
  );

  test('confirming a finding writes a correct human verdict with the claimed confidence snapshot', async () => {
    const { incidentId, runId } = await seedIncidentWithRun({
      summary: 'Pool saturation caused the errors.',
      confidence: 72,
    });
    const res = await sendFeedback(incidentId, {
      targetType: 'finding',
      targetId: runId,
      decision: 'confirm',
      rationale: 'The trace confirms the pool saturation.',
    });
    expect(res.status).toBe(201);
    const grades = await __fixture.admin.db
      .select()
      .from(assessmentGrades)
      .where(eq(assessmentGrades.runId, runId));
    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({
      tenantId: __fixture.tenantC,
      incidentId,
      claimedConfidence: 72,
      runbookCited: false,
      humanVerdict: 'correct',
      humanRationale: 'The trace confirms the pool saturation.',
      gradedByUserId: __fixture.tenantCUserId,
      modelVerdict: null,
      groundTruthSource: null,
    });
  });

  test('correcting a finding records an incorrect verdict', async () => {
    const { incidentId, runId } = await seedIncidentWithRun({
      summary: 'Wrong cause.',
      confidence: 90,
    });
    const res = await sendFeedback(incidentId, {
      targetType: 'finding',
      targetId: runId,
      decision: 'correct',
      rationale: 'A connection leak, not sizing.',
      replacement: 'A connection leak exhausted the pool.',
    });
    expect(res.status).toBe(201);
    const [grade] = await __fixture.admin.db
      .select({
        verdict: assessmentGrades.humanVerdict,
        claimed: assessmentGrades.claimedConfidence,
      })
      .from(assessmentGrades)
      .where(eq(assessmentGrades.runId, runId));
    expect(grade).toEqual({ verdict: 'incorrect', claimed: 90 });
  });

  test('a run that claimed no confidence records feedback only: 201 and no grade row', async () => {
    const { incidentId, runId } = await seedIncidentWithRun({ summary: 'Reply only.' });
    const res = await sendFeedback(incidentId, {
      targetType: 'finding',
      targetId: runId,
      decision: 'confirm',
      rationale: 'Nothing to falsify here.',
    });
    expect(res.status).toBe(201);
    expect(
      await __fixture.admin.db
        .select({ id: assessmentGrades.id })
        .from(assessmentGrades)
        .where(eq(assessmentGrades.runId, runId)),
    ).toEqual([]);
  });
});
