import { describe, expect, test, vi } from 'vitest';
import type { Options, Query, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolContext, ToolDefinition } from '@sre/agent-tools';
import * as z from 'zod';
import { makeAgentSdkEngine, makeAgentSdkGenerator } from '../agent-sdk';

import { createFixture } from './agent-sdk.fixture';

const __fixture = createFixture();

describe('Claude Agent SDK runtime', () => {
  test('groups assistant tool turns by parent tool-use context', async () => {
    const lookup: ToolDefinition<Record<string, never>, { configured: boolean }> = {
      name: 'read_configuration',
      description: 'Read configuration.',
      inputSchema: z.object({}),
      handler: async () => ({ available: true, data: { configured: true } }),
    };
    const report = {
      outcome: 'conclusive' as const,
      summary: 'Root conclusion',
      confidence: 75,
      unknowns: [],
    };
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.mcpQuery(
        async (client) => {
          await client.callTool({ name: 'read_configuration', arguments: {} });
          await client.callTool({ name: 'report_findings', arguments: report });
        },
        [
          ...__fixture.assistantToolTurn(
            'shared-message-id',
            [{ name: 'read_configuration', input: {} }],
            'subagent-parent',
          ),
          ...__fixture.assistantToolTurn('shared-message-id', [
            { name: 'report_findings', input: report },
          ]),
        ],
      ),
    });

    await expect(
      engine.investigate(
        {
          incident: {
            id: 'incident-1',
            tenantId: 'tenant-1',
            service: 'checkout',
            severity: 'sev2',
            fingerprint: 'fingerprint',
            alertSource: 'test',
          },
        },
        {
          tools: [lookup],
          ctx: {
            tenantId: 'tenant-1',
            incidentId: 'incident-1',
            service: 'checkout',
            resolveConnectors: async () => [],
            audit: { record: async () => '11111111-1111-4111-8111-111111111111' },
          },
          signal: new AbortController().signal,
          onStep: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({
      outcome: 'conclusive',
      disposition: 'rca',
      summary: 'Root conclusion',
    });
  });
  test('resume exposes report_recovery when every provider signal is cleared', async () => {
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.mcpQuery(async (client) => {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          'report_findings',
          'report_recovery',
          'respond',
          'stay_silent',
          'suggest_action',
        ]);
        await client.callTool({
          name: 'report_recovery',
          arguments: {
            outcome: 'recovered',
            summary: 'Checkout is healthy again.',
            evidence: [{ name: 'Readiness', before: 'Failing', now: 'Check succeeds' }],
            evidenceIds: ['11111111-1111-4111-8111-111111111111'],
            unknowns: [],
            questions: [],
            nextStep: null,
          },
        });
      }),
    });

    await expect(
      engine.resume(
        {
          incident: {
            id: 'incident-1',
            tenantId: 'tenant-1',
            service: 'checkout',
            severity: 'sev2',
            fingerprint: 'fingerprint',
            alertSource: 'test',
          },
          humanMessage: 'Is this recovered now?',
          prior: [],
          recoveryContext: {
            attempt: 1,
            maxChecks: 3,
            signalSummary: '[RESOLVED] CheckoutHighErrorRate',
          },
        },
        {
          tools: [],
          ctx: {} as ToolContext,
          signal: new AbortController().signal,
          onStep: vi.fn(async () => undefined),
        },
      ),
    ).resolves.toMatchObject({
      disposition: 'recovery',
      recovery: { outcome: 'recovered', recovered: true },
    });
  });
  test('exposes only the recovery terminal and rejects an unevidenced recovery claim', async () => {
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.mcpQuery(async (client) => {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual(['report_recovery']);
        const invalid = await client.callTool({
          name: 'report_recovery',
          arguments: {
            recovered: true,
            summary: 'Recovered.',
            evidence: [],
            unknowns: [],
            questions: [],
            nextStep: null,
          },
        });
        expect(invalid.isError).toBe(true);
        await client.callTool({
          name: 'report_recovery',
          arguments: {
            recovered: true,
            summary: 'Checkout is healthy.',
            evidence: [{ name: 'Readiness', before: 'Failing', now: 'Check succeeds' }],
            evidenceIds: ['11111111-1111-4111-8111-111111111111'],
            unknowns: [],
            questions: [],
            nextStep: null,
          },
        });
      }),
    });

    await expect(
      engine.verifyRecovery(
        {
          incident: {
            id: 'incident-1',
            tenantId: 'tenant-1',
            service: 'checkout',
            severity: 'sev2',
            fingerprint: 'fingerprint',
            alertSource: 'test',
          },
          prior: [],
          signalSummary: 'Alert resolved.',
        },
        {
          tools: [],
          ctx: {} as ToolContext,
          signal: new AbortController().signal,
          onStep: vi.fn(async () => undefined),
        },
      ),
    ).resolves.toMatchObject({
      disposition: 'recovery',
      summary: 'Checkout is healthy.',
      recovery: {
        recovered: true,
        evidence: [{ name: 'Readiness', before: 'Failing', now: 'Check succeeds' }],
      },
    });
  });
  test('maps a bounded turn-limit result to the shared budget-exhausted outcome', async () => {
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.scriptedQuery(
        [
          __fixture.result({
            subtype: 'error_max_turns',
            is_error: true,
            errors: ['Configured maximum turns reached.'],
          } as Partial<SDKResultMessage>),
        ],
        () => undefined,
      ),
    });
    const incident = {
      id: 'incident-1',
      tenantId: 'tenant-1',
      service: 'checkout',
      severity: 'sev2',
      fingerprint: 'fingerprint',
      alertSource: 'test',
    };
    const triageRuntime = {
      tools: [],
      ctx: {} as ToolContext,
      signal: new AbortController().signal,
      onStep: vi.fn(async () => undefined),
    };
    await expect(engine.investigate({ incident }, triageRuntime)).resolves.toMatchObject({
      outcome: 'budget_exhausted',
      summary: 'Investigation exhausted its turn budget without a terminal conclusion.',
    });
    await expect(
      engine.resume({ incident, humanMessage: 'Any update?', prior: [] }, triageRuntime),
    ).resolves.toMatchObject({
      outcome: 'budget_exhausted',
      summary: 'Investigation exhausted its turn budget without a terminal conclusion.',
    });
    await expect(
      engine.verifyRecovery(
        { incident, prior: [], signalSummary: 'Provider reports resolved.' },
        triageRuntime,
      ),
    ).resolves.toMatchObject({
      outcome: 'budget_exhausted',
      summary: 'Recovery verification exhausted its investigation budget.',
    });
  });
  test('runs one terminal-only query after evidence exhausts the Agent SDK turn budget', async () => {
    const report = {
      outcome: 'conclusive' as const,
      summary: 'The recorded configuration evidence is conclusive.',
      confidence: 76,
      rankedHypotheses: [],
      unknowns: [],
    };
    const allowedTools: string[][] = [];
    const maxTurns: Array<number | undefined> = [];
    const prompts: unknown[] = [];
    let invocation = 0;
    const query = vi.fn(((params: { options?: Options; prompt?: unknown }) => {
      const current = ++invocation;
      prompts.push(params.prompt);
      async function* stream(): AsyncGenerator<SDKMessage> {
        const server = params.options?.mcpServers?.sre;
        if (!server || server.type !== 'sdk') throw new Error('missing in-process MCP server');
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client(
          { name: 'terminal-finalizer-test', version: '1.0.0' },
          { capabilities: {} },
        );
        await server.instance.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          const listed = await client.listTools();
          allowedTools.push(listed.tools.map((tool) => tool.name).sort());
          maxTurns.push(params.options?.maxTurns);
          if (current === 1) {
            await client.callTool({ name: 'read_configuration', arguments: {} });
            yield __fixture.result({
              subtype: 'error_max_turns',
              is_error: true,
              errors: ['Configured maximum turns reached.'],
            } as Partial<SDKResultMessage>);
            return;
          }
          await client.callTool({ name: 'report_findings', arguments: report });
          for (const message of __fixture.assistantToolTurn('terminal-finalizer', [
            { name: 'report_findings', input: report },
          ]))
            yield message;
          yield __fixture.result();
        } finally {
          await client.close();
          await server.instance.close();
        }
      }
      return stream() as unknown as Query;
    }) as typeof import('@anthropic-ai/claude-agent-sdk').query);
    const engine = makeAgentSdkEngine({
      runtime: { ...__fixture.runtime, maxTurns: 1 },
      credential: 'provider-key',
      query,
    });
    const readConfiguration: ToolDefinition<Record<string, never>, { configured: boolean }> = {
      name: 'read_configuration',
      description: 'Read configuration.',
      inputSchema: z.object({}),
      handler: vi.fn(async () => ({ available: true as const, data: { configured: true } })),
    };

    const result = await engine.investigate(
      {
        incident: {
          id: 'incident-1',
          tenantId: 'tenant-1',
          service: 'checkout',
          severity: 'sev2',
          fingerprint: 'fingerprint',
          alertSource: 'test',
        },
      },
      {
        tools: [readConfiguration],
        ctx: {
          tenantId: 'tenant-1',
          incidentId: 'incident-1',
          service: 'checkout',
          resolveConnectors: async () => [],
          audit: { record: async () => '11111111-1111-4111-8111-111111111111' },
        },
        signal: new AbortController().signal,
        onStep: vi.fn(async () => undefined),
      },
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(allowedTools[0]).toEqual(['read_configuration', 'report_findings']);
    expect(allowedTools[1]).toEqual(['read_recorded_evidence', 'report_findings']);
    expect(maxTurns[1]).toBe(8);
    expect(String(prompts[1])).toContain('Incident on service "checkout"');
    expect(readConfiguration.handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: 'conclusive',
      disposition: 'rca',
      summary: report.summary,
      evidenceReceipts: [
        {
          evidenceId: '11111111-1111-4111-8111-111111111111',
          tool: 'read_configuration',
          outcome: 'complete',
        },
      ],
    });
  });
  test('keeps resume and recovery task context while exposing only their terminal choices', async () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    const scripts = [
      {
        name: 'report_recovery',
        input: {
          outcome: 'recovered',
          summary: 'The interactive recovery check passed.',
          evidence: [{ name: 'Error rate', before: 'high', now: 'normal' }],
          evidenceIds: [evidenceId],
          unknowns: [],
          questions: [],
          nextStep: null,
          recheckAfterMinutes: null,
          scheduleReason: null,
        },
      },
      {
        name: 'report_recovery',
        input: {
          outcome: 'recovered',
          summary: 'Current checks confirm recovery.',
          evidence: [{ name: 'Error rate', before: 'high', now: 'normal' }],
          evidenceIds: [evidenceId],
          unknowns: [],
          questions: [],
          nextStep: null,
          recheckAfterMinutes: null,
          scheduleReason: null,
        },
      },
    ];
    const allowedTools: string[][] = [];
    const prompts: unknown[] = [];
    let invocation = 0;
    const query = vi.fn(((params: { options?: Options; prompt?: unknown }) => {
      const current = ++invocation;
      prompts.push(params.prompt);
      async function* stream(): AsyncGenerator<SDKMessage> {
        const server = params.options?.mcpServers?.sre;
        if (!server || server.type !== 'sdk') throw new Error('missing in-process MCP server');
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client(
          { name: 'path-finalizer-test', version: '1.0.0' },
          { capabilities: {} },
        );
        await server.instance.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          const listed = await client.listTools();
          allowedTools.push(listed.tools.map((tool) => tool.name).sort());
          if (current % 2 === 1) {
            yield __fixture.result({
              subtype: 'error_max_turns',
              is_error: true,
              errors: ['Configured maximum turns reached.'],
            } as Partial<SDKResultMessage>);
            return;
          }
          const script = scripts.shift()!;
          await client.callTool({ name: script.name, arguments: script.input });
          for (const message of __fixture.assistantToolTurn(`terminal-${current}`, [script]))
            yield message;
          yield __fixture.result();
        } finally {
          await client.close();
          await server.instance.close();
        }
      }
      return stream() as unknown as Query;
    }) as typeof import('@anthropic-ai/claude-agent-sdk').query);
    const engine = makeAgentSdkEngine({
      runtime: { ...__fixture.runtime, maxTurns: 1 },
      credential: 'provider-key',
      query,
    });
    const incident = {
      id: 'incident-1',
      tenantId: 'tenant-1',
      service: 'checkout',
      severity: 'sev2',
      fingerprint: 'fingerprint',
      alertSource: 'test',
    };
    const evidence = [
      {
        id: evidenceId,
        tool: 'query_metrics',
        input: { service: 'checkout' },
        output: { healthy: true },
        createdAt: '2026-08-31T00:00:00.000Z',
      },
    ];
    const runtime = {
      tools: [],
      ctx: {
        tenantId: 'tenant-1',
        incidentId: 'incident-1',
        service: 'checkout',
        resolveConnectors: async () => [],
        audit: { record: async () => evidenceId },
      },
      signal: new AbortController().signal,
      onStep: vi.fn(async () => undefined),
    };
    await expect(
      engine.resume(
        {
          incident,
          humanMessage: 'Is it fixed now?',
          prior: [],
          evidence,
          recoveryContext: {
            attempt: 1,
            maxChecks: 3,
            signalSummary: 'Provider reports resolved.',
          },
        },
        runtime,
      ),
    ).resolves.toMatchObject({ outcome: 'conclusive', disposition: 'recovery' });
    await expect(
      engine.verifyRecovery(
        { incident, prior: [], evidence, signalSummary: 'Provider reports resolved.' },
        runtime,
      ),
    ).resolves.toMatchObject({ outcome: 'conclusive', disposition: 'recovery' });
    expect(allowedTools[1]).toEqual([
      'read_recorded_evidence',
      'report_findings',
      'report_recovery',
      'respond',
      'suggest_action',
    ]);
    expect(allowedTools[3]).toEqual(['read_recorded_evidence', 'report_recovery']);
    expect(String(prompts[1])).toContain('Is it fixed now?');
    expect(String(prompts[1])).toContain('Provider reports resolved.');
    expect(String(prompts[3])).toContain('Provider reports resolved.');
  });
  test('marks invalid Agent SDK finalization failed and rejects infrastructure errors', async () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    const input = {
      incident: {
        id: 'incident-1',
        tenantId: 'tenant-1',
        service: 'checkout',
        severity: 'sev2',
        fingerprint: 'fingerprint',
        alertSource: 'test',
      },
      evidence: [
        {
          id: evidenceId,
          tool: 'query_metrics',
          input: {},
          output: { errorRate: 0.4 },
          createdAt: '2026-08-31T00:00:00.000Z',
        },
      ],
    };
    const runtime = {
      tools: [],
      ctx: {
        tenantId: 'tenant-1',
        incidentId: 'incident-1',
        service: 'checkout',
        resolveConnectors: async () => [],
        audit: { record: async () => evidenceId },
      },
      signal: new AbortController().signal,
      onStep: vi.fn(async () => undefined),
    };
    const queryFor = (mode: 'invalid' | 'throw') => {
      let invocation = 0;
      return vi.fn((() => {
        const current = ++invocation;
        async function* stream(): AsyncGenerator<SDKMessage> {
          if (current === 1) {
            yield __fixture.result({
              subtype: 'error_max_turns',
              is_error: true,
              errors: ['Configured maximum turns reached.'],
            } as Partial<SDKResultMessage>);
            return;
          }
          if (mode === 'throw') throw new Error('provider transport failed');
          yield __fixture.result();
        }
        return stream() as unknown as Query;
      }) as typeof import('@anthropic-ai/claude-agent-sdk').query);
    };
    const invalidEngine = makeAgentSdkEngine({
      runtime: { ...__fixture.runtime, maxTurns: 1 },
      credential: 'provider-key',
      query: queryFor('invalid'),
    });
    await expect(invalidEngine.investigate(input, runtime)).resolves.toMatchObject({
      outcome: 'failed',
    });

    const throwingEngine = makeAgentSdkEngine({
      runtime: { ...__fixture.runtime, maxTurns: 1 },
      credential: 'provider-key',
      query: queryFor('throw'),
    });
    await expect(throwingEngine.investigate(input, runtime)).rejects.toThrow(
      'Claude Agent SDK query failed',
    );
  });

  test('accounts for an error result before classifying the iterator failure', async () => {
    const onUsage = vi.fn();
    const generator = makeAgentSdkGenerator({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      onUsage,
      query: __fixture.scriptedQuery(
        [
          __fixture.result({
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['provider overloaded with status 529'],
          } as Partial<SDKResultMessage>),
        ],
        () => undefined,
        new Error('process exited after yielding its result'),
      ),
    });

    await expect(
      generator.generate('Classify this alert', z.object({ ok: z.boolean() })),
    ).rejects.toThrow('Claude Agent SDK provider unavailable');
    expect(onUsage).toHaveBeenCalledWith({
      model: 'claude-test',
      requestCount: 3,
      input: 100,
      output: 20,
      cacheRead: 10,
      cacheWrite: 5,
      providerEstimatedCostUsd: 0.123,
    });
  });
});
