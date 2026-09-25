import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { makeFakeGenerator } from '../fake';
import { reviewInvestigation } from '../evidence-review';
import type { InvestigationEvidence, StructuredGenerator, TriageResult } from '../types';

const citedId = randomUUID();
const cited: InvestigationEvidence = {
  id: citedId,
  tool: 'metrics',
  input: {},
  output: 'error rate 12% at 10:02, 0.1% at 10:20',
  createdAt: new Date(),
};
const uncited = (size: number): InvestigationEvidence => ({
  id: randomUUID(),
  tool: 'logs',
  input: {},
  output: 'x'.repeat(size),
  createdAt: new Date(),
});
const candidate: TriageResult = {
  provider: 'fake',
  sessionId: 'fake',
  outcome: 'conclusive',
  disposition: 'rca',
  turnBudget: 1,
  summary: 'A bad deploy raised the error rate.',
  confidence: 80,
  evidenceIds: [citedId],
  evidenceReceipts: [{ evidenceId: citedId, tool: 'metrics', outcome: 'complete' }],
};

function recording(answer: (input: Record<string, unknown>) => unknown) {
  const prompts: Record<string, unknown>[] = [];
  const generator: StructuredGenerator = makeFakeGenerator((prompt) => {
    const input = JSON.parse(prompt) as Record<string, unknown>;
    prompts.push(input);
    return answer(input);
  });
  return { generator, prompts };
}

const supported = { supported: true, summary: 'Checked', evidenceIds: [citedId] };
const signal = () => new AbortController().signal;

/** The accepted candidate plus the one gap naming the records the cited-only review skipped. */
function partiallyReviewed(unreviewed: InvestigationEvidence[]): TriageResult {
  return {
    ...candidate,
    unknowns: [
      {
        question: `Evidence review covered only the records this conclusion cites; ${unreviewed.length} uncited records were not reviewed and may contradict it.`,
        category: 'partial_evidence',
        evidenceKind: null,
        attemptedEvidenceIds: unreviewed.map((record) => record.id!),
      },
    ],
  };
}

test('an over-length reviewer field is trimmed instead of failing the review', async () => {
  const { generator } = recording(() => ({ ...supported, summary: 's'.repeat(2_000) }));
  const result = await reviewInvestigation(generator, candidate, [cited], signal());
  expect(result).toBe(candidate);
});

test('an input budget failure is retried with only the cited records', async () => {
  const { generator, prompts } = recording(() => supported);
  const evidence = [cited, uncited(200_000), uncited(200_000), uncited(200_000)];
  const result = await reviewInvestigation(generator, candidate, evidence, signal());
  expect(result).toEqual(partiallyReviewed(evidence.slice(1)));
  expect(prompts).toHaveLength(1);
  const [input] = prompts;
  expect((input!.evidence as InvestigationEvidence[]).map((record) => record.id)).toEqual([
    citedId,
  ]);
  expect(input!.coverage).toMatch(
    /^Only the records this conclusion cites\. Uncited run output was not reviewed; its absence proves nothing\./,
  );
});

test('an incomplete slice is a budget limit and falls back to the cited records', async () => {
  const { generator, prompts } = recording((input) =>
    input.evidenceSlices ? { complete: false, notes: [] } : supported,
  );
  const skipped = uncited(200_000);
  const result = await reviewInvestigation(generator, candidate, [cited, skipped], signal());
  expect(result).toEqual(partiallyReviewed([skipped]));
  expect(prompts[0]!.evidenceSlices).toBeDefined();
  expect(prompts.at(-1)!.coverage).toMatch(/^Only the records this conclusion cites\./);
});

test('recovery and causal finding citations join the cited set', async () => {
  const causalId = randomUUID();
  const causal = { ...uncited(10), id: causalId };
  const { generator, prompts } = recording(() => ({
    ...supported,
    evidenceIds: [citedId, causalId],
  }));
  const withFindings: TriageResult = {
    ...candidate,
    evidenceIds: [],
    recovery: {
      recovered: false,
      evidence: [],
      evidenceIds: [citedId],
      unknowns: [],
      nextStep: null,
    },
    causalFindings: [
      {
        candidateRef: 1,
        direction: 'candidate_caused_this',
        rationale: 'r',
        confidence: 60,
        evidenceIds: [causalId],
      },
    ],
  };
  await reviewInvestigation(
    generator,
    withFindings,
    [cited, causal, uncited(250_000), uncited(250_000)],
    signal(),
  );
  expect(
    (prompts.at(-1)!.evidence as InvestigationEvidence[]).map((record) => record.id).sort(),
  ).toEqual([citedId, causalId].sort());
});

test('with nothing cited the budget failure stands and the summary says why', async () => {
  const { generator, prompts } = recording(() => supported);
  const result = await reviewInvestigation(
    generator,
    { ...candidate, evidenceIds: [] },
    [cited, uncited(250_000), uncited(250_000)],
    signal(),
  );
  expect(prompts).toHaveLength(0);
  expect(result.outcome).toBe('inconclusive');
  const reason = 'Evidence review input budget exceeded; coverage is incomplete.';
  expect(result.summary).toBe(
    `Evidence review did not complete: ${reason} The evidence and prior assessment remain available.`,
  );
  expect(result.unknowns?.at(-1)?.question).toBe(reason);
});

test('a recovery budget failure never falls back to cited records and needs a human', async () => {
  const { generator, prompts } = recording(() => supported);
  const recovery: TriageResult = {
    ...candidate,
    disposition: 'recovery',
    recovery: {
      outcome: 'recovered',
      recovered: true,
      evidence: [],
      evidenceIds: [citedId],
      unknowns: [],
      nextStep: null,
    },
  };
  const result = await reviewInvestigation(
    generator,
    recovery,
    [{ ...cited, outcome: 'data' }, uncited(250_000), uncited(250_000)],
    signal(),
  );
  expect(prompts).toHaveLength(0);
  expect(result.outcome).toBe('inconclusive');
  expect(result.recovery).toMatchObject({ outcome: 'needs_human', recovered: false });
  expect(result.recovery?.questions?.[0]).toMatchObject({
    question: 'Evidence review input budget exceeded; coverage is incomplete.',
    resolutionRelevance: 'blocking',
  });
});

test('a candidate citing every record keeps the budget failure with no extra call', async () => {
  const { generator, prompts } = recording((input) =>
    input.evidenceSlices ? { complete: false, notes: [] } : supported,
  );
  const evidence = [cited, uncited(200_000)];
  const result = await reviewInvestigation(
    generator,
    { ...candidate, evidenceIds: evidence.map((record) => record.id!) },
    evidence,
    signal(),
  );
  // The first slice reports incomplete; a cited-only retry would repeat the same full review.
  expect(prompts).toHaveLength(1);
  expect(result.outcome).toBe('inconclusive');
  expect(result.unknowns?.at(-1)?.question).toBe('Evidence review slice coverage is incomplete.');
});

test('a genuine reviewer rejection keeps the reviewer summary as the answer, not a question', async () => {
  const { generator } = recording(() => ({
    supported: false,
    rejection: 'insufficient_evidence',
    summary: 'The deploy is not linked to the error rate change.',
    evidenceIds: [citedId],
  }));
  const result = await reviewInvestigation(generator, candidate, [cited], signal());
  expect(result.outcome).toBe('inconclusive');
  expect(result.summary).toBe('The deploy is not linked to the error rate change.');
  expect(result.unknowns?.at(-1)?.question).toBe(
    'Evidence review found the conclusion unsupported but named no specific missing proof.',
  );
});
