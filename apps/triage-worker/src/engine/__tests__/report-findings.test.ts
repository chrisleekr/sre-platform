import { describe, expect, test } from 'vitest';
import { REPORT_FINDINGS_NAME, reportFindingsTool, parseReportFindings } from '../report-findings';

describe('report_findings terminal tool', () => {
  test('exposes the stable name and an input schema', () => {
    expect(REPORT_FINDINGS_NAME).toBe('report_findings');
    expect(reportFindingsTool.name).toBe('report_findings');
    expect(reportFindingsTool.inputSchema).toBeDefined();
  });
});

describe('parseReportFindings', () => {
  test('accepts a well-formed report', () => {
    const parsed = parseReportFindings({
      outcome: 'conclusive',
      summary: 'db pool exhausted',
      confidence: 82,
      rankedHypotheses: [{ hypothesis: 'pool', confidence: 82, evidence: 'metrics' }],
      unknowns: [
        {
          question: 'Whether the leak began before the deploy',
          category: 'historical_gap',
          evidenceKind: 'deployment_as_of',
          attemptedEvidenceIds: [],
        },
      ],
      nextStep: 'Compare connection age before and after the deploy.',
    });
    expect(parsed.summary).toBe('db pool exhausted');
    expect(parsed.confidence).toBe(82);
    expect(parsed.rankedHypotheses).toEqual([
      {
        hypothesis: 'pool',
        confidence: 82,
        evidence: 'metrics',
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
      },
    ]);
    expect(parsed.unknowns).toEqual([
      {
        question: 'Whether the leak began before the deploy',
        category: 'historical_gap',
        evidenceKind: 'deployment_as_of',
        attemptedEvidenceIds: [],
      },
    ]);
    expect(parsed.nextStep).toBe('Compare connection age before and after the deploy.');
  });

  test('defaults rankedHypotheses to [] when omitted', () => {
    const parsed = parseReportFindings({ outcome: 'inconclusive', summary: 's', confidence: 40 });
    expect(parsed.rankedHypotheses).toEqual([]);
    expect(parsed.unknowns).toEqual([]);
    expect(parsed.nextStep).toBeNull();
    expect(parsed.confidence).toBe(40);
  });

  test('accepts bounded decision fields and durable supporting and contradicting citations', () => {
    const supporting = '11111111-1111-4111-8111-111111111111';
    const contradicting = '22222222-2222-4222-8222-222222222222';
    const parsed = parseReportFindings({
      outcome: 'conclusive',
      summary: 'Pool pressure explains the latency.',
      confidence: 78,
      currentState: 'Degraded but serving traffic',
      impact: 'Checkout p95 latency is elevated.',
      evidenceIds: [supporting, contradicting],
      rankedHypotheses: [
        {
          hypothesis: 'Connection pool pressure',
          confidence: 78,
          evidence: 'Connections rose during the alert window.',
          state: 'leading',
          supportingEvidenceIds: [supporting],
          contradictingEvidenceIds: [contradicting],
        },
      ],
    });

    expect(parsed).toMatchObject({
      currentState: 'Degraded but serving traffic',
      impact: 'Checkout p95 latency is elevated.',
      evidenceIds: [supporting, contradicting],
      rankedHypotheses: [
        {
          state: 'leading',
          supportingEvidenceIds: [supporting],
          contradictingEvidenceIds: [contradicting],
        },
      ],
    });
  });

  test('salvages malformed input without throwing', () => {
    const parsed = parseReportFindings({ nonsense: true });
    expect(parsed.summary).toBe('No structured summary produced.');
    expect(parsed.confidence).toBe(30);
    expect(parsed.rankedHypotheses).toEqual([]);
  });

  test('salvage keeps a usable summary when only that field is present', () => {
    const parsed = parseReportFindings({ summary: 'partial hunch' });
    expect(parsed.summary).toBe('partial hunch');
    expect(parsed.confidence).toBe(30);
  });

  test('enforces the summary boundary in validated and salvaged reports', () => {
    const exact = 'x'.repeat(4_000);
    expect(
      parseReportFindings({ outcome: 'conclusive', summary: exact, confidence: 50 }).summary,
    ).toHaveLength(4_000);
    expect(parseReportFindings({ summary: `${exact}x` }).summary).toHaveLength(4_000);
  });

  test('never throws on non-object input', () => {
    expect(() => parseReportFindings(null)).not.toThrow();
    expect(() => parseReportFindings('oops')).not.toThrow();
    expect(parseReportFindings(null).confidence).toBe(30);
  });
});
