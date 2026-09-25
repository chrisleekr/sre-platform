import { describe, expect, test } from 'vitest';
import { parseReportRecovery, reportRecoveryTool } from '../report-recovery';

const attemptedEvidenceId = '11111111-1111-4111-8111-111111111111';
const blockingQuestion = {
  question: 'Is the affected service healthy after the rollout?',
  category: 'missing_capability',
  evidenceKind: 'runtime_state',
  attemptedEvidenceIds: [attemptedEvidenceId],
  resolutionRelevance: 'blocking',
  nextAction: 'Restore Kubernetes read access and check the affected deployment readiness.',
};

describe('reportRecoveryTool structured questions', () => {
  const humanReport = {
    outcome: 'needs_human',
    summary: 'Current workload health could not be read.',
    evidence: [],
    evidenceIds: [],
    unknowns: [],
    nextStep: null,
    questions: [blockingQuestion],
  };
  const recoveredReport = {
    outcome: 'recovered',
    summary: 'The affected service is healthy.',
    evidence: [{ name: 'Readiness', before: 'Unavailable', now: 'All replicas ready' }],
    evidenceIds: [attemptedEvidenceId],
    unknowns: [],
    nextStep: null,
    questions: [],
  };

  test('requires questions for model-facing recovery', () => {
    const { questions: _questions, ...withoutQuestions } = recoveredReport;
    expect(reportRecoveryTool.inputSchema.safeParse(withoutQuestions).success).toBe(false);
    expect(reportRecoveryTool.inputSchema.safeParse(recoveredReport).success).toBe(true);
  });

  test('requires an actionable blocker for needs_human', () => {
    expect(reportRecoveryTool.inputSchema.safeParse(humanReport).success).toBe(true);
    for (const questions of [
      [],
      [{ ...blockingQuestion, resolutionRelevance: 'follow_up' }],
      [{ ...blockingQuestion, nextAction: '' }],
      [{ ...blockingQuestion, nextAction: null }],
      [{ ...blockingQuestion, category: 'unknown' }],
    ]) {
      expect(reportRecoveryTool.inputSchema.safeParse({ ...humanReport, questions }).success).toBe(
        false,
      );
    }
  });

  test('rejects blockers on recovered while preserving follow-up work', () => {
    expect(
      reportRecoveryTool.inputSchema.safeParse({
        ...recoveredReport,
        questions: [blockingQuestion],
      }).success,
    ).toBe(false);
    const followUp = {
      ...blockingQuestion,
      question: 'What caused the original transient failure?',
      category: 'historical_gap',
      resolutionRelevance: 'follow_up',
      nextAction: 'Review retained deployment events for recurrence prevention.',
    };
    expect(parseReportRecovery({ ...recoveredReport, questions: [followUp] })).toMatchObject({
      outcome: 'recovered',
      questions: [followUp],
      unknowns: [followUp.question],
    });
  });

  test('validates attempted evidence references without treating attempts as health proof', () => {
    expect(reportRecoveryTool.inputSchema.safeParse(humanReport).success).toBe(true);
    expect(
      reportRecoveryTool.inputSchema.safeParse({
        ...humanReport,
        questions: [{ ...blockingQuestion, attemptedEvidenceIds: [] }],
      }).success,
    ).toBe(true);
    expect(
      reportRecoveryTool.inputSchema.safeParse({
        ...humanReport,
        questions: [{ ...blockingQuestion, attemptedEvidenceIds: ['invented receipt'] }],
      }).success,
    ).toBe(false);
    expect(
      reportRecoveryTool.inputSchema.safeParse({
        ...humanReport,
        outcome: 'recovered',
        questions: [{ ...blockingQuestion, resolutionRelevance: 'follow_up' }],
      }).success,
    ).toBe(false);
  });
});

describe('parseReportRecovery', () => {
  test('preserves absent legacy questions as unclassified', () => {
    const report = parseReportRecovery({
      recovered: false,
      summary: 'Health could not be verified by the previous worker.',
      unknowns: ['Current health is unknown.'],
      nextStep: null,
    });
    expect(report).toMatchObject({
      outcome: 'needs_human',
      summary: 'Health could not be verified by the previous worker.',
      unknowns: ['Current health is unknown.'],
      nextStep: null,
    });
    expect(report).not.toHaveProperty('questions');
  });

  test('rejects malformed provided questions rather than falling back to the legacy decoder', () => {
    for (const questions of [
      null,
      'Current health is unknown.',
      [{ ...blockingQuestion, nextAction: '' }],
      [{ ...blockingQuestion, attemptedEvidenceIds: ['invented receipt'] }],
    ]) {
      expect(
        parseReportRecovery({
          outcome: 'needs_human',
          summary: 'This malformed report must not be accepted.',
          unknowns: ['A legacy question must not bypass the structured contract.'],
          questions,
        }),
      ).toMatchObject({
        outcome: 'needs_human',
        recovered: false,
        summary: 'Recovery could not be verified.',
        unknowns: ['The engine did not produce a valid recovery report.'],
      });
    }
  });

  test('accepts verified recovery only with stated current evidence', () => {
    expect(
      parseReportRecovery({
        recovered: true,
        summary: 'Error rate returned to baseline.',
        evidence: [
          {
            name: 'Five-minute error rate',
            before: 'Above alert threshold',
            now: 'Below alert threshold',
          },
        ],
        evidenceIds: ['11111111-1111-4111-8111-111111111111'],
        unknowns: [],
        nextStep: null,
      }),
    ).toMatchObject({ recovered: true });

    expect(
      parseReportRecovery({
        recovered: true,
        summary: 'Looks fine but is not cited.',
        evidence: [{ name: 'Readiness', before: 'Failing', now: 'Green' }],
        evidenceIds: [],
        unknowns: [],
        nextStep: null,
      }),
    ).toMatchObject({ recovered: false });

    expect(
      parseReportRecovery({
        recovered: true,
        summary: 'Looks fine.',
        evidence: [],
        unknowns: [],
        nextStep: null,
      }),
    ).toMatchObject({
      recovered: false,
      unknowns: ['The engine did not produce a valid recovery report.'],
    });
  });

  test('enforces concise durable recovery fields', () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    expect(
      parseReportRecovery({
        recovered: true,
        summary: 's'.repeat(240),
        evidence: Array.from({ length: 8 }, () => ({
          name: 'n'.repeat(80),
          before: 'b'.repeat(120),
          now: 'c'.repeat(120),
        })),
        evidenceIds: Array.from({ length: 8 }, () => evidenceId),
        unknowns: Array.from({ length: 6 }, () => 'u'.repeat(240)),
        nextStep: 'n'.repeat(280),
      }),
    ).toMatchObject({ recovered: true });

    for (const overLimit of [
      { summary: 's'.repeat(241) },
      { summary: 'healthy\nbut verbose' },
      { evidence: [{ name: 'n'.repeat(81), before: null, now: 'healthy' }] },
      { evidence: [{ name: 'health', before: null, now: 'n'.repeat(121) }] },
      {
        evidence: Array.from({ length: 9 }, () => ({
          name: 'health',
          before: null,
          now: 'healthy',
        })),
      },
      { unknowns: ['u'.repeat(241)] },
      { unknowns: Array.from({ length: 7 }, () => 'u') },
      { nextStep: 'n'.repeat(281) },
    ]) {
      expect(
        parseReportRecovery({
          recovered: true,
          summary: 'healthy',
          evidence: [{ name: 'Health', before: 'Alerting', now: 'Healthy' }],
          evidenceIds: [evidenceId],
          unknowns: [],
          nextStep: null,
          ...overLimit,
        }),
      ).toMatchObject({ recovered: false, summary: 'Recovery could not be verified.' });
    }
  });

  test('accepts a cited model-selected recheck and rejects unbounded or unexplained schedules', () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    const base = {
      outcome: 'recheck' as const,
      summary: 'Latency is falling while the rollout converges.',
      evidence: [{ name: 'Latency', before: '2.1s', now: '800ms' }],
      evidenceIds: [evidenceId],
      unknowns: [],
      nextStep: 'Check again after the rollout settles.',
      recheckAfterMinutes: 5,
      scheduleReason: 'The rollout is still converging.',
    };
    expect(parseReportRecovery(base)).toMatchObject({
      outcome: 'recheck',
      recovered: false,
      recheckAfterMinutes: 5,
    });
    for (const invalid of [
      { ...base, evidenceIds: [] },
      { ...base, recheckAfterMinutes: 0 },
      { ...base, recheckAfterMinutes: 61 },
      { ...base, scheduleReason: null },
      { ...base, outcome: 'recovered', recheckAfterMinutes: 5 },
    ]) {
      expect(parseReportRecovery(invalid)).toMatchObject({
        outcome: 'needs_human',
        recovered: false,
        summary: 'Recovery could not be verified.',
      });
    }
  });
});
