import { describe, expect, test } from 'vitest';
import { parseReportRecovery } from '../report-recovery';

describe('parseReportRecovery', () => {
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
