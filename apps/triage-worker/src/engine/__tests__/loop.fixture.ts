// Phase A RED: a dispatched tool result is rendered to the model as TOON
// (lossless re-encode, ~40% fewer tokens on uniform arrays), capped at the raised env budget
// TOOL_RESULT_MAX_CHARS, isError=false. Today renderToolResult emits JSON.stringify sliced at a hard
// 1500 chars, so the TOON-shape assertion and the raised-cap assertion are both RED.
import { makeInMemoryAuditSink, type ToolContext, type ToolDefinition } from '@sre/agent-tools';
import * as z from 'zod';
import { type LoopProvider, type ModelTurn, type ToolRunResult } from '../loop';
import { REPORT_FINDINGS_NAME } from '../report-findings';

export function createFixture() {
  const RAISED_CAP = 4000;

  function ctx(): ToolContext {
    return {
      tenantId: 't',
      incidentId: 'inc-1',
      service: 'checkout',
      resolveConnectors: async () => [],
      audit: makeInMemoryAuditSink(),
    };
  }

  // A tool that returns a large UNIFORM array of objects — the shape TOON encodes as a tabular
  // `[N]{fields}:` header + rows. No connector needed; the handler returns data directly.
  function uniformArrayTool(): ToolDefinition<Record<string, never>, unknown> {
    return {
      name: 'evidence_tool',
      description: 'returns a uniform array of log rows',
      inputSchema: z.object({}),
      async handler() {
        const rows = Array.from({ length: 200 }, (_, i) => ({
          idx: i,
          level: 'info',
          msg: `log line ${i}`,
        }));
        return { available: true, data: rows };
      },
    };
  }

  // Scripts the model: turn 1 calls the tool, turn 2 concludes via report_findings (intercepted).
  function scriptedProvider(): { provider: LoopProvider; rendered: ToolRunResult[] } {
    const rendered: ToolRunResult[] = [];
    let turn = 0;
    const turnOf = (): ModelTurn => {
      turn += 1;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [{ id: 't1', name: 'evidence_tool', input: {} }],
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
              summary: 'done',
              confidence: 50,
              rankedHypotheses: [],
            },
          },
        ],
        stopReason: 'tool_use',
        assistantMsg: {},
      };
    };
    const provider: LoopProvider = {
      toolSpecs: () => [],
      userMsg: (text) => ({ role: 'user', content: text }),
      call: async () => turnOf(),
      toolResultMsgs: (results) => {
        rendered.push(...results);
        return [{ role: 'user', content: results }];
      },
    };
    return { provider, rendered };
  }

  return {
    RAISED_CAP,
    ctx,
    uniformArrayTool,
    scriptedProvider,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
