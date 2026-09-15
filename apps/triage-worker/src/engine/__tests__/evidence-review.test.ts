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

test.each(['x', '\\"\n'])(
  'budgets repeated context and escaped evidence slices for %j',
  async (text) => {
    const prompts: string[] = [];
    const generator = makeFakeGenerator((prompt) => {
      prompts.push(prompt);
      return { supported: true, summary: 'Checked', reason: 'Covered', evidenceIds: [evidenceId] };
    });
    const largeCandidate = { ...candidate, detail: 'context '.repeat(5_000) };
    const record = {
      ...evidence[0]!,
      output: text.repeat(text === 'x' ? 240_000 : 20_000) + 'END',
    };
    const result = await reviewInvestigation(
      generator,
      largeCandidate,
      [record],
      new AbortController().signal,
    );
    expect(result).toBe(largeCandidate);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.length).toBeLessThanOrEqual(7);
    expect(prompts.every((prompt) => prompt.length <= 96_000)).toBe(true);
    const slices = prompts.flatMap((prompt) => JSON.parse(prompt).evidenceSlices ?? []);
    expect(slices.map((slice) => slice.content).join('')).toBe(JSON.stringify(record));
  },
);

test.each([10, 200_000])('identifies missing evidence IDs at %i characters', async (size) => {
  const script = vi.fn();
  const result = await reviewInvestigation(
    makeFakeGenerator(script),
    candidate,
    [{ ...evidence[0]!, id: undefined, output: 'x'.repeat(size) }],
    new AbortController().signal,
  );
  expect(script).not.toHaveBeenCalled();
  expect(result.unknowns?.at(-1)?.question).toMatch(/missing.*id/i);
});

test('rejects context that leaves no chunk capacity before calling the provider', async () => {
  const script = vi.fn();
  const result = await reviewInvestigation(
    makeFakeGenerator(script),
    { ...candidate, detail: 'x'.repeat(96_000) },
    [{ ...evidence[0]!, output: 'x'.repeat(100_000) }],
    new AbortController().signal,
  );
  expect(script).not.toHaveBeenCalled();
  expect(result.unknowns?.at(-1)?.question).toMatch(/context.*budget/i);
});

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
    [{ ...evidence[0]!, output: 'x'.repeat(500_000) }],
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

test('reviews both ends of a large recorded response before accepting a conclusion', async () => {
  const prompts: string[] = [];
  const generator = makeFakeGenerator((prompt) => {
    prompts.push(prompt);
    return {
      supported: true,
      summary: 'The record contains observations, not proof of recovery.',
      reason: 'The admitted observations are consistent with the candidate.',
      evidenceIds: [evidenceId],
    };
  });
  const generate = vi.spyOn(generator, 'generate');
  const signal = new AbortController().signal;
  const result = await reviewInvestigation(
    generator,
    candidate,
    [
      {
        ...evidence[0]!,
        output: `FIRST-POD-OBSERVATION ${'x'.repeat(120_000)} MIDDLE-POD-OBSERVATION ${'x'.repeat(120_000)} LAST-POD-OBSERVATION`,
      },
    ],
    signal,
  );

  expect(prompts.length).toBeGreaterThan(1);
  expect(prompts.length).toBeLessThanOrEqual(7);
  expect(prompts.every((prompt) => prompt.length <= 96_000)).toBe(true);
  expect(prompts.join('\n')).toContain('FIRST-POD-OBSERVATION');
  expect(prompts.join('\n')).toContain('MIDDLE-POD-OBSERVATION');
  expect(prompts.join('\n')).toContain('LAST-POD-OBSERVATION');
  expect(generate.mock.calls.every((call) => call[2]?.signal === signal)).toBe(true);
  expect(result).toMatchObject({
    outcome: 'conclusive',
    evidenceReceipts: candidate.evidenceReceipts,
  });
});

test('does not start evidence review after the shared deadline is aborted', async () => {
  const controller = new AbortController();
  const reason = new Error('Investigation deadline exceeded');
  controller.abort(reason);
  const script = vi.fn(() => ({
    supported: true,
    summary: 'Healthy',
    reason: 'Accepted',
    evidenceIds: [evidenceId],
  }));
  await expect(
    reviewInvestigation(makeFakeGenerator(script), candidate, evidence, controller.signal),
  ).rejects.toBe(reason);
  expect(script).not.toHaveBeenCalled();
});

test('carries a later contradictory observation from a large record into the corrected answer', async () => {
  let sawOlder = false;
  let sawLater = false;
  const script = vi.fn((prompt: string) => {
    sawOlder ||= prompt.includes('10:28 runner absent');
    sawLater ||= prompt.includes('10:56 runner active');
    return {
      supported: !sawLater,
      summary: sawLater
        ? 'The runner was active at 10:56; earlier absence does not prove continuing absence.'
        : 'Only the earlier observation has been reviewed.',
      detail: sawLater
        ? 'Check the workload active at 10:56 before attributing current disk traffic.'
        : 'The 10:28 sample alone is incomplete.',
      reason: sawLater
        ? 'The later observation contradicts the claim of continuing absence.'
        : 'Review the remaining record before concluding.',
      evidenceIds: [evidenceId],
    };
  });
  const result = await reviewInvestigation(
    makeFakeGenerator(script),
    {
      ...candidate,
      disposition: 'reply',
      summary: 'The runner remained absent.',
      detail: 'No runner was active throughout the incident.',
    },
    [
      {
        ...evidence[0]!,
        output: `10:28 runner absent ${'x'.repeat(120_000)} 10:56 runner active ${'x'.repeat(120_000)}`,
      },
    ],
    new AbortController().signal,
  );
  expect(sawOlder).toBe(true);
  expect(sawLater).toBe(true);
  expect(result).toMatchObject({
    outcome: 'inconclusive',
    detail: expect.stringContaining('10:56'),
  });
  expect(result.detail).not.toContain('No runner was active throughout');
});

test('reports an input budget failure as incomplete review, not contradictory evidence', async () => {
  const script = vi.fn(() => ({
    supported: true,
    summary: 'Healthy',
    reason: 'Approved',
    evidenceIds: [evidenceId],
  }));
  const result = await reviewInvestigation(
    makeFakeGenerator(script),
    { ...candidate, disposition: 'reply', detail: 'Unchecked: restart every production node.' },
    [{ ...evidence[0]!, output: 'x'.repeat(500_000) }],
    new AbortController().signal,
  );

  expect(result.outcome).toBe('inconclusive');
  expect(result.detail).not.toContain('restart every production node');
  expect(result.unknowns?.at(-1)?.category).not.toBe('contradictory_evidence');
  expect(result.unknowns?.at(-1)?.question).toMatch(/budget|window|coverage/i);
  expect(script.mock.calls.length).toBeLessThanOrEqual(6);
});

test.each([
  ['invalid output', () => ({})],
  [
    'foreign evidence',
    () => ({
      supported: true,
      summary: 'Healthy',
      reason: 'Confirmed',
      evidenceIds: [randomUUID()],
    }),
  ],
] as const)(
  'retains a safe %s review failure reason without publishing unchecked detail',
  async (scenario, script) => {
    const result = await reviewInvestigation(
      makeFakeGenerator(script),
      { ...candidate, disposition: 'reply', detail: 'Unchecked destructive procedure' },
      evidence,
      new AbortController().signal,
    );

    expect(result.outcome).toBe('inconclusive');
    expect(result.detail).not.toContain('Unchecked destructive procedure');
    expect(result.unknowns?.at(-1)?.category).not.toBe('contradictory_evidence');
    expect(result.unknowns?.at(-1)?.question).toMatch(
      scenario === 'invalid output' ? /invalid|malformed/i : /foreign|unadmitted/i,
    );
  },
);

test('stops large-record review on its first rate limit without synthesis or retry', async () => {
  const script = vi.fn(() => {
    throw new ProviderRateLimitError();
  });
  await expect(
    reviewInvestigation(
      makeFakeGenerator(script),
      candidate,
      [{ ...evidence[0]!, output: 'x'.repeat(240_000) }],
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ProviderRateLimitError);
  expect(script).toHaveBeenCalledTimes(1);
});

test.each([
  [95_000, 100_000, /chunk budget/i],
  [80_000, 81_000, /synthesis budget/i],
] as const)(
  'preflights review cost for %i characters of context',
  async (contextSize, evidenceSize, reason) => {
    const script = vi.fn();
    const result = await reviewInvestigation(
      makeFakeGenerator(script),
      { ...candidate, detail: 'x'.repeat(contextSize) },
      [{ ...evidence[0]!, output: 'x'.repeat(evidenceSize) }],
      new AbortController().signal,
    );
    expect(script).not.toHaveBeenCalled();
    expect(result.unknowns?.at(-1)?.question).toMatch(reason);
  },
);
