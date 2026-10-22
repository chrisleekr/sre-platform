import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { makeFakeGenerator } from '../fake';
import { EVIDENCE_REVIEW_INSTRUCTION, reviewInvestigation } from '../evidence-review';
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

test('an insufficient-evidence rejection keeps the demoted hypotheses, state and impact', async () => {
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
    rankedHypotheses: [
      { hypothesis: 'Limit too low', confidence: 90, evidence: 'OOMKilled', state: 'plausible' },
    ],
    causalFindings: [],
    causeTagSuggestions: [],
    approval: undefined,
    currentState: 'Memory at 99.6% of limit.',
    impact: 'Dashboards unavailable.',
    evidenceIds: [evidenceId],
  });
  expect(result.detail).toBeUndefined();
  expect(result.reviewGaps).toHaveLength(2);
  expect(result.reviewGaps?.join(' ')).toContain(secret);
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
  // Contradicted content may be false, so none of it survives.
  expect(result).toMatchObject({ rankedHypotheses: [], currentState: null, impact: null });
});

test('an incomplete review drops the unreviewed candidate content', async () => {
  const generator = makeFakeGenerator(() => ({ supported: 'not a boolean' }));
  const result = await reviewInvestigation(
    generator,
    candidate,
    evidence,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    outcome: 'inconclusive',
    rankedHypotheses: [],
    currentState: null,
    impact: null,
    evidenceIds: [],
  });
});

test('a rejection that cites nothing falls back to the candidate citations', async () => {
  const foreign = randomUUID();
  const generator = makeFakeGenerator(() => ({
    supported: false,
    rejection: 'insufficient_evidence',
    summary: 'Grafana was OOMKilled at 09:12Z.',
    evidenceIds: [],
  }));
  const result = await reviewInvestigation(
    generator,
    { ...candidate, evidenceIds: [evidenceId, foreign] },
    evidence,
    new AbortController().signal,
  );
  // Only ids in the admitted inventory survive the fallback.
  expect(result.evidenceIds).toEqual([evidenceId]);
});

test('hypotheses already below leading keep their state', async () => {
  const generator = makeFakeGenerator(() => ({
    supported: false,
    rejection: 'insufficient_evidence',
    summary: 'Grafana was OOMKilled at 09:12Z.',
    evidenceIds: [evidenceId],
  }));
  const result = await reviewInvestigation(
    generator,
    {
      ...candidate,
      rankedHypotheses: [
        { hypothesis: 'A', confidence: 60, evidence: 'e' },
        { hypothesis: 'B', confidence: 10, evidence: 'e', state: 'disfavored' },
      ],
    },
    evidence,
    new AbortController().signal,
  );
  expect(result.rankedHypotheses?.map((hypothesis) => hypothesis.state)).toEqual([
    'plausible',
    'disfavored',
  ]);
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

const capabilityGap = {
  question: 'No connected tool reads hypervisor logs.',
  category: 'missing_capability' as const,
  evidenceKind: null,
  attemptedEvidenceIds: [],
};
const missingCapabilityReview = () =>
  makeFakeGenerator(() => ({
    supported: false,
    rejection: 'missing_capability',
    summary: 'Grafana was OOMKilled at 09:12Z.',
    gaps: ['Read the hypervisor memory balloon log for 09:00 to 09:15Z.'],
    evidenceIds: [evidenceId],
  }));

test('a missing-capability rejection without the engine naming that gap reads as unproven', async () => {
  const result = await reviewInvestigation(
    missingCapabilityReview(),
    candidate,
    evidence,
    new AbortController().signal,
  );
  expect(result.outcome).toBe('inconclusive');
  expect(result.unknowns?.at(-1)?.category).toBe('partial_evidence');
});

test('a missing-capability rejection blocks the run and keeps the demoted hypotheses', async () => {
  const result = await reviewInvestigation(
    missingCapabilityReview(),
    { ...candidate, unknowns: [priorGap, capabilityGap] },
    evidence,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    outcome: 'blocked_missing_capability',
    confidence: 0,
    causalFindings: [],
    rankedHypotheses: [expect.objectContaining({ confidence: 90, state: 'plausible' })],
  });
  expect(result.unknowns?.at(-1)).toEqual({
    question: 'Read the hypervisor memory balloon log for 09:00 to 09:15Z.',
    category: 'missing_capability',
    evidenceKind: null,
    attemptedEvidenceIds: [evidenceId],
  });
});

test('demotion moves the leading hypothesis first, so it still headlines once every state reads plausible', async () => {
  const generator = makeFakeGenerator(() => ({
    supported: false,
    rejection: 'insufficient_evidence',
    summary: 'Grafana was OOMKilled at 09:12Z.',
    evidenceIds: [evidenceId],
  }));
  const result = await reviewInvestigation(
    generator,
    {
      ...candidate,
      rankedHypotheses: [
        { hypothesis: 'Disk pressure', confidence: 30, evidence: 'e', state: 'plausible' },
        { hypothesis: 'Limit too low', confidence: 90, evidence: 'OOMKilled', state: 'leading' },
      ],
    },
    evidence,
    new AbortController().signal,
  );
  expect(
    result.rankedHypotheses?.map((hypothesis) => [hypothesis.hypothesis, hypothesis.state]),
  ).toEqual([
    ['Limit too low', 'plausible'],
    ['Disk pressure', 'plausible'],
  ]);
});

const engineBlocked: TriageResult = {
  ...candidate,
  outcome: 'blocked_missing_capability',
  unknowns: [capabilityGap],
};
const insufficientReview = () =>
  makeFakeGenerator(() => ({
    supported: false,
    rejection: 'insufficient_evidence',
    summary: 'Grafana was OOMKilled at 09:12Z.',
    gaps: ['Confirm the hypervisor reclaimed memory at 09:12Z.'],
    evidenceIds: [evidenceId],
  }));

test('an engine that chose blocked stays blocked when the reviewer finds evidence insufficient', async () => {
  const result = await reviewInvestigation(
    insufficientReview(),
    engineBlocked,
    evidence,
    new AbortController().signal,
  );
  expect(result.outcome).toBe('blocked_missing_capability');
  // The reviewer named missing proof, not a missing capability.
  expect(result.unknowns?.at(-1)?.category).toBe('partial_evidence');
  expect(result.review).toMatchObject({
    status: 'rejected',
    rejection: 'insufficient_evidence',
    candidate: { outcome: 'blocked_missing_capability', confidence: 90 },
  });
});

test('a contradiction overrides an engine blocked choice', async () => {
  const result = await reviewInvestigation(
    makeFakeGenerator(() => ({
      supported: false,
      rejection: 'contradictory_evidence',
      summary: 'Grafana restarted twice after 09:00Z.',
      evidenceIds: [evidenceId],
    })),
    engineBlocked,
    evidence,
    new AbortController().signal,
  );
  expect(result.outcome).toBe('inconclusive');
});

test('an engine blocked choice with an open observable check is not blocked', async () => {
  const result = await reviewInvestigation(
    insufficientReview(),
    {
      ...engineBlocked,
      unknowns: [
        capabilityGap,
        { ...priorGap, category: 'observable', attemptedEvidenceIds: [evidenceId] },
      ],
    },
    evidence,
    new AbortController().signal,
  );
  expect(result.outcome).toBe('inconclusive');
});

test('an engine blocked choice that also saw a contradiction is not blocked', async () => {
  const result = await reviewInvestigation(
    insufficientReview(),
    {
      ...engineBlocked,
      unknowns: [capabilityGap, { ...priorGap, category: 'contradictory_evidence' }],
    },
    evidence,
    new AbortController().signal,
  );
  expect(result.outcome).toBe('inconclusive');
});

test('an engine blocked choice reviewed only on its cited records is not blocked', async () => {
  // Uncited records too large for one review force the cited-only fallback.
  const uncited = Array.from({ length: 3 }, () => ({
    ...evidence[0]!,
    id: randomUUID(),
    output: 'x'.repeat(200_000),
  }));
  const result = await reviewInvestigation(
    insufficientReview(),
    engineBlocked,
    [...evidence, ...uncited],
    new AbortController().signal,
  );
  expect(result.review?.coverage).toBe('cited_only');
  expect(result.outcome).toBe('inconclusive');
});

test('the reviewer is told an operator decision is not missing proof', () => {
  expect(EVIDENCE_REVIEW_INSTRUCTION).toContain(
    'A question classified operator_decision is a human choice, not missing proof. Never reject for it or list it in gaps.',
  );
});
