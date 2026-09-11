import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ToolDefinition } from '@sre/agent-tools';
import { randomUUID } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { makeAgentSdkEngine } from '../engine/agent-sdk';
import { createFixture } from '../engine/__tests__/agent-sdk.fixture';
import type { TriageInput, TriageRuntime } from '../engine/types';
import { publicModelText } from '../public-output';

const fixture = createFixture();
const input: TriageInput = {
  incident: {
    id: randomUUID(),
    tenantId: randomUUID(),
    service: 'checkout',
    severity: 'sev2',
    fingerprint: 'checkout-failure',
    alertSource: 'alertmanager',
  },
};

/** Bind inert tools and a recording progress sink without contacting providers.
 * @param tools - Scripted read-only evidence tools.
 */
function runtime(tools: ToolDefinition<any, any>[] = []): TriageRuntime {
  return {
    tools,
    ctx: {
      tenantId: input.incident.tenantId,
      incidentId: input.incident.id,
      service: input.incident.service,
      resolveConnectors: async () => [],
      audit: { record: async () => randomUUID() },
    },
    signal: new AbortController().signal,
    onStep: vi.fn(async () => undefined),
  };
}

describe('evidence-faithful investigation', () => {
  test('finalization retains access to decisive logs preceding large historical results', async () => {
    const marker = 'migration checksum mismatch: expected aaa, observed bbb';
    const tools = [
      { name: 'read_failure', data: { logs: marker, sync: 'Failed' } },
      { name: 'read_history', data: { oldSuccessfulBuilds: 'historical success '.repeat(4_000) } },
    ].map(({ name, data }): ToolDefinition<any, any> => ({
      name,
      description: 'Read recorded deployment evidence.',
      inputSchema: z.object({ page: z.number().optional() }),
      handler: async () => ({ available: true, data }),
    }));
    let calls = 0;
    let finalPrompt = '';
    let finalTools: string[] = [];
    const explore = fixture.mcpQuery(async (client) => {
      await client.callTool({ name: 'read_failure', arguments: {} });
      for (let page = 0; page < 8; page += 1) {
        await client.callTool({ name: 'read_history', arguments: { page } });
      }
    });
    const finalize = fixture.mcpQuery(
      async (client) => {
        finalTools = (await client.listTools()).tools.map((tool) => tool.name);
      },
      [],
      (params) => {
        finalPrompt = String(params.prompt);
      },
    );
    const engine = makeAgentSdkEngine({
      runtime: fixture.runtime,
      credential: 'fixture-key',
      query: (params) => (++calls === 1 ? explore(params) : finalize(params)),
    });
    await engine.investigate(input, runtime(tools));
    expect(calls).toBe(2);
    const canReadRecordedEvidence = finalTools.some((name) =>
      /(?:read|retrieve).*evidence/.test(name),
    );
    expect(finalPrompt.includes(marker) || canReadRecordedEvidence).toBe(true);
    expect(finalTools).not.toContain('read_history');
  });

  test('assistant progress is published while the SDK stream is still running', async () => {
    let release!: () => void;
    let observed!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedPause = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const progress = 'Checking current pod logs.';
    const engine = makeAgentSdkEngine({
      runtime: fixture.runtime,
      credential: 'fixture-key',
      query: () =>
        (async function* () {
          yield {
            type: 'assistant',
            parent_tool_use_id: null,
            uuid: randomUUID(),
            session_id: randomUUID(),
            message: {
              id: 'progress',
              role: 'assistant',
              content: [{ type: 'text', text: progress }],
            },
          } as unknown as SDKMessage;
          observed();
          await paused;
          yield fixture.result();
        })() as unknown as Query,
    });
    const bound = runtime();
    const pending = engine.investigate(input, bound);
    await reachedPause;
    const duringRun = vi
      .mocked(bound.onStep)
      .mock.calls.some(([, content]) => content === progress);
    release();
    await pending;
    expect(duringRun).toBe(true);
    expect(
      vi.mocked(bound.onStep).mock.calls.filter(([, content]) => content === progress),
    ).toHaveLength(1);
  });

  test('customer operational paths survive output processing', () => {
    const instruction = 'Restore packages/db/migrations/0042_accounting.sql before retrying.';
    expect(publicModelText(instruction)).toBe(instruction);
  });

  test('credential redaction remains enabled for operational instructions', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    expect(publicModelText(`Token ${secret}`)).not.toContain(secret);
  });
});
