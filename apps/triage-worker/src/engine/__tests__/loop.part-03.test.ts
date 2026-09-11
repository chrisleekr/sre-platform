// Phase A RED: a dispatched tool result is rendered to the model as TOON
// (lossless re-encode, ~40% fewer tokens on uniform arrays), capped at the raised env budget
// TOOL_RESULT_MAX_CHARS, isError=false. Today renderToolResult emits JSON.stringify sliced at a hard
// 1500 chars, so the TOON-shape assertion and the raised-cap assertion are both RED.
import { describe, expect, it, vi } from 'vitest';

import { makeInMemoryAuditSink, type ToolDefinition } from '@sre/agent-tools';

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
    const terminalInput =
      name === REPORT_FINDINGS_NAME && input && typeof input === 'object'
        ? { outcome: 'conclusive', ...input }
        : input;
    const provider: LoopProvider = {
      toolSpecs: (tools) => {
        captured = tools;
        return [];
      },
      userMsg: (text) => ({ role: 'user', content: text }),
      call: async () => ({
        text: '',
        toolCalls: name ? [{ id: 'x', name, input: terminalInput }] : [],
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

  const SUGGEST_ACTION_NAME = 'suggest_action';

  const options = [
    { id: 'approve', label: 'Approve' },
    { id: 'deny', label: 'Deny' },
  ];

  const recommendation = {
    level: 'L2',
    explanation: 'The checkout pods are wedged after the latest deployment.',
    action: 'kubectl rollout undo deployment/checkout',
  };

  const recommendedAction = (input: typeof recommendation) =>
    `Recommended Action (${input.level})\n\n${input.explanation}\n\nCommand or rollback reference:\n${input.action}`;

  type ApprovalResult = {
    disposition?: string;
    approval?: { prompt: string; options: { id: string; label: string }[] };
  };

  /**
   * A provider that mints a FRESH tool-call id on EVERY model call (`toolu_1`, `toolu_2`, …), exactly as
   * the Anthropic API does — the counter is shared across providers, so a redelivery (a second runLoop)
   * never sees the id the first one got. The previous fake returned a hardcoded id forever, so it could
   * not simulate a redelivery at all and any idempotency assertion against it passed for free.
   */
  let toolCallSeq = 0;

  function approvalProvider(input: typeof recommendation): {
    provider: LoopProvider;
    ids: () => string[];
    toolResultMsgs: ReturnType<typeof vi.fn>;
  } {
    const ids: string[] = [];
    const toolResultMsgs = vi.fn((results: ToolRunResult[]) => [
      { role: 'user', content: results },
    ]);
    const provider: LoopProvider = {
      toolSpecs: () => [],
      userMsg: (text) => ({ role: 'user', content: text }),
      call: async () => {
        toolCallSeq += 1;
        const id = `toolu_${toolCallSeq}`;
        ids.push(id);
        return {
          text: '',
          toolCalls: [{ id, name: SUGGEST_ACTION_NAME, input }],
          stopReason: 'tool_use',
          assistantMsg: {},
        };
      },
      toolResultMsgs,
    };
    return { provider, ids: () => ids, toolResultMsgs };
  }

  const runApproval = async (provider: LoopProvider): Promise<ApprovalResult> =>
    (await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      // Recommended actions are resume-only terminals.
      terminals: [
        REPORT_FINDINGS_NAME,
        RESPOND_NAME,
        STAY_SILENT_NAME,
        SUGGEST_ACTION_NAME,
      ] as unknown as Parameters<typeof runLoop>[0]['terminals'],
    })) as unknown as ApprovalResult;

  it('rejects stay_silent after an evidence tool and requires a visible conclusion', async () => {
    let turn = 0;
    const terminalFeedback: ToolRunResult[] = [];
    const provider: LoopProvider = {
      toolSpecs: () => [],
      userMsg: (text) => text,
      call: async () => {
        turn += 1;
        if (turn === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'evidence', name: 'evidence_tool', input: {} }],
            stopReason: 'tool_use',
            assistantMsg: {},
          };
        }
        if (turn === 2) {
          return {
            text: '',
            toolCalls: [
              {
                id: 'silent',
                name: STAY_SILENT_NAME,
                input: { reason: 'Nothing to add.' },
              },
            ],
            stopReason: 'tool_use',
            assistantMsg: {},
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'reply',
              name: RESPOND_NAME,
              input: { summary: 'Checked', detail: 'I checked the current evidence.' },
            },
          ],
          stopReason: 'tool_use',
          assistantMsg: {},
        };
      },
      toolResultMsgs: (results) => {
        terminalFeedback.push(...results);
        return results;
      },
    };

    const result = await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      tools: [__fixture.uniformArrayTool()],
      maxTurns: 4,
      terminals: [REPORT_FINDINGS_NAME, RESPOND_NAME, STAY_SILENT_NAME],
    });

    expect(result).toMatchObject({
      disposition: 'reply',
      summary: 'Checked',
      detail: 'I checked the current evidence.',
    });
    expect(terminalFeedback.find((item) => item.id === 'silent')?.content).toMatch(
      /visible conclusion/i,
    );
  });

  it('initial-triage early stop returns inconclusive, not a generic RCA', async () => {
    const { provider } = terminalProvider(null, null);
    const result = await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      maxTurns: 2,
      path: 'investigate',
      terminals: [REPORT_FINDINGS_NAME],
    });
    expect(result).toMatchObject({ outcome: 'inconclusive' });
    expect(result.disposition).not.toBe('rca');
  });

  it('resume early stop returns the same inconclusive outcome without an RCA disposition', async () => {
    const { provider } = terminalProvider(null, null);
    const result = await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      maxTurns: 2,
      terminals: [REPORT_FINDINGS_NAME, RESPOND_NAME, STAY_SILENT_NAME],
    });
    expect(result).toMatchObject({ outcome: 'inconclusive' });
    expect(result.disposition).not.toBe('rca');
  });

  it('intercepts a valid suggested action into canonical content and fixed decisions', async () => {
    const { provider, toolResultMsgs } = approvalProvider(recommendation);
    const r = await runApproval(provider);

    expect(r.disposition).toBe('approval');
    expect(r.approval).toEqual({ prompt: recommendedAction(recommendation), options });
    expect(toolResultMsgs).not.toHaveBeenCalled();
    expect((r as { toolCallId?: string }).toolCallId).toBeUndefined();
    expect((r.approval as { actionId?: string }).actionId).toBeUndefined();
  });

  it('a redelivered recommendation ignores fresh provider call IDs', async () => {
    const first = approvalProvider(recommendation);
    const second = approvalProvider(recommendation);
    const a = await runApproval(first.provider);
    const b = await runApproval(second.provider);

    expect(second.ids()[0]).not.toBe(first.ids()[0]);
    expect(b.approval).toEqual(a.approval);
    expect(b.approval).toEqual({ prompt: recommendedAction(recommendation), options });
  });

  it('different action bytes produce different approval proposals', async () => {
    const changed = { ...recommendation, action: 'rollback: deploy-2026-08-13.2' };
    const { provider: p1 } = approvalProvider(recommendation);
    const { provider: p2 } = approvalProvider(changed);
    const a = await runApproval(p1);
    const b = await runApproval(p2);

    expect(b.approval).not.toEqual(a.approval);
    expect(b.approval!.prompt).toBe(recommendedAction(changed));
  });

  it('returns fixed feedback for a schema-invalid suggestion, then accepts a valid one without audit', async () => {
    const audit = makeInMemoryAuditSink();
    const rendered: ToolRunResult[] = [];
    let turn = 0;
    const provider: LoopProvider = {
      toolSpecs: () => [],
      userMsg: (text) => ({ role: 'user', content: text }),
      call: async () => {
        turn += 1;
        return {
          text: '',
          toolCalls: [
            {
              id: `toolu_${turn}`,
              name: SUGGEST_ACTION_NAME,
              // prettier-ignore
              input:
                turn === 1
                  ? { level: 'L1', explanation: '   ', action: '' }
                  : recommendation,
            },
          ],
          stopReason: 'tool_use',
          assistantMsg: {},
        };
      },
      toolResultMsgs: (results) => {
        rendered.push(...results);
        return [{ role: 'user', content: results }];
      },
    };
    const result = (await runLoop({
      ...base,
      provider,
      ctx: { ...__fixture.ctx(), audit },
      terminals: [
        REPORT_FINDINGS_NAME,
        RESPOND_NAME,
        STAY_SILENT_NAME,
        SUGGEST_ACTION_NAME,
      ] as unknown as Parameters<typeof runLoop>[0]['terminals'],
    })) as unknown as ApprovalResult;

    expect(rendered).toEqual([
      { id: 'toolu_1', content: 'error: invalid tool input', isError: true },
    ]);
    expect(audit.records).toEqual([]);
    expect(result.approval).toEqual({ prompt: recommendedAction(recommendation), options });
  });

  it('path drives the typed inconclusive outcome when suggest_action is the only resume terminal', async () => {
    const { provider } = terminalProvider(null, null);
    const result = await runLoop({
      ...base,
      provider,
      ctx: __fixture.ctx(),
      maxTurns: 2,
      path: 'resume',
      terminals: [SUGGEST_ACTION_NAME] as unknown as Parameters<typeof runLoop>[0]['terminals'],
    });
    expect(result).toMatchObject({ outcome: 'inconclusive' });
    expect(result.disposition).not.toBe('rca');
  });
});
