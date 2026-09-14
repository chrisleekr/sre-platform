import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { reviewedEngine, reviewInvestigation } from '../evidence-review';
import { makeFakeEngine, makeFakeGenerator } from '../fake';
import { restrictEvidenceToReceipts } from '../../worker/run-result';
import type { ResumeInput, TriageResult, TriageRuntime } from '../types';

const evidenceId = randomUUID();
const input: ResumeInput = {
  incident: {
    id: randomUUID(),
    tenantId: randomUUID(),
    service: 'node',
    severity: 'sev3',
    fingerprint: 'node',
    alertSource: 'slack',
  },
  humanMessage: 'What is the conclusion of the runbook?',
  prior: [{ author: 'human', kind: 'text', content: 'Create a diagnostic guide for next time.' }],
};
const evidence = {
  id: evidenceId,
  tool: 'metrics',
  input: {},
  output: { diskBusy: 1 },
  createdAt: new Date('2026-09-11T01:00:00Z'),
  outcome: 'data',
};
const candidate: TriageResult = {
  provider: 'fake',
  sessionId: 'test',
  outcome: 'conclusive',
  turnBudget: 1,
  disposition: 'reply',
  summary: 'Restarting fixes it.',
  detail: 'Unverified remedy',
  confidence: 90,
  evidenceIds: [evidenceId],
};

test('bounded review preserves gap-free serialized source ranges and supplies all chunk notes to synthesis', async () => {
  const source = {
    ...evidence,
    output: `10:28 absent ${'x'.repeat(120_000)} 10:56 active ${'x'.repeat(120_000)}`,
  };
  const serialized = JSON.stringify(source);
  const ranges: {
    offset: number;
    endOffset: number;
    totalLength: number;
    content: string;
    evidenceId: string;
  }[] = [];
  let synthesis = false;
  const generator = makeFakeGenerator((prompt) => {
    const payload = JSON.parse(prompt);
    if (payload.evidenceSlices) {
      ranges.push(...payload.evidenceSlices);
      return {
        supported: false,
        summary: prompt.includes('10:56 active')
          ? 'Runner active at 10:56.'
          : 'Slice alone cannot establish continuing absence.',
        reason: 'Preserve the observation window.',
        evidenceIds: [evidenceId],
      };
    }
    synthesis = true;
    expect(payload.reviewedEvidence).toHaveLength(ranges.length);
    expect(JSON.stringify(payload.reviewedEvidence)).toContain('Runner active at 10:56.');
    return {
      supported: false,
      summary: 'The runner was active at 10:56.',
      detail: 'Do not generalize absence from 10:28 to the later window.',
      reason: 'Observation windows differ.',
      evidenceIds: [evidenceId],
    };
  });
  const result = await reviewInvestigation(
    generator,
    candidate,
    [source],
    new AbortController().signal,
    input,
  );
  expect(synthesis).toBe(true);
  expect(ranges[0]?.offset).toBe(0);
  expect(ranges.at(-1)?.endOffset).toBe(serialized.length);
  expect(ranges.map((range) => range.content).join('')).toBe(serialized);
  for (const [index, range] of ranges.entries()) {
    expect(range.evidenceId).toBe(evidenceId);
    expect(range.totalLength).toBe(serialized.length);
    expect(range.endOffset - range.offset).toBe(range.content.length);
    expect(range.content.length).toBeLessThanOrEqual(80_000);
    if (index > 0) expect(range.offset).toBe(ranges[index - 1]!.endOffset);
  }
  expect(result.detail).toContain('10:28');
});

test('an invalid intermediate review stops coverage and withholds unchecked procedures', async () => {
  let calls = 0;
  const result = await reviewInvestigation(
    makeFakeGenerator(() => {
      calls++;
      if (calls === 2) return {};
      return {
        supported: true,
        summary: 'One slice reviewed.',
        reason: 'More coverage required.',
        evidenceIds: [evidenceId],
      };
    }),
    candidate,
    [{ ...evidence, output: 'x'.repeat(240_000) }],
    new AbortController().signal,
  );
  expect(calls).toBe(2);
  expect(result).toMatchObject({ outcome: 'inconclusive', confidence: 0 });
  expect(result.unknowns?.at(-1)).toMatchObject({
    category: 'partial_evidence',
    question: expect.stringMatching(/invalid/i),
  });
  expect(result.detail).not.toContain('Unverified remedy');
});

test('covers a large Kubernetes pod inventory without dropping nested status fields', async () => {
  const output = {
    kind: 'PodList',
    items: Array.from({ length: 950 }, (_, index) => ({
      metadata: { name: `runner-${index}`, namespace: 'ci', labels: { app: 'runner' } },
      spec: { nodeName: 'node-1', containers: [{ name: 'runner', image: 'runner:stable' }] },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            ready: true,
            restartCount: index,
            state: { running: { startedAt: '2026-09-13T01:00:00Z' } },
          },
        ],
      },
    })),
  };
  const seen: string[] = [];
  const result = await reviewInvestigation(
    makeFakeGenerator((prompt) => {
      const payload = JSON.parse(prompt);
      if (payload.evidenceSlices)
        seen.push(...payload.evidenceSlices.map((slice: { content: string }) => slice.content));
      return {
        supported: true,
        summary: 'Pod status is available.',
        reason: 'All admitted pod records were reviewed.',
        evidenceIds: [evidenceId],
      };
    }),
    candidate,
    [{ ...evidence, output }],
    new AbortController().signal,
  );
  expect(result.outcome).toBe('conclusive');
  const restored = JSON.parse(seen.join(''));
  expect(restored.output).toEqual(output);
});

test('a reviewer timeout has a safe explicit reason and is not retried', async () => {
  const script = vi.fn(() => {
    throw new DOMException('Private provider context', 'TimeoutError');
  });
  const result = await reviewInvestigation(
    makeFakeGenerator(script),
    candidate,
    [evidence],
    new AbortController().signal,
  );
  expect(script).toHaveBeenCalledTimes(1);
  expect(result.unknowns?.at(-1)).toMatchObject({
    category: 'partial_evidence',
    question: expect.stringContaining('timed out'),
  });
  expect(JSON.stringify(result)).not.toContain('Private provider context');
});

test('corrects the requested document instead of replacing it with an evidence audit', async () => {
  const generate = vi.fn((prompt: string) => {
    expect(JSON.parse(prompt).task.humanMessage).toBe(input.humanMessage);
    expect(JSON.parse(prompt).task.prior).toEqual(input.prior);
    return {
      supported: false,
      summary: 'Diagnostic guide drafted; no verified remedy.',
      detail:
        '# Diagnostic guide\n1. Compare CPU and disk pressure in the alert window.\n2. Attribute load before changing workloads.',
      reason: 'Restart is not verified.',
      evidenceIds: [evidenceId],
    };
  });
  const result = await reviewInvestigation(
    makeFakeGenerator(generate),
    candidate,
    [evidence],
    new AbortController().signal,
    input,
  );
  expect(result).toMatchObject({
    disposition: 'reply',
    outcome: 'inconclusive',
    detail: expect.stringContaining('# Diagnostic guide'),
    confidence: 0,
  });
  expect(result.detail).not.toContain('Unverified remedy');
});

test.each(['verifyRecovery', 'resume'] as const)(
  'reviews %s recovery and refuses unverified mutation advice',
  async (method) => {
    const recovery = {
      ...candidate,
      disposition: 'recovery' as const,
      recovery: {
        recovered: true,
        outcome: 'recovered' as const,
        evidence: [],
        unknowns: [],
        nextStep: 'Cap CPU and restart; this proves a defect.',
      },
    };
    const engine = reviewedEngine(
      { ...makeFakeEngine(), [method]: async () => recovery },
      makeFakeGenerator(() => ({
        supported: false,
        summary: 'Recovery and a safe remedy are not verified.',
        reason: 'CPU usage does not prove a version defect.',
        evidenceIds: [evidenceId],
      })),
    );
    const runtime = {
      tools: [],
      ctx: { audit: { record: vi.fn() } },
      readEvidence: async (id: string) => (id === evidenceId ? evidence : null),
      signal: new AbortController().signal,
    } as unknown as TriageRuntime;
    const result =
      method === 'resume'
        ? await engine.resume(input, runtime)
        : await engine.verifyRecovery({ ...input, signalSummary: 'cleared' }, runtime);
    expect(result.recovery).toMatchObject({
      recovered: false,
      outcome: 'needs_human',
      nextStep: null,
    });
    expect(JSON.stringify(result.recovery)).not.toContain('Cap CPU');
  },
);

test('historical original evidence is readable and admitted even outside the initial prompt window', async () => {
  const resume = vi.fn(async (_input: ResumeInput, runtime: TriageRuntime) => {
    const tool = runtime.tools.find((item) => item.name === 'read_recorded_evidence')!;
    expect(await tool.handler(runtime.ctx, { evidenceId, offset: 0 })).toMatchObject({
      available: true,
      data: { evidenceId },
    });
    return { ...candidate, evidenceIds: [evidenceId] };
  });
  const engine = reviewedEngine(
    { ...makeFakeEngine(), resume },
    makeFakeGenerator((prompt) => {
      expect(JSON.parse(prompt).evidence).toContainEqual(
        expect.objectContaining({ id: evidenceId, output: { diskBusy: 1 } }),
      );
      return {
        supported: true,
        summary: 'Historical disk saturation was recorded.',
        reason: 'Historical data, not a statement about current CPU.',
        evidenceIds: [evidenceId],
      };
    }),
  );
  const runtime = {
    tools: [],
    ctx: { audit: { record: vi.fn() } },
    readEvidence: async (id: string) => (id === evidenceId ? evidence : null),
    signal: new AbortController().signal,
  } as unknown as TriageRuntime;
  const result = await engine.resume(input, runtime);
  expect(result.evidenceReceipts).toContainEqual({
    evidenceId,
    tool: 'metrics',
    outcome: 'complete',
  });
});

test('a supported long answer uses a reviewed concise takeaway without losing its document', async () => {
  const result = await reviewInvestigation(
    makeFakeGenerator(() => ({
      supported: true,
      summary: 'Diagnostic guide ready for review.',
      reason: 'Supported diagnostic guidance.',
      evidenceIds: [evidenceId],
    })),
    { ...candidate, summary: 'Observation. '.repeat(60), detail: '# Full guide' },
    [evidence],
    new AbortController().signal,
    input,
  );
  expect(result).toMatchObject({
    summary: 'Diagnostic guide ready for review.',
    detail: '# Full guide',
  });
});

test('an unavailable historical record never becomes a factual receipt', async () => {
  const engine = reviewedEngine(
    { ...makeFakeEngine(), resume: async () => candidate },
    makeFakeGenerator(() => ({
      supported: true,
      summary: 'Candidate',
      reason: 'adversarial reviewer',
      evidenceIds: [evidenceId],
    })),
  );
  const runtime = {
    tools: [],
    ctx: { audit: { record: vi.fn() } },
    readEvidence: async () => ({ ...evidence, outcome: 'error', output: null }),
    signal: new AbortController().signal,
  } as unknown as TriageRuntime;
  const result = restrictEvidenceToReceipts(await engine.resume(input, runtime));
  expect(result.evidenceReceipts).toContainEqual({
    evidenceId,
    tool: 'metrics',
    outcome: 'unavailable',
  });
  expect(result.evidenceIds).toEqual([]);
  expect(result.outcome).toBe('inconclusive');
});
