import { describe, expect, test, vi } from 'vitest';
import type { Db } from '@sre/db';
import { SIGNAL_DISPOSITION_SCENARIOS } from '../engine/signal-disposition-corpus';
import { evaluateSignalDispositionCorpus, makeSignalEvaluationHandler } from '../signal-evaluation';
import type { LlmRuntimeManager } from '../llm-runtime';

const dbMocks = vi.hoisted(() => ({
  claimSignalDispositionEvaluation: vi.fn(),
  completeSignalDispositionEvaluation: vi.fn(),
  failSignalDispositionEvaluation: vi.fn(),
}));

vi.mock('@sre/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sre/db')>()),
  ...dbMocks,
}));

const semanticResult = (scenarioId: string) => {
  const scenario = SIGNAL_DISPOSITION_SCENARIOS.find((item) => item.id === scenarioId)!;
  const common = {
    disposition: scenario.expected,
    decision: scenario.expectedDecision.decision,
    reason: 'Reviewed corpus expectation.',
    ...(scenario.expectedDecision.index === undefined
      ? {}
      : { index: scenario.expectedDecision.index }),
    ...(scenario.expectedDecision.signalIndex === undefined
      ? {}
      : { signalIndex: scenario.expectedDecision.signalIndex }),
  };
  if (scenario.expected !== 'ticket') return common;
  return { ...common, ...scenario.ticket };
};

describe('signal disposition runtime evaluation', () => {
  test('passes the attempt signal to the runtime and rethrows an aborted provider call', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    dbMocks.claimSignalDispositionEvaluation.mockResolvedValueOnce({
      id: 'evaluation-1',
      runtimeFingerprint: 'runtime-a',
    });
    const execute = vi.fn(async (meta, run) => {
      expect(meta.signal).toBe(controller.signal);
      controller.abort(reason);
      return run({
        generator: {
          generate: vi.fn(async () => {
            throw reason;
          }),
        },
      } as never);
    });
    const llm = {
      execute,
      configurationFingerprint: async () => 'runtime-a',
    } as unknown as LlmRuntimeManager;
    const handler = makeSignalEvaluationHandler({ db: {} as Db, llm });

    await expect(
      handler(
        {
          id: 'job-1',
          tenantId: 'tenant-a',
          type: 'signal.disposition.evaluate',
          attempts: 1,
          payload: { evaluationId: 'evaluation-1' },
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(dbMocks.failSignalDispositionEvaluation).not.toHaveBeenCalled();
  });

  test('meters exactly one structured classifier decision for each reviewed scenario', async () => {
    const generate = vi.fn(
      async (
        prompt: string,
        _schema: unknown,
        _options?: { system?: string; signal?: AbortSignal },
      ) => {
        const request = JSON.parse(prompt) as { context: { summary: string } };
        const scenario = SIGNAL_DISPOSITION_SCENARIOS.find(
          (item) => item.message === request.context.summary,
        )!;
        return semanticResult(scenario.id);
      },
    );
    const executeCalls = vi.fn();
    const controller = new AbortController();
    const llm: LlmRuntimeManager = {
      async execute(meta, run) {
        executeCalls(meta, run);
        return run({ generator: { generate } } as never);
      },
      configurationFingerprint: async () => 'runtime-a',
    };

    const score = await evaluateSignalDispositionCorpus(
      llm,
      { id: '00000000-0000-4000-8000-000000000001', tenantId: 'tenant-a' },
      'runtime-a',
      controller.signal,
    );

    expect(executeCalls).toHaveBeenCalledTimes(SIGNAL_DISPOSITION_SCENARIOS.length);
    expect(generate).toHaveBeenCalledTimes(SIGNAL_DISPOSITION_SCENARIOS.length);
    expect(executeCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedConfigurationFingerprint: 'runtime-a',
        signal: controller.signal,
      }),
      expect.any(Function),
    );
    expect(generate.mock.calls[0]![2]).toMatchObject({ signal: controller.signal });
    expect(score).toMatchObject({
      total: SIGNAL_DISPOSITION_SCENARIOS.length,
      correct: SIGNAL_DISPOSITION_SCENARIOS.length,
      criticalSafetyMisses: 0,
    });
  });
});
