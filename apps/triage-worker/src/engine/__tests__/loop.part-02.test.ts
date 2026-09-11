// Phase A RED: a dispatched tool result is rendered to the model as TOON
// (lossless re-encode, ~40% fewer tokens on uniform arrays), capped at the raised env budget
// TOOL_RESULT_MAX_CHARS, isError=false. Today renderToolResult emits JSON.stringify sliced at a hard
// 1500 chars, so the TOON-shape assertion and the raised-cap assertion are both RED.
import { describe, expect, it } from 'vitest';

import { type ToolDefinition } from '@sre/agent-tools';

import { runLoop, type LoopProvider, type ToolRunResult } from '../loop';

import { REPORT_FINDINGS_NAME } from '../report-findings';

import { RESPOND_NAME } from '../respond';

import { STAY_SILENT_NAME } from '../stay-silent';

import { createFixture } from './loop.fixture';

const __fixture = createFixture();

describe('terminal binding + disposition', () => {
  // A provider that captures the tools bound into toolSpecs and scripts a single terminal turn (or, when
  // `name` is null, an empty turn so the loop degrades).
  function terminalProvider(
    name: string | null,
    input: unknown,
  ): {
    provider: LoopProvider;
    boundNames: () => string[];
  } {
    let captured: ToolDefinition<any, any>[] = [];
    const provider: LoopProvider = {
      toolSpecs: (tools) => {
        captured = tools;
        return [];
      },
      userMsg: (text) => ({ role: 'user', content: text }),
      call: async () => ({
        text: '',
        toolCalls: name ? [{ id: 'x', name, input }] : [],
        stopReason: name ? 'tool_use' : 'end_turn',
        assistantMsg: {},
      }),
      toolResultMsgs: (results) => [{ role: 'user', content: results }],
    };
    return { provider, boundNames: () => captured.map((t) => t.name) };
  }

  const base = {
    system: 'sys',
    initialUser: 'go',
    tools: [] as ToolDefinition<any, any>[],
    onStep: async () => {},
    maxTurns: 4,
    engineProvider: 'test',
    sessionId: 'test:inc-1',
    path: 'resume' as const,
  };

  it('binds only report_findings by default / when terminals is [report_findings]', async () => {
    const { provider, boundNames } = terminalProvider(REPORT_FINDINGS_NAME, {
      outcome: 'conclusive',
      summary: 's',
      confidence: 50,
    });
    await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      path: 'investigate',
      terminals: [REPORT_FINDINGS_NAME],
    });
    expect(boundNames()).toContain(REPORT_FINDINGS_NAME);
    expect(boundNames()).not.toContain(RESPOND_NAME);
    expect(boundNames()).not.toContain(STAY_SILENT_NAME);
  });

  it('runs a recorded-evidence-only structured assessment after the exploration budget', async () => {
    const calls: Array<{ specs: string[]; forceTool?: string }> = [];
    const provider: LoopProvider = {
      toolSpecs: (tools) => tools.map((tool) => tool.name),
      userMsg: (text) => ({ role: 'user', content: text }),
      call: async (_system, _messages, specs, forceTool) => {
        calls.push({ specs: specs as string[], forceTool });
        if (!(specs as string[]).includes('read_recorded_evidence')) {
          return {
            text: '',
            toolCalls: [{ id: 'e1', name: 'evidence_tool', input: {} }],
            stopReason: 'tool_use',
            assistantMsg: {},
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'r1',
              name: REPORT_FINDINGS_NAME,
              input: {
                outcome: 'conclusive',
                summary: 'bounded assessment',
                confidence: 61,
                rankedHypotheses: [],
              },
            },
          ],
          stopReason: 'tool_use',
          assistantMsg: {},
        };
      },
      toolResultMsgs: (results) => [{ role: 'user', content: results }],
    };

    const result = await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      path: 'investigate',
      tools: [__fixture.uniformArrayTool()],
      maxTurns: 2,
      terminals: [REPORT_FINDINGS_NAME],
    });

    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({
      specs: [REPORT_FINDINGS_NAME, 'read_recorded_evidence'],
      forceTool: undefined,
    });
    expect(result).toMatchObject({ summary: 'bounded assessment', confidence: 61 });
  });

  it('binds the requested terminal subset', async () => {
    const { provider, boundNames } = terminalProvider(STAY_SILENT_NAME, {});
    await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      terminals: [REPORT_FINDINGS_NAME, RESPOND_NAME, STAY_SILENT_NAME],
    });
    expect(boundNames()).toEqual(
      expect.arrayContaining([REPORT_FINDINGS_NAME, RESPOND_NAME, STAY_SILENT_NAME]),
    );
  });

  it('report_findings → disposition rca with summary, confidence, rankedHypotheses', async () => {
    const { provider } = terminalProvider(REPORT_FINDINGS_NAME, {
      outcome: 'conclusive',
      summary: 'root cause X',
      confidence: 88,
      rankedHypotheses: [{ hypothesis: 'h', confidence: 88, evidence: 'e' }],
    });
    const result = await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      terminals: [REPORT_FINDINGS_NAME, RESPOND_NAME, STAY_SILENT_NAME],
    });
    expect(result.disposition).toBe('rca');
    expect(result.summary).toBe('root cause X');
    expect(result.confidence).toBe(88);
    expect(result.rankedHypotheses).toEqual([
      {
        hypothesis: 'h',
        confidence: 88,
        evidence: 'e',
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
      },
    ]);
  });

  it('challenges an unattempted observable gap once, then accepts the cited check', async () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    let turn = 0;
    const toolResults: ToolRunResult[] = [];
    const provider: LoopProvider = {
      toolSpecs: () => [],
      userMsg: (text) => text,
      call: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'draft',
                name: REPORT_FINDINGS_NAME,
                input: {
                  outcome: 'inconclusive',
                  summary: 'draft',
                  confidence: 40,
                  unknowns: [
                    {
                      question: 'Which configuration is active?',
                      category: 'observable',
                      evidenceKind: 'runtime_configuration',
                      attemptedEvidenceIds: [],
                    },
                  ],
                },
              },
            ],
            stopReason: 'tool_use',
            assistantMsg: {},
          };
        }
        if (turn === 2) {
          return {
            text: '',
            toolCalls: [{ id: 'check', name: 'evidence_tool', input: {} }],
            stopReason: 'tool_use',
            assistantMsg: {},
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'final',
              name: REPORT_FINDINGS_NAME,
              input: {
                outcome: 'conclusive',
                summary: 'checked',
                confidence: 70,
                unknowns: [
                  {
                    question: 'The configuration check returned only partial data.',
                    category: 'partial_evidence',
                    evidenceKind: 'runtime_configuration',
                    attemptedEvidenceIds: [evidenceId],
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
          assistantMsg: {},
        };
      },
      toolResultMsgs: (results) => {
        toolResults.push(...results);
        return results;
      },
    };
    const context = __fixture.ctx();
    context.audit = { record: async () => evidenceId };

    const result = await runLoop({
      ...base,
      provider,
      ctx: context,
      path: 'investigate',
      tools: [__fixture.uniformArrayTool()],
      maxTurns: 4,
      terminals: [REPORT_FINDINGS_NAME],
    });

    expect(turn).toBe(3);
    expect(toolResults.find((item) => item.id === 'draft')?.content).toContain(
      'machine-checkable questions',
    );
    expect(result).toMatchObject({
      summary: 'checked',
      unknowns: [
        {
          category: 'partial_evidence',
          attemptedEvidenceIds: [evidenceId],
        },
      ],
    });
  });

  it('returns a result for every sibling tool call when challenging a draft', async () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    let turn = 0;
    const toolResults: ToolRunResult[] = [];
    const provider: LoopProvider = {
      toolSpecs: () => [],
      userMsg: (text) => text,
      call: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'draft',
                name: REPORT_FINDINGS_NAME,
                input: {
                  outcome: 'inconclusive',
                  summary: 'draft',
                  confidence: 40,
                  unknowns: [
                    {
                      question: 'Which configuration is active?',
                      category: 'observable',
                      evidenceKind: 'runtime_configuration',
                      attemptedEvidenceIds: [],
                    },
                  ],
                },
              },
              { id: 'check', name: 'evidence_tool', input: {} },
            ],
            stopReason: 'tool_use',
            assistantMsg: {},
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'final',
              name: REPORT_FINDINGS_NAME,
              input: {
                outcome: 'conclusive',
                summary: 'checked',
                confidence: 70,
                unknowns: [
                  {
                    question: 'The configuration check returned only partial data.',
                    category: 'partial_evidence',
                    evidenceKind: 'runtime_configuration',
                    attemptedEvidenceIds: [evidenceId],
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
          assistantMsg: {},
        };
      },
      toolResultMsgs: (results) => {
        toolResults.push(...results);
        return results;
      },
    };
    const context = __fixture.ctx();
    context.audit = { record: async () => evidenceId };

    const result = await runLoop({
      ...base,
      provider,
      ctx: context,
      path: 'investigate',
      tools: [__fixture.uniformArrayTool()],
      maxTurns: 4,
      terminals: [REPORT_FINDINGS_NAME],
    });

    expect(toolResults.map((item) => item.id)).toEqual(['draft', 'check']);
    expect(toolResults.find((item) => item.id === 'check')?.content).toContain(evidenceId);
    expect(result).toMatchObject({ summary: 'checked' });
  });

  it('defers an otherwise valid conclusion until its sibling evidence calls finish', async () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    let turn = 0;
    const toolResults: ToolRunResult[] = [];
    const provider: LoopProvider = {
      toolSpecs: () => [],
      userMsg: (text) => text,
      call: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'draft',
                name: REPORT_FINDINGS_NAME,
                input: {
                  outcome: 'conclusive',
                  summary: 'premature',
                  confidence: 55,
                  unknowns: [],
                },
              },
              { id: 'check', name: 'evidence_tool', input: {} },
            ],
            stopReason: 'tool_use',
            assistantMsg: {},
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'final',
              name: REPORT_FINDINGS_NAME,
              input: {
                outcome: 'conclusive',
                summary: 'evidence checked',
                confidence: 75,
                evidenceIds: [evidenceId],
                unknowns: [],
              },
            },
          ],
          stopReason: 'tool_use',
          assistantMsg: {},
        };
      },
      toolResultMsgs: (results) => {
        toolResults.push(...results);
        return results;
      },
    };
    const context = __fixture.ctx();
    context.audit = { record: async () => evidenceId };

    const result = await runLoop({
      ...base,
      provider,
      ctx: context,
      path: 'investigate',
      tools: [__fixture.uniformArrayTool()],
      maxTurns: 4,
      terminals: [REPORT_FINDINGS_NAME],
    });

    expect(turn).toBe(2);
    expect(toolResults.map((item) => item.id)).toEqual(['draft', 'check']);
    expect(toolResults.find((item) => item.id === 'check')?.content).toContain(evidenceId);
    expect(result).toMatchObject({ summary: 'evidence checked', evidenceIds: [evidenceId] });
  });

  it('respond → disposition reply carrying summary (takeaway) + detail (full reply)', async () => {
    const { provider } = terminalProvider(RESPOND_NAME, {
      summary: 'not a new root cause',
      detail: 'The DB pool is fine; the earlier deploy is still the leading cause.',
    });
    const result = await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      terminals: [REPORT_FINDINGS_NAME, RESPOND_NAME, STAY_SILENT_NAME],
    });
    expect(result.disposition).toBe('reply');
    expect(result.summary).toBe('not a new root cause');
    expect(result.detail).toBe(
      'The DB pool is fine; the earlier deploy is still the leading cause.',
    );
  });

  it('stay_silent → disposition silent with the reason as summary', async () => {
    const { provider } = terminalProvider(STAY_SILENT_NAME, { reason: 'ack only, nothing to add' });
    const result = await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      terminals: [REPORT_FINDINGS_NAME, RESPOND_NAME, STAY_SILENT_NAME],
    });
    expect(result.disposition).toBe('silent');
    expect(result.summary).toBe('ack only, nothing to add');
  });

  it('stay_silent with no reason → disposition silent with an empty summary', async () => {
    const { provider } = terminalProvider(STAY_SILENT_NAME, {});
    const result = await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      terminals: [REPORT_FINDINGS_NAME, RESPOND_NAME, STAY_SILENT_NAME],
    });
    expect(result.disposition).toBe('silent');
    expect(result.summary).toBe('');
  });
});
