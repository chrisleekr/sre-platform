import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { makeFakeGenerator } from '../fake';
import { reviewInvestigation } from '../evidence-review';
import type { TriageResult } from '../types';

const evidenceId = randomUUID();
const evidence = [
  {
    id: evidenceId,
    tool: 'k8s',
    input: {},
    output: 'grafana OOMKilled 09:12Z',
    createdAt: new Date(),
  },
];
const priorGap = {
  question: 'Which dashboard query drove the spike?',
  category: 'partial_evidence' as const,
  evidenceKind: null,
  attemptedEvidenceIds: [],
};
const candidate: TriageResult = {
  provider: 'fake',
  sessionId: 'fake',
  outcome: 'conclusive',
  disposition: 'rca',
  turnBudget: 1,
  summary: 'Grafana was OOMKilled because its memory limit is too low.',
  confidence: 90,
  currentState: 'Memory at 99.6% of limit.',
  impact: 'Dashboards unavailable.',
  rankedHypotheses: [
    { hypothesis: 'Limit too low', confidence: 90, evidence: 'OOMKilled', state: 'leading' },
  ],
  causalFindings: [
    {
      candidateRef: 1,
      direction: 'candidate_caused_this',
      rationale: 'Deploy raised load',
      confidence: 80,
      evidenceIds: [evidenceId],
    },
  ],
  approval: { prompt: 'Raise the limit', options: [{ id: 'approve', label: 'Approve' }] },
  unknowns: [priorGap],
  nextStep: 'Raise the memory limit to 2Gi.',
  evidenceReceipts: [{ evidenceId, tool: 'k8s', outcome: 'complete' }],
};

test('a rejection surfaces the reviewer answer, gaps and next step without promoting', async () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const generator = makeFakeGenerator(() => ({
    supported: false,
    rejection: 'insufficient_evidence',
    summary: 'Grafana was OOMKilled at 09:12Z; memory was at 99.6% of its limit at 09:40Z.',
    detail: `Restart history and memory series. key ${secret}`,
    gaps: [
      'Confirm OOMKilled as the termination reason for every restart in the range.',
      `Check RSS against the limit, not working set. key ${secret}`,
    ],
    nextStep: 'Query container RSS against the limit over the last 6 hours.',
    evidenceIds: [evidenceId],
  }));
  const result = await reviewInvestigation(
    generator,
    candidate,
    evidence,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    outcome: 'inconclusive',
    disposition: undefined,
    confidence: 0,
    summary: 'Grafana was OOMKilled at 09:12Z; memory was at 99.6% of its limit at 09:40Z.',
    nextStep: 'Query container RSS against the limit over the last 6 hours.',
    rankedHypotheses: [],
    causalFindings: [],
    causeTagSuggestions: [],
    approval: undefined,
    currentState: null,
    impact: null,
    evidenceIds: [evidenceId],
  });
  expect(result.detail).toBeUndefined();
  expect(result.reviewGaps).toHaveLength(2);
  expect(result.reviewGaps?.join(' ')).not.toContain(secret);
  expect(result.unknowns).toEqual([
    priorGap,
    ...result.reviewGaps!.map((question) => ({
      question,
      category: 'partial_evidence',
      evidenceKind: null,
      attemptedEvidenceIds: [evidenceId],
    })),
  ]);
});

test('a contradiction rejection classifies every gap as contradictory evidence', async () => {
  const generator = makeFakeGenerator(() => ({
    supported: false,
    rejection: 'contradictory_evidence',
    summary: 'Grafana restarted twice after 09:00Z.',
    gaps: ['Reconcile the 09:12Z OOMKilled event with the 09:30Z healthy probe.'],
    evidenceIds: [evidenceId],
  }));
  const result = await reviewInvestigation(
    generator,
    candidate,
    evidence,
    new AbortController().signal,
  );
  expect(result.unknowns?.slice(1).map((gap) => gap.category)).toEqual(['contradictory_evidence']);
});

test('a rejection without gaps records a fixed open question, not the factual summary', async () => {
  const generator = makeFakeGenerator(() => ({
    supported: false,
    summary: 'Grafana was OOMKilled at 09:12Z.',
    evidenceIds: [evidenceId],
  }));
  const result = await reviewInvestigation(
    generator,
    candidate,
    evidence,
    new AbortController().signal,
  );
  expect(result.nextStep).toBe('Review the preserved evidence before relying on this conclusion.');
  expect(result.detail).toBeUndefined();
  expect(result.reviewGaps).toBeUndefined();
  expect(result.unknowns).toEqual([
    priorGap,
    {
      question:
        'Evidence review found the conclusion unsupported but named no specific missing proof.',
      category: 'partial_evidence',
      evidenceKind: null,
      attemptedEvidenceIds: [evidenceId],
    },
  ]);
});

test('a reply rejection keeps the corrected answer as detail', async () => {
  const generator = makeFakeGenerator(() => ({
    supported: false,
    summary: 'Grafana was OOMKilled at 09:12Z.',
    detail: 'Corrected answer.',
    gaps: ['Confirm the restart reason.'],
    evidenceIds: [evidenceId],
  }));
  const result = await reviewInvestigation(
    generator,
    { ...candidate, disposition: 'reply', detail: 'Original answer.' },
    evidence,
    new AbortController().signal,
  );
  expect(result).toMatchObject({ disposition: 'reply', detail: 'Corrected answer.' });
});

test('more than five gaps are all kept as unknowns and a blank next step falls back', async () => {
  const generator = makeFakeGenerator(() => ({
    supported: false,
    summary: 'Grafana was OOMKilled at 09:12Z.',
    gaps: [...Array.from({ length: 6 }, (_, index) => `Check ${index}.`), '   '],
    nextStep: '  ',
    evidenceIds: [evidenceId],
  }));
  const result = await reviewInvestigation(
    generator,
    candidate,
    evidence,
    new AbortController().signal,
  );
  expect(result.outcome).toBe('inconclusive');
  expect(result.summary).toBe('Grafana was OOMKilled at 09:12Z.');
  expect(result.unknowns?.slice(1).map((gap) => gap.question)).toEqual(
    Array.from({ length: 6 }, (_, index) => `Check ${index}.`),
  );
  expect(result.reviewGaps).toEqual(Array.from({ length: 5 }, (_, index) => `Check ${index}.`));
  expect(result.nextStep).toBe('Review the preserved evidence before relying on this conclusion.');
});
