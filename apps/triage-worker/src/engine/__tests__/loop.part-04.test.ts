import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { makeInMemoryAuditSink, type ToolDefinition } from '@sre/agent-tools';
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

  test('ends with the abort reason when the run is cancelled while a tool call is in flight', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    let started = false;
    const secondCall = vi.fn(async () => ({ available: true as const, data: 'unreached' }));
    // Stands in for a connector read: it stops only when the run signal aborts, then fails with a
    // provider-style error rather than the run's reason.
    const inflight: ToolDefinition<Record<string, never>, string> = {
      name: 'slow_read',
      description: 'waits on the run signal',
      inputSchema: z.object({}),
      handler: (ctx) =>
        new Promise((_, reject) => {
          started = true;
          ctx.signal?.addEventListener('abort', () => reject(new Error('fetch aborted')), {
            once: true,
          });
        }),
    };
    const next: ToolDefinition<Record<string, never>, string> = {
      name: 'next_read',
      description: 'must not run after cancellation',
      inputSchema: z.object({}),
      handler: secondCall,
    };
    const call = vi.fn<LoopProvider['call']>(async () => ({
      text: '',
      toolCalls: [
        { id: 'a', name: 'slow_read', input: {} },
        { id: 'b', name: 'next_read', input: {} },
      ],
      stopReason: 'tool_use',
      assistantMsg: {},
    }));
    const audit = makeInMemoryAuditSink();
    const ctx = { ...__fixture.ctx(), audit, signal: controller.signal };

    const run = runLoop({
      provider: provider(call),
      system: 'sys',
      initialUser: 'go',
      tools: [inflight, next],
      ctx,
      onStep: async () => {},
      maxTurns: 3,
      path: 'investigate',
      engineProvider: 'test',
      sessionId: 'test:inc-1',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort(reason);

    await expect(run).rejects.toBe(reason);
    expect(call).toHaveBeenCalledTimes(1);
    expect(secondCall).not.toHaveBeenCalled();
    // The cancelled read is not recorded as a tool error the model or responders would see.
    expect(audit.records).toHaveLength(0);
  });
});
