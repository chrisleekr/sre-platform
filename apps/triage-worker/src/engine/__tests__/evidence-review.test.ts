import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { makeFakeGenerator } from '../fake';
import { reviewInvestigation } from '../evidence-review';
import { recordedEvidenceTool } from '../recorded-evidence';
import { ProviderRateLimitError, type TriageResult, type TriageRuntime } from '../types';

const evidenceId = randomUUID();
const evidence = [
  { id: evidenceId, tool: 'logs', input: {}, output: 'checksum mismatch', createdAt: new Date() },
];
const candidate: TriageResult = {
  provider: 'fake',
  sessionId: 'fake',
  outcome: 'conclusive',
  disposition: 'rca',
  turnBudget: 1,
  summary: 'Delivery is healthy.',
  confidence: 95,
  evidenceReceipts: [{ evidenceId, tool: 'logs', outcome: 'complete' }],
};

test('unsupported findings become nonpromoting while preserving evidence receipts', async () => {
  const generator = makeFakeGenerator(() => ({
    supported: false,
    summary: 'Deployment failed its checksum check.',
    reason: 'Current logs contradict healthy delivery.',
    evidenceIds: [evidenceId],
  }));
  expect(
    await reviewInvestigation(generator, candidate, evidence, new AbortController().signal),
  ).toMatchObject({
    outcome: 'inconclusive',
    summary: 'Deployment failed its checksum check.',
    evidenceReceipts: candidate.evidenceReceipts,
  });
});

test('an unsupported causal assertion in a proposal cannot become an actionable approval', async () => {
  const proposal: TriageResult = {
    ...candidate,
    disposition: 'approval',
    approval: {
      prompt: 'Approve rollback of GitHub PR 42, which caused production failure.',
      options: [{ id: 'approve', label: 'Approve rollback' }],
    },
  };
  const generator = makeFakeGenerator(() => ({
    supported: false,
    summary: 'The GitHub mirror is not verified as the deployed source.',
    reason: 'Missing deployed artifact linkage.',
    evidenceIds: [evidenceId],
  }));
  expect(
    await reviewInvestigation(generator, proposal, evidence, new AbortController().signal),
  ).toMatchObject({ outcome: 'inconclusive', disposition: undefined, approval: undefined });
});

test('an oversized review fails closed without claiming semantic contradiction detection', async () => {
  const script = vi.fn(() => ({
    supported: true,
    summary: 'Unsupported',
    reason: 'Not run',
    evidenceIds: [evidenceId],
  }));
  const result = await reviewInvestigation(
    makeFakeGenerator(script),
    candidate,
    [{ ...evidence[0]!, output: 'x'.repeat(170_000) }],
    new AbortController().signal,
  );
  expect(script).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    outcome: 'inconclusive',
    summary: expect.stringContaining('could not be verified'),
    evidenceReceipts: candidate.evidenceReceipts,
  });
});

test('a supported conclusion survives a successful review', async () => {
  const generator = makeFakeGenerator(() => ({
    supported: true,
    summary: 'Unused',
    reason: 'Confirmed deployed revision matches the authoritative source.',
    evidenceIds: [evidenceId],
  }));
  expect(
    await reviewInvestigation(generator, candidate, evidence, new AbortController().signal),
  ).toBe(candidate);
});

test.each(['invalid', 'foreign evidence', 'unavailable'])(
  'review %s fails closed without losing receipts',
  async (scenario) => {
    const generator = makeFakeGenerator(() => {
      if (scenario === 'unavailable') throw new Error('provider disconnected');
      return scenario === 'invalid'
        ? {}
        : {
            supported: true,
            summary: 'Confirmed',
            reason: 'Claimed evidence',
            evidenceIds: [randomUUID()],
          };
    });
    const result = await reviewInvestigation(
      generator,
      candidate,
      evidence,
      new AbortController().signal,
    );
    expect(result.outcome).toBe('inconclusive');
    expect(result.evidenceReceipts).toEqual(candidate.evidenceReceipts);
  },
);

test('review rate limits propagate without a retry or fallback call', async () => {
  const script = vi.fn(() => {
    throw new ProviderRateLimitError();
  });
  await expect(
    reviewInvestigation(
      makeFakeGenerator(script),
      candidate,
      evidence,
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ProviderRateLimitError);
  expect(script).toHaveBeenCalledTimes(1);
});

test('recorded evidence reads reject foreign IDs and preserve original ID across bounded slices', async () => {
  const readEvidence = vi.fn(async () => ({ ...evidence[0]!, output: 'x'.repeat(10_000) }));
  const runtime = { readEvidence } as unknown as TriageRuntime;
  const tool = recordedEvidenceTool(runtime, candidate.evidenceReceipts!, []);
  expect(await tool.handler(runtime.ctx, { evidenceId: randomUUID(), offset: 0 })).toEqual({
    available: false,
    reason: 'error',
  });
  expect(readEvidence).toHaveBeenCalledTimes(1);
  const first = await tool.handler(runtime.ctx, { evidenceId, offset: 0 });
  expect(first).toMatchObject({
    available: true,
    data: { evidenceId, offset: 0, nextOffset: 4_000 },
  });
  const last = await tool.handler(runtime.ctx, { evidenceId, offset: 8_000 });
  expect(last).toMatchObject({
    available: true,
    data: { evidenceId, offset: 8_000, nextOffset: null },
  });
});
