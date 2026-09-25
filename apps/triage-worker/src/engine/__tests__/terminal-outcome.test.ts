import { describe, expect, test, vi } from 'vitest';

import { makeInMemoryAuditSink, type ToolDefinition } from '@sre/agent-tools';

import * as z from 'zod';

import { degradedResult } from '../agent-sdk/tools';
import { runLoop, type LoopProvider, type ModelTurn, type TerminalName } from '../loop';
import { REPORT_FINDINGS_NAME } from '../report-findings';
import { REPORT_RECOVERY_NAME } from '../report-recovery';
import { RESPOND_NAME } from '../respond';
import { STAY_SILENT_NAME } from '../stay-silent';
import { SUGGEST_ACTION_NAME } from '../suggest-action';

describe('terminal investigation outcomes', () => {
  test.each(['investigate', 'resume', 'recovery'] as const)(
    'a %s ordinary stop is inconclusive, never a fallback disposition',
    (path) => {
      const result = degradedResult(path, 'anthropic', 'session-1', 'claude-test');

      expect(result).toMatchObject({ outcome: 'inconclusive' });
      expect(result.disposition).not.toBe('rca');
      expect(result.disposition).not.toBe('recovery');
    },
  );

  test.each([
    { path: 'investigate' as const, terminals: [REPORT_FINDINGS_NAME] as TerminalName[] },
    {
      path: 'resume' as const,
      terminals: [
        REPORT_FINDINGS_NAME,
        RESPOND_NAME,
        STAY_SILENT_NAME,
        SUGGEST_ACTION_NAME,
      ] as TerminalName[],
    },
    { path: 'recovery' as const, terminals: [REPORT_RECOVERY_NAME] as TerminalName[] },
  ])('the shared $path loop reports budget exhaustion at its real turn cap', async (scenario) => {
    const calls: Array<{ forceTool: string | undefined }> = [];
    const provider: LoopProvider = {
      toolSpecs: (tools) => tools.map((tool) => tool.name),
      userMsg: (text) => ({ role: 'user', content: text }),
      call: async (_system, _messages, _specs, forceTool): Promise<ModelTurn> => {
        calls.push({ forceTool });
        return {
          text: '',
          toolCalls: [{ id: `unknown-${calls.length}`, name: 'unbound_tool', input: {} }],
          stopReason: 'tool_use',
          assistantMsg: { role: 'assistant', tool: 'unbound_tool' },
        };
      },
      toolResultMsgs: (results) => [{ role: 'tool', results }],
    };

    const result = await runLoop({
      provider,
      system: 'system',
      initialUser: scenario.path,
      tools: [],
      ctx: {
        tenantId: 'tenant-1',
        incidentId: 'incident-1',
        service: 'checkout',
        resolveConnectors: async () => [],
        audit: makeInMemoryAuditSink(),
      },
      onStep: async () => undefined,
      maxTurns: 2,
      path: scenario.path,
      engineProvider: 'test',
      sessionId: 'test:incident-1',
      model: 'test-model',
      terminals: scenario.terminals,
    });

    expect(calls).toEqual([{ forceTool: undefined }, { forceTool: undefined }]);
    expect(result).toMatchObject({ outcome: 'budget_exhausted', turnBudget: 2 });
    expect(result.disposition).toBeUndefined();
  });

  test('uses one evidence-only finalizer outside the exploration budget', async () => {
    const evidenceTool: ToolDefinition<Record<string, never>, { errorRate: number }> = {
      name: 'query_metrics',
      description: 'Read the current error rate.',
      inputSchema: z.object({}),
      handler: vi.fn(async () => ({ available: true as const, data: { errorRate: 0.42 } })),
    };
    const calls: Array<{
      messages: unknown[];
      specs: string[];
      forceTool: string | undefined;
    }> = [];
    const provider: LoopProvider = {
      toolSpecs: (tools) => tools.map((tool) => tool.name),
      userMsg: (text) => ({ role: 'user', content: text }),
      call: async (_system, messages, specs, forceTool): Promise<ModelTurn> => {
        calls.push({ messages: [...messages], specs: specs as string[], forceTool });
        if (calls.length === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'evidence-1', name: evidenceTool.name, input: {} }],
            stopReason: 'tool_use',
            assistantMsg: { role: 'assistant', tool: evidenceTool.name },
          };
        }
        return {
          text: '',
          toolCalls: [
            {
              id: 'final-1',
              name: REPORT_FINDINGS_NAME,
              input: {
                outcome: 'conclusive',
                summary: 'The error-rate evidence is conclusive.',
                confidence: 80,
                rankedHypotheses: [],
                unknowns: [],
              },
            },
          ],
          stopReason: 'tool_use',
          assistantMsg: { role: 'assistant', tool: REPORT_FINDINGS_NAME },
        };
      },
      toolResultMsgs: (results) => [{ role: 'tool', results }],
    };

    const result = await runLoop({
      provider,
      system: 'system',
      initialUser: 'investigate',
      tools: [evidenceTool],
      ctx: {
        tenantId: 'tenant-1',
        incidentId: 'incident-1',
        service: 'checkout',
        resolveConnectors: async () => [],
        audit: makeInMemoryAuditSink(),
      },
      onStep: async () => undefined,
      maxTurns: 1,
      path: 'investigate',
      engineProvider: 'test',
      sessionId: 'test:incident-1',
      model: 'test-model',
      terminals: [REPORT_FINDINGS_NAME],
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.specs).toEqual(
      expect.arrayContaining([evidenceTool.name, REPORT_FINDINGS_NAME]),
    );
    expect(calls[1]).toMatchObject({
      specs: [REPORT_FINDINGS_NAME, 'read_recorded_evidence'],
      forceTool: undefined,
    });
    expect(JSON.stringify(calls[1]!.messages)).toContain('evidenceId');
    expect(evidenceTool.handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: 'conclusive',
      disposition: 'rca',
      summary: 'The error-rate evidence is conclusive.',
    });
  });

  test.each([
    {
      path: 'resume' as const,
      terminals: [
        REPORT_FINDINGS_NAME,
        RESPOND_NAME,
        STAY_SILENT_NAME,
        SUGGEST_ACTION_NAME,
      ] as TerminalName[],
      finalName: RESPOND_NAME,
      finalInput: {
        summary: 'Checked the evidence.',
        detail: 'The current error rate is elevated.',
      },
      expectedFinalizers: [REPORT_FINDINGS_NAME, RESPOND_NAME, SUGGEST_ACTION_NAME].sort(),
      expectedDisposition: 'reply',
    },
    {
      path: 'resume' as const,
      terminals: [
        REPORT_FINDINGS_NAME,
        REPORT_RECOVERY_NAME,
        RESPOND_NAME,
        STAY_SILENT_NAME,
        SUGGEST_ACTION_NAME,
      ] as TerminalName[],
      finalName: REPORT_RECOVERY_NAME,
      finalInput: {
        outcome: 'recovered',
        summary: 'Current checks confirm recovery.',
        questions: [],
        evidence: [{ name: 'Error rate', before: 'high', now: 'normal' }],
        evidenceIds: ['11111111-1111-4111-8111-111111111111'],
        unknowns: [],
        nextStep: null,
        recheckAfterMinutes: null,
        scheduleReason: null,
      },
      expectedFinalizers: [
        REPORT_FINDINGS_NAME,
        REPORT_RECOVERY_NAME,
        RESPOND_NAME,
        SUGGEST_ACTION_NAME,
      ].sort(),
      expectedDisposition: 'recovery',
    },
    {
      path: 'recovery' as const,
      terminals: [REPORT_RECOVERY_NAME] as TerminalName[],
      finalName: REPORT_RECOVERY_NAME,
      finalInput: {
        outcome: 'recovered',
        summary: 'Current checks confirm recovery.',
        questions: [],
        evidence: [{ name: 'Error rate', before: 'high', now: 'normal' }],
        evidenceIds: ['11111111-1111-4111-8111-111111111111'],
        unknowns: [],
        nextStep: null,
        recheckAfterMinutes: null,
        scheduleReason: null,
      },
      expectedFinalizers: [REPORT_RECOVERY_NAME],
      expectedDisposition: 'recovery',
    },
  ])('gives the $path finalizer every permitted terminal and no connector', async (scenario) => {
    const evidenceTool: ToolDefinition<Record<string, never>, { value: number }> = {
      name: 'read_signal',
      description: 'Read a signal.',
      inputSchema: z.object({}),
      handler: async () => ({ available: true as const, data: { value: 1 } }),
    };
    const specs: string[][] = [];
    const provider: LoopProvider = {
      toolSpecs: (tools) => tools.map((tool) => tool.name),
      userMsg: (text) => ({ role: 'user', content: text }),
      call: async (_system, _messages, tools): Promise<ModelTurn> => {
        specs.push(tools as string[]);
        return specs.length === 1
          ? {
              text: '',
              toolCalls: [{ id: 'read-1', name: evidenceTool.name, input: {} }],
              stopReason: 'tool_use',
              assistantMsg: { role: 'assistant', tool: evidenceTool.name },
            }
          : {
              text: '',
              toolCalls: [{ id: 'final-1', name: scenario.finalName, input: scenario.finalInput }],
              stopReason: 'tool_use',
              assistantMsg: { role: 'assistant', tool: scenario.finalName },
            };
      },
      toolResultMsgs: (results) => [{ role: 'tool', results }],
    };

    const result = await runLoop({
      provider,
      system: 'system',
      initialUser: `original ${scenario.path} task`,
      tools: [evidenceTool],
      ctx: {
        tenantId: 'tenant-1',
        incidentId: 'incident-1',
        service: 'checkout',
        resolveConnectors: async () => [],
        audit: { record: async () => '11111111-1111-4111-8111-111111111111' },
      },
      onStep: async () => undefined,
      maxTurns: 1,
      path: scenario.path,
      engineProvider: 'test',
      sessionId: 'test:incident-1',
      model: 'test-model',
      terminals: scenario.terminals,
    });

    expect(specs).toHaveLength(2);
    expect([...specs[1]!].sort()).toEqual(
      [...scenario.expectedFinalizers, 'read_recorded_evidence'].sort(),
    );
    expect(specs[1]).not.toContain(evidenceTool.name);
    expect(result).toMatchObject({
      outcome: 'conclusive',
      disposition: scenario.expectedDisposition,
    });
  });

  test('classifies a structured missing-capability conclusion without promoting an RCA', async () => {
    const provider: LoopProvider = {
      toolSpecs: (tools) => tools.map((tool) => tool.name),
      userMsg: (text) => text,
      call: async () => ({
        text: '',
        toolCalls: [
          {
            id: 'final-1',
            name: REPORT_FINDINGS_NAME,
            input: {
              outcome: 'blocked_missing_capability',
              summary: 'Logs are required but no log connector is configured.',
              confidence: 0,
              rankedHypotheses: [],
              unknowns: [
                {
                  question: 'What error did the service emit?',
                  category: 'missing_capability',
                  evidenceKind: 'logs',
                  attemptedEvidenceIds: [],
                },
              ],
            },
          },
        ],
        stopReason: 'tool_use',
        assistantMsg: {},
      }),
      toolResultMsgs: () => [],
    };
    const result = await runLoop({
      provider,
      system: 'system',
      initialUser: 'investigate',
      tools: [],
      ctx: {
        tenantId: 'tenant-1',
        incidentId: 'incident-1',
        service: 'checkout',
        resolveConnectors: async () => [],
        audit: makeInMemoryAuditSink(),
      },
      onStep: async () => undefined,
      maxTurns: 1,
      path: 'investigate',
      engineProvider: 'test',
      sessionId: 'test:incident-1',
      terminals: [REPORT_FINDINGS_NAME],
    });
    expect(result).toMatchObject({ outcome: 'blocked_missing_capability' });
    expect(result.disposition).not.toBe('rca');
  });

  test('marks invalid finalizer output failed and lets infrastructure failures reject', async () => {
    const evidenceTool: ToolDefinition<Record<string, never>, { value: number }> = {
      name: 'read_signal',
      description: 'Read a signal.',
      inputSchema: z.object({}),
      handler: async () => ({ available: true as const, data: { value: 1 } }),
    };
    const run = (failure: 'invalid' | 'throw') => {
      let calls = 0;
      const provider: LoopProvider = {
        toolSpecs: (tools) => tools.map((tool) => tool.name),
        userMsg: (text) => text,
        call: async () => {
          calls += 1;
          if (calls === 1)
            return {
              text: '',
              toolCalls: [{ id: 'read-1', name: evidenceTool.name, input: {} }],
              stopReason: 'tool_use',
              assistantMsg: {},
            };
          if (failure === 'throw') throw new Error('provider unavailable');
          return { text: '', toolCalls: [], stopReason: 'stop', assistantMsg: {} };
        },
        toolResultMsgs: () => [],
      };
      return runLoop({
        provider,
        system: 'system',
        initialUser: 'investigate',
        tools: [evidenceTool],
        ctx: {
          tenantId: 'tenant-1',
          incidentId: 'incident-1',
          service: 'checkout',
          resolveConnectors: async () => [],
          audit: makeInMemoryAuditSink(),
        },
        onStep: async () => undefined,
        maxTurns: 1,
        path: 'investigate',
        engineProvider: 'test',
        sessionId: 'test:incident-1',
        terminals: [REPORT_FINDINGS_NAME],
      });
    };

    await expect(run('invalid')).resolves.toMatchObject({ outcome: 'failed' });
    await expect(run('throw')).rejects.toThrow('provider unavailable');
  });
});
