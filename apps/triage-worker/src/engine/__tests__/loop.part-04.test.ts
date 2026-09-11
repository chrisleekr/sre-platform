import { describe, expect, test, vi } from 'vitest';
import { runLoop, type LoopProvider, type ModelTurn } from '../loop';
import { REPORT_FINDINGS_NAME } from '../report-findings';
import { createFixture } from './loop.fixture';

const __fixture = createFixture();

function conclusion(): ModelTurn {
  return {
    text: '',
    toolCalls: [
      {
        id: 'finding',
        name: REPORT_FINDINGS_NAME,
        input: {
          outcome: 'conclusive',
          summary: 'done',
          confidence: 50,
          rankedHypotheses: [],
        },
      },
    ],
    stopReason: 'tool_use',
    assistantMsg: {},
  };
}

function provider(call: LoopProvider['call']): LoopProvider {
  return {
    toolSpecs: () => [],
    userMsg: (text) => ({ role: 'user', content: text }),
    call,
    toolResultMsgs: () => [],
  };
}

describe('runLoop deadline signal', () => {
  test('throws an already-aborted signal reason without calling the provider', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);
    const call = vi.fn<LoopProvider['call']>();

    await expect(
      runLoop({
        provider: provider(call),
        system: 'sys',
        initialUser: 'go',
        tools: [],
        ctx: __fixture.ctx(),
        onStep: async () => {},
        maxTurns: 1,
        path: 'investigate',
        engineProvider: 'test',
        sessionId: 'test:inc-1',
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(call).not.toHaveBeenCalled();
  });

  test('passes the live signal as the provider call fifth argument', async () => {
    const controller = new AbortController();
    const call = vi.fn<LoopProvider['call']>(async () => conclusion());

    await runLoop({
      provider: provider(call),
      system: 'sys',
      initialUser: 'go',
      tools: [],
      ctx: __fixture.ctx(),
      onStep: async () => {},
      maxTurns: 1,
      path: 'investigate',
      engineProvider: 'test',
      sessionId: 'test:inc-1',
      signal: controller.signal,
    });

    expect(call).toHaveBeenCalledWith(
      'sys',
      [{ role: 'user', content: 'go' }],
      [],
      undefined,
      controller.signal,
    );
  });
});
