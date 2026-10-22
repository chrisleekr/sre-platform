import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { RECORD_LEARNING_NAME, type ToolContext, type ToolDefinition } from '@sre/agent-tools';
import { runLoop, type LoopProvider, type ModelTurn, type ToolCall } from '../loop';
import { makeAgentSdkEngine } from '../agent-sdk';
import { REPORT_FINDINGS_NAME } from '../report-findings';
import { RESPOND_NAME } from '../respond';
import { STAY_SILENT_NAME } from '../stay-silent';
import { createFixture as createLoopFixture } from './loop.fixture';
import { createFixture as createSdkFixture } from './agent-sdk.fixture';

// record_learning writes to shared memory but reads nothing about the incident, so it is not
// evidence: it must not force a visible reply, bounce a conclusion emitted beside it, or close an
// evidence gap.
const loopFixture = createLoopFixture();
const sdkFixture = createSdkFixture();
const LEARNING_EVIDENCE_ID = '33333333-3333-4333-8333-333333333333';
const learningInput = {
  topic: 'etcd data disk',
  statement: 'etcd data is on /dev/nvme0n1p3',
  basis: 'hypothesis',
};

function learningTool() {
  const handler = vi.fn(async () => ({
    available: true as const,
    data: { recorded: true, action: 'created' },
  }));
  const tool: ToolDefinition<Record<string, unknown>, unknown> = {
    name: RECORD_LEARNING_NAME,
    description: 'stub',
    inputSchema: z.object({ topic: z.string(), statement: z.string(), basis: z.string() }),
    handler,
  };
  return { tool, handler };
}

function scripted(turns: ToolCall[][]): { provider: LoopProvider; calls: () => number } {
  let turn = 0;
  return {
    calls: () => turn,
    provider: {
      toolSpecs: () => [],
      userMsg: (text) => text,
      call: async (): Promise<ModelTurn> => ({
        text: '',
        toolCalls: turns[Math.min(turn++, turns.length - 1)]!,
        stopReason: 'tool_use',
        assistantMsg: {},
      }),
      toolResultMsgs: (results) => results,
    },
  };
}

const learn: ToolCall = { id: 'learn', name: RECORD_LEARNING_NAME, input: learningInput };

async function resume(provider: LoopProvider, tool: ToolDefinition<any, any>) {
  const context = loopFixture.ctx();
  context.audit = { record: async () => LEARNING_EVIDENCE_ID };
  return runLoop({
    provider,
    system: 'sys',
    initialUser: 'go',
    tools: [tool],
    ctx: context,
    onStep: async () => {},
    maxTurns: 6,
    path: 'resume',
    engineProvider: 'test',
    sessionId: 'test:inc-1',
    terminals: [REPORT_FINDINGS_NAME, RESPOND_NAME, STAY_SILENT_NAME],
  });
}

describe('side-effect tools in the loop', () => {
  test('a run that only recorded a learning may stay silent', async () => {
    const { tool, handler } = learningTool();
    const silent = { id: 'silent', name: STAY_SILENT_NAME, input: { reason: 'Nothing to add.' } };
    const { provider, calls } = scripted([[learn], [silent]]);
    await expect(resume(provider, tool)).resolves.toMatchObject({ disposition: 'silent' });
    expect(calls()).toBe(2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('a learning beside a reply runs once and the reply stands', async () => {
    const { tool, handler } = learningTool();
    const reply = {
      id: 'reply',
      name: RESPOND_NAME,
      input: { summary: 'Noted', detail: 'Saved for next time.' },
    };
    const { provider, calls } = scripted([[reply, learn]]);
    await expect(resume(provider, tool)).resolves.toMatchObject({
      disposition: 'reply',
      evidenceReceipts: [],
    });
    expect(calls()).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('a learning id cannot close an evidence gap', async () => {
    const { tool } = learningTool();
    const findings = (summary: string) => ({
      id: summary,
      name: REPORT_FINDINGS_NAME,
      input: {
        outcome: 'inconclusive',
        summary,
        confidence: 30,
        unknowns: [
          {
            question: 'Which device backs etcd?',
            category: 'observable',
            evidenceKind: 'runtime_configuration',
            attemptedEvidenceIds: [LEARNING_EVIDENCE_ID],
          },
        ],
      },
    });
    const { provider } = scripted([[learn], [findings('draft')], [findings('final')]]);
    await expect(resume(provider, tool)).resolves.toMatchObject({ summary: 'final' });
  });
});

describe('side-effect tools in the Agent SDK runtime', () => {
  test('a learning beside stay_silent neither blocks it nor splits the turn', async () => {
    const { tool, handler } = learningTool();
    const silence = { reason: 'Nothing to add.' };
    const engine = makeAgentSdkEngine({
      runtime: sdkFixture.runtime,
      credential: 'provider-key',
      query: sdkFixture.mcpQuery(
        async (client) => {
          await client.callTool({ name: RECORD_LEARNING_NAME, arguments: learningInput });
          const accepted = await client.callTool({ name: 'stay_silent', arguments: silence });
          expect(JSON.stringify(accepted.content)).toContain('conclusion recorded');
        },
        sdkFixture.assistantToolTurn('learn-and-silence', [
          { name: RECORD_LEARNING_NAME, input: learningInput },
          { name: 'stay_silent', input: silence },
        ]),
      ),
    });

    await expect(
      engine.resume(
        {
          incident: {
            id: 'incident-1',
            tenantId: 'tenant-1',
            service: 'etcd',
            severity: 'sev2',
            fingerprint: 'fingerprint',
            alertSource: 'test',
          },
          humanMessage: 'Remember this.',
          prior: [],
        },
        {
          tools: [tool],
          ctx: {
            tenantId: 'tenant-1',
            incidentId: 'incident-1',
            service: 'etcd',
            resolveConnectors: async () => [],
            audit: { record: async () => LEARNING_EVIDENCE_ID },
          } as ToolContext,
          signal: new AbortController().signal,
          onStep: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({ disposition: 'silent', evidenceReceipts: [] });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
