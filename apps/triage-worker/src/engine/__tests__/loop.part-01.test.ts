// Phase A RED for C3: a dispatched tool result is rendered to the model as TOON
// (lossless re-encode, ~40% fewer tokens on uniform arrays), capped at the raised env budget
// TOOL_RESULT_MAX_CHARS, isError=false. Today renderToolResult emits JSON.stringify sliced at a hard
// 1500 chars, so the TOON-shape assertion and the raised-cap assertion are both RED.
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as z from 'zod';

import { decodeFromModel, encodeForModel } from '../toon';

import { type ToolDefinition } from '@sre/agent-tools';

import { runLoop, type LoopProvider, type ModelTurn, type ToolRunResult } from '../loop';

import { REPORT_FINDINGS_NAME } from '../report-findings';

import { REPORT_RECOVERY_NAME } from '../report-recovery';

import { createFixture } from './loop.fixture';

const __fixture = createFixture();

describe('renderToolResult TOON encoding + raised cap', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('C3 renders the tool result as TOON, capped at TOOL_RESULT_MAX_CHARS, isError=false', async () => {
    vi.stubEnv('TOOL_RESULT_MAX_CHARS', String(__fixture.RAISED_CAP));
    const { provider, rendered } = __fixture.scriptedProvider();

    await runLoop({
      provider,
      system: 'sys',
      initialUser: 'go',
      tools: [__fixture.uniformArrayTool()],
      ctx: __fixture.ctx(),
      onStep: async () => {},
      maxTurns: 4,
      path: 'investigate',
      engineProvider: 'test',
      sessionId: 'test:inc-1',
    });

    const result = rendered.find((r) => r.id === 't1')!;
    expect(result).toBeDefined();
    expect(result.isError).toBe(false);
    // TOON tabular header for a uniform array: `[N]{field,field}:` — not JSON.
    expect(result.content).toMatch(/\[\d+\]\{/);
    expect(result.content.trimStart().startsWith('[{')).toBe(false);
    // The raised env cap let materially more than the old 1500-char slice through, but still bounds it.
    expect(result.content.length).toBeGreaterThan(1500);
    expect(result.content.length).toBeLessThanOrEqual(__fixture.RAISED_CAP);
  });

  // The evidence store's correctness rests on TOON being a lossless re-encode of the JSON data model
  // (docs + code call it "lossless"): the agent reads these tables as the real tool data. Pin it.
  it('TOON encode is a lossless round-trip for uniform-array AND nested tool outputs', () => {
    const uniform = [
      { idx: 0, level: 'info', msg: 'a' },
      { idx: 1, level: 'warn', msg: 'b' },
    ];
    expect(decodeFromModel(encodeForModel(uniform))).toEqual(uniform);

    const nested = {
      service: 'checkout',
      counts: { errors: 3, warns: 7 },
      recent: [{ sha: 'abc', files: ['a.ts', 'b.ts'] }],
      ok: true,
    };
    expect(decodeFromModel(encodeForModel(nested))).toEqual(nested);
  });

  // renderToolResult was edited (TOON path); the error branch — the only non-available branch a tool
  // can produce — must never surface raw failure text to the model (CWE-209), and an empty store must
  // render as data. Both tools are called in ONE turn on purpose: `runLoop` dispatches a BATCH and
  // pushes one provider result-message batch, so this is the only place asserting every call is
  // dispatched and each result carries its own `call.id`. Models routinely emit parallel tool calls.
  it('renders each tool in a batched turn by id: a failed tool as a fixed, non-leaking error string and an empty result as data', async () => {
    const errorTool: ToolDefinition<Record<string, never>, unknown> = {
      name: 'boom_tool',
      description: 'throws',
      inputSchema: z.object({}),
      async handler() {
        throw new Error('sk-SECRET-should-never-surface');
      },
    };
    const emptyTool: ToolDefinition<Record<string, never>, unknown[]> = {
      name: 'empty_tool',
      description: 'serves an empty store',
      inputSchema: z.object({}),
      async handler() {
        return { available: true, data: [] };
      },
    };
    // Turn 1 calls both tools; turn 2 concludes.
    let turn = 0;
    const rendered: ToolRunResult[] = [];
    const provider: LoopProvider = {
      toolSpecs: () => [],
      userMsg: (text) => ({ role: 'user', content: text }),
      call: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [
              { id: 'e1', name: 'boom_tool', input: {} },
              { id: 'c1', name: 'empty_tool', input: {} },
            ],
            stopReason: 'tool_use',
            assistantMsg: {},
          } as ModelTurn;
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'r1',
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
        } as ModelTurn;
      },
      toolResultMsgs: (results) => {
        rendered.push(...results);
        return [{ role: 'user', content: results }];
      },
    };

    await runLoop({
      provider,
      system: 'sys',
      initialUser: 'go',
      tools: [errorTool, emptyTool],
      ctx: __fixture.ctx(),
      onStep: async () => {},
      maxTurns: 4,
      engineProvider: 'test',
      sessionId: 'test:inc-1',
      path: 'investigate',
    });

    // Both calls of the turn were dispatched, each result correlated to its own call id.
    expect(rendered).toHaveLength(2);
    const err = rendered.find((r) => r.id === 'e1')!;
    expect(err.isError).toBe(true);
    expect(err.content).toMatch(/^error: tool failed; evidenceId: [0-9a-f-]{36}$/);
    expect(err.content).not.toContain('SECRET');
    const empty = rendered.find((r) => r.id === 'c1')!;
    expect(empty.isError).toBe(false);
    expect(empty.content).toContain('evidenceId');
    expect(empty.content).toContain('data');
  });
});

describe('recovery terminal safety', () => {
  it('accepts report_recovery during the exploration budget', async () => {
    const forced: Array<string | undefined> = [];
    const provider: LoopProvider = {
      toolSpecs: (tools) => tools.map((tool) => tool.name),
      userMsg: (text) => text,
      call: async (_system, _messages, _specs, forceTool) => {
        forced.push(forceTool);
        return {
          text: '',
          toolCalls: [
            {
              id: 'recovery',
              name: REPORT_RECOVERY_NAME,
              input: {
                summary: 'Current health checks passed.',
                recovered: true,
                evidence: [
                  { name: 'Error rate', before: 'Above threshold', now: 'Below threshold' },
                ],
                evidenceIds: ['11111111-1111-4111-8111-111111111111'],
                unknowns: [],
                questions: [],
                nextStep: null,
              },
            },
          ],
          stopReason: 'tool_use',
          assistantMsg: {},
        };
      },
      toolResultMsgs: () => [],
    };

    const result = await runLoop({
      provider,
      system: 'recovery',
      initialUser: 'verify',
      tools: [],
      ctx: __fixture.ctx(),
      onStep: async () => {},
      maxTurns: 1,
      path: 'recovery',
      engineProvider: 'test',
      sessionId: 'test:recovery',
      terminals: [REPORT_RECOVERY_NAME],
    });

    expect(forced).toEqual([undefined]);
    expect(result).toMatchObject({ disposition: 'recovery', recovery: { recovered: true } });
  });

  it('returns inconclusive when recovery stops early without evidence or a terminal', async () => {
    const provider: LoopProvider = {
      toolSpecs: () => [],
      userMsg: (text) => text,
      call: async () => ({
        text: 'I cannot verify current health.',
        toolCalls: [],
        stopReason: 'stop',
        assistantMsg: {},
      }),
      toolResultMsgs: () => [],
    };

    const result = await runLoop({
      provider,
      system: 'recovery',
      initialUser: 'verify',
      tools: [],
      ctx: __fixture.ctx(),
      onStep: async () => {},
      maxTurns: 2,
      path: 'recovery',
      engineProvider: 'test',
      sessionId: 'test:recovery',
      terminals: [REPORT_RECOVERY_NAME],
    });

    expect(result).toMatchObject({ outcome: 'inconclusive' });
    expect(result.disposition).not.toBe('recovery');
  });
});
