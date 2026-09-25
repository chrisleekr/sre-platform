import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import * as z from 'zod';
import { reviewInvestigation } from '../evidence-review';
import { makeFakeGenerator } from '../fake';
import type { TriageResult } from '../types';

const id = randomUUID();
const evidence = {
  id,
  tool: 'query_metrics',
  input: {},
  output: 'healthy',
  outcome: 'data',
  createdAt: new Date(),
};
const candidate: TriageResult = {
  provider: 'fake',
  sessionId: 'boundaries',
  outcome: 'conclusive',
  disposition: 'recovery',
  turnBudget: 1,
  summary: 'Current health requires review.',
  confidence: 0,
};

test('a current contradiction split from historical health prevents an unsupported recovered conclusion', async () => {
  let synthesized = false;
  const result = await reviewInvestigation(
    makeFakeGenerator((prompt) => {
      const payload = JSON.parse(prompt);
      if (payload.evidenceSlices) {
        const content = payload.evidenceSlices
          .map((slice: { content: string }) => slice.content)
          .join('');
        return {
          complete: true,
          notes: [
            ...(content.includes('10:28 latency 40 ms')
              ? [{ kind: 'observation', text: '10:28 latency 40 ms', evidenceIds: [id] }]
              : []),
            ...(content.includes('10:56 current health failing')
              ? [{ kind: 'contradiction', text: '10:56 current health failing', evidenceIds: [id] }]
              : []),
          ],
        };
      }
      synthesized = true;
      expect(JSON.stringify(payload.reviewedEvidence)).toContain('10:28 latency 40 ms');
      expect(JSON.stringify(payload.reviewedEvidence)).toContain('10:56 current health failing');
      return {
        supported: false,
        rejection: 'contradictory_evidence',
        summary: 'Current health is failing.',
        reason: 'Earlier healthy latency does not establish current recovery.',
        evidenceIds: [id],
      };
    }),
    {
      ...candidate,
      recovery: {
        outcome: 'recovered',
        recovered: true,
        evidence: [],
        evidenceIds: [id],
        unknowns: [],
        questions: [],
        nextStep: null,
      },
    },
    [
      {
        ...evidence,
        output: `10:28 latency 40 ms ${'x'.repeat(120_000)} 10:56 current health failing ${'x'.repeat(120_000)}`,
      },
    ],
    new AbortController().signal,
  );
  expect(synthesized).toBe(true);
  expect(result).toMatchObject({
    outcome: 'inconclusive',
    recovery: {
      outcome: 'needs_human',
      recovered: false,
      questions: [
        {
          category: 'contradictory_evidence',
          attemptedEvidenceIds: [id],
          resolutionRelevance: 'blocking',
        },
      ],
    },
  });
});

test('validation diagnostics normalize only the known wrapper, reject unknown paths and cap issue details', async () => {
  const result = await reviewInvestigation(
    makeFakeGenerator(() => {
      throw new z.ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['result', 'correctedRecovery', 'questions', 12, 'nextAction'],
          message: 'private-message',
        },
        { code: 'custom', path: ['private-key', 'supported'], message: 'private-message' },
        { code: 'custom', path: ['result', 'result', 'supported'], message: 'private-message' },
        {
          code: 'too_small',
          origin: 'string',
          minimum: 1,
          inclusive: true,
          path: ['summary'],
          message: 'private-message',
        },
      ]);
    }),
    candidate,
    [evidence],
    new AbortController().signal,
  );
  const diagnostic = result.recovery!.questions![0]!.question;
  expect(diagnostic).toContain('invalid_type:correctedRecovery.questions[].nextAction');
  expect(diagnostic.match(/custom:root/g)).toHaveLength(2);
  expect(diagnostic.length).toBeLessThanOrEqual(240);
  expect(diagnostic).not.toContain('too_small');
  expect(JSON.stringify(result)).not.toMatch(/private-message|private-key/);
});

test('a slice cannot cite another admitted record outside its own source ranges', async () => {
  const other = randomUUID();
  let calls = 0;
  const result = await reviewInvestigation(
    makeFakeGenerator((prompt) => {
      calls++;
      const slices = JSON.parse(prompt).evidenceSlices;
      expect(slices.every((slice: { evidenceId: string }) => slice.evidenceId === id)).toBe(true);
      return {
        complete: true,
        notes: [{ kind: 'observation', text: 'Claim from another record.', evidenceIds: [other] }],
      };
    }),
    candidate,
    [
      { ...evidence, output: 'x'.repeat(240_000) },
      { ...evidence, id: other },
    ],
    new AbortController().signal,
  );
  expect(calls).toBe(1);
  expect(result.recovery).toMatchObject({
    outcome: 'needs_human',
    recovered: false,
    evidenceIds: [],
  });
  expect(result.recovery?.questions?.[0]?.question).toMatch(/slice.*foreign/);
});

test.each(['slice', 'synthesis'] as const)(
  '%s provider failures retain a safe stage and availability action',
  async (stage) => {
    let calls = 0;
    const result = await reviewInvestigation(
      makeFakeGenerator((prompt) => {
        calls++;
        if ((JSON.parse(prompt).evidenceSlices ? 'slice' : 'synthesis') === stage)
          throw new SyntaxError('raw private provider response');
        return { complete: true, notes: [] };
      }),
      candidate,
      [{ ...evidence, output: 'x'.repeat(240_000) }],
      new AbortController().signal,
    );
    const question = result.recovery!.questions![0]!;
    expect(question.question).toContain(stage);
    expect(question.question).toContain('provider was unavailable');
    expect(question.nextAction).toContain('Restore evidence review service availability');
    expect(question.category).toBe('partial_evidence');
    expect(JSON.stringify(result)).not.toContain('raw private provider response');
    expect(calls).toBeLessThanOrEqual(7);
  },
);
