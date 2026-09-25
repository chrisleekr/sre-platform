import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { reviewedEngine, reviewInvestigation } from '../evidence-review';
import { makeFakeEngine, makeFakeGenerator } from '../fake';
import { investigationRunResult, restrictEvidenceToReceipts } from '../../worker/run-result';
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

test.each(['verifyRecovery', 'resume'] as const)(
  '%s preserves supported current recovery while removing unsupported cause and advice',
  async (method) => {
    const correctedRecovery = {
      questions: [
        {
          question: 'The original cause remains unknown.',
          category: 'historical_gap' as const,
          evidenceKind: null,
          attemptedEvidenceIds: [],
          resolutionRelevance: 'follow_up' as const,
          nextAction: 'Review retained deployment events for recurrence prevention.',
        },
      ],
      outcome: 'recovered',
      recovered: true,
      summary: 'Checkout is serving successful requests.',
      evidence: [
        {
          name: 'Current request success',
          before: 'Elevated errors',
          now: 'Configured service objective met',
        },
      ],
      evidenceIds: [evidenceId],
      unknowns: ['The original cause remains unknown.'],
      nextStep: null,
      recheckAfterMinutes: null,
      scheduleReason: null,
    };
    const original = {
      ...candidate,
      disposition: 'recovery' as const,
      summary: 'The deployment bug caused the outage; restart the cluster to prevent recurrence.',
      recovery: {
        ...correctedRecovery,
        outcome: 'recovered' as const,
        nextStep: 'Restart the cluster.',
      },
    };
    const generate = vi.fn(() => ({
      supported: false,
      summary: correctedRecovery.summary,
      reason:
        'Current successful requests support recovery, but no evidence proves a deployment bug.',
      evidenceIds: [evidenceId],
      correctedRecovery,
    }));
    const engine = reviewedEngine(
      { ...makeFakeEngine(), [method]: async () => original },
      makeFakeGenerator(generate),
    );
    const runtime = {
      tools: [],
      ctx: { audit: { record: vi.fn() } },
      readEvidence: async (id: string) =>
        id === evidenceId ? { ...evidence, output: { successRate: 1, objectiveMet: true } } : null,
      signal: new AbortController().signal,
    } as unknown as TriageRuntime;
    const result =
      method === 'resume'
        ? await engine.resume(input, runtime)
        : await engine.verifyRecovery(
            { ...input, signalSummary: 'Provider episode cleared' },
            runtime,
          );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: 'conclusive',
      disposition: 'recovery',
      summary: correctedRecovery.summary,
      recovery: {
        outcome: 'recovered',
        recovered: true,
        evidenceIds: [evidenceId],
        unknowns: ['The original cause remains unknown.'],
        nextStep: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain('Restart the cluster');
    expect(JSON.stringify(result)).not.toContain('deployment bug caused');
  },
);

test.each(['missing', 'malformed', 'foreign citation', 'unavailable evidence'])(
  'recovery correction fails closed for %s',
  async (scenario) => {
    const correctedRecovery = {
      questions: [],
      outcome: 'recovered',
      recovered: true,
      summary: 'Checkout is healthy.',
      evidence: [{ name: 'Request success', before: 'High errors', now: 'Objective met' }],
      evidenceIds: [scenario === 'foreign citation' ? randomUUID() : evidenceId],
      unknowns: [],
      nextStep: null,
      recheckAfterMinutes: null,
      scheduleReason: null,
    };
    const generate = vi.fn(() => ({
      supported: false,
      summary: 'Optional cause unsupported.',
      reason: 'Do not promote unsupported claims.',
      evidenceIds: [evidenceId],
      ...(scenario === 'missing'
        ? {}
        : {
            correctedRecovery: scenario === 'malformed' ? { recovered: true } : correctedRecovery,
          }),
    }));
    const result = await reviewInvestigation(
      makeFakeGenerator(generate),
      {
        ...candidate,
        disposition: 'recovery',
        recovery: { ...correctedRecovery, outcome: 'recovered' },
      },
      [
        {
          ...evidence,
          ...(scenario === 'unavailable evidence' ? { outcome: 'error', output: null } : {}),
        },
      ],
      new AbortController().signal,
      input,
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: 'inconclusive',
      recovery: { recovered: false, outcome: 'needs_human' },
    });
  },
);

test.each(['foreign', 'unavailable'] as const)(
  'an endorsed original cannot authorize a %s corrected recovery citation',
  async (scenario) => {
    const correctedRecovery = {
      questions: [],
      outcome: 'recovered',
      recovered: true,
      summary: 'Checkout recovered.',
      evidence: [{ name: 'Request success', before: 'Errors', now: 'Healthy' }],
      evidenceIds: [scenario === 'foreign' ? randomUUID() : evidenceId],
      unknowns: [],
      nextStep: null,
      recheckAfterMinutes: null,
      scheduleReason: null,
    };
    const generate = vi.fn(() => ({
      supported: true,
      summary: 'Recovered',
      reason: 'Reviewed',
      evidenceIds: [evidenceId],
      correctedRecovery,
    }));
    const result = await reviewInvestigation(
      makeFakeGenerator(generate),
      { ...candidate, disposition: 'recovery' },
      [{ ...evidence, outcome: scenario === 'unavailable' ? 'error' : 'data' }],
      new AbortController().signal,
      input,
    );
    expect(result).toMatchObject({
      outcome: 'inconclusive',
      recovery: { outcome: 'needs_human', recovered: false },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  },
);

test('recovery questions retain failed attempt receipts, discard invented links and scrub nested text', () => {
  const unavailable = randomUUID();
  const forged = randomUUID();
  const result = restrictEvidenceToReceipts({
    ...candidate,
    disposition: 'recovery',
    evidenceReceipts: [{ evidenceId: unavailable, tool: 'kubernetes_get', outcome: 'unavailable' }],
    recovery: {
      outcome: 'needs_human',
      recovered: false,
      evidence: [],
      evidenceIds: [unavailable],
      unknowns: ['Stale projection'],
      nextStep: null,
      questions: [
        {
          question: 'Is password=private-value accepted?',
          category: 'missing_capability',
          evidenceKind: 'runtime_state',
          resolutionRelevance: 'blocking',
          nextAction: 'Inspect Authorization: Bearer private-token',
          attemptedEvidenceIds: [unavailable, forged],
        },
      ],
    },
  });
  expect(result.recovery?.evidenceIds).toEqual([]);
  expect(result.recovery?.questions?.[0]?.attemptedEvidenceIds).toEqual([unavailable]);
  const stored = investigationRunResult(result);
  expect(stored.recovery).toMatchObject({
    questions: [
      {
        question: 'Is password=[REDACTED] accepted?',
        nextAction: 'Inspect Authorization: [REDACTED]',
        attemptedEvidenceIds: [unavailable],
      },
    ],
    unknowns: ['Is password=[REDACTED] accepted?'],
  });
  expect(JSON.stringify(stored)).not.toContain('private-value');
  expect(JSON.stringify(stored)).not.toContain('private-token');
});
