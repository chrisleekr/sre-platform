import { describe, expect, test, vi } from 'vitest';

import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ToolContext, ToolDefinition } from '@sre/agent-tools';

import * as z from 'zod';

import { makeAgentSdkClassifier, makeAgentSdkEngine, makeAgentSdkGenerator } from '../agent-sdk';

import type { InboundCandidate } from '@sre/connectors';

import { createFixture } from './agent-sdk.fixture';

const __fixture = createFixture();

describe('Claude Agent SDK runtime', () => {
  test.each([
    {
      terminal: 'respond',
      arguments: { summary: 'Recovered', detail: 'Checkout recovered after rollback.' },
      expected: {
        disposition: 'reply',
        summary: 'Recovered',
        detail: 'Checkout recovered after rollback.',
      },
    },
    {
      terminal: 'stay_silent',
      arguments: { reason: 'Acknowledgement only.' },
      expected: { disposition: 'silent', summary: 'Acknowledgement only.' },
    },
    {
      terminal: 'suggest_action',
      arguments: {
        level: 'L2',
        explanation: 'Rollback is safest.',
        action: 'deploy rollback checkout',
      },
      expected: {
        disposition: 'approval',
        approval: {
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny' },
          ],
        },
      },
    },
  ])('maps the $terminal resume terminal into a durable disposition', async (testCase) => {
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.mcpQuery(async (client) => {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          'report_findings',
          'respond',
          'stay_silent',
          'suggest_action',
        ]);
        await client.callTool({
          name: testCase.terminal,
          arguments: testCase.arguments,
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
          humanMessage: 'What should we do next?',
          prior: [],
        },
        {
          tools: [],
          ctx: {} as ToolContext,
          signal: new AbortController().signal,
          onStep: vi.fn(async () => undefined),
        },
      ),
    ).resolves.toMatchObject(testCase.expected);
  });

  test('confines the agent to audited MCP tools and records cumulative whole-query usage', async () => {
    let options: Options | undefined;
    const onUsage = vi.fn();
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      env: {
        PATH: '/usr/bin',
        HOME: '/tmp/test-home',
        SECRETS_MASTER_KEY: 'must-not-reach-child',
      } as NodeJS.ProcessEnv,
      onUsage,
      query: __fixture.scriptedQuery([__fixture.result()], (value) => {
        options = value;
      }),
    });
    const triageRuntime = {
      tools: [],
      ctx: {} as ToolContext,
      signal: new AbortController().signal,
      onStep: vi.fn(async () => undefined),
    };

    const output = await engine.investigate(
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
      triageRuntime,
    );

    expect(output).toMatchObject({
      outcome: 'inconclusive',
      provider: 'anthropic',
      model: 'claude-test',
      summary: 'Investigation ended without a terminal conclusion.',
    });
    expect(output.disposition).not.toBe('rca');
    expect(options).toMatchObject({
      model: 'claude-test',
      maxTurns: 8,
      tools: [],
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
    });
    expect(options?.allowedTools).toEqual(['mcp__sre__report_findings']);
    expect(options?.env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/tmp/test-home',
      ANTHROPIC_API_KEY: 'provider-key',
    });
    expect(options?.env).not.toHaveProperty('SECRETS_MASTER_KEY');
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

  test('uses Agent SDK structured output for non-investigation model work', async () => {
    let options: Options | undefined;
    const generator = makeAgentSdkGenerator({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.scriptedQuery(
        [__fixture.result({ structured_output: { result: { title: 'Database latency' } } })],
        (value) => {
          options = value;
        },
      ),
    });

    await expect(
      generator.generate(
        'Summarize the alert',
        z.object({ title: z.string(), rank: z.number().int().min(1).optional() }),
      ),
    ).resolves.toEqual({ title: 'Database latency' });
    expect(options?.outputFormat).toMatchObject({ type: 'json_schema' });
    const outputSchema = options?.outputFormat?.schema as {
      properties: { result: { properties: { rank: Record<string, unknown> } } };
    };
    expect(outputSchema.properties.result.properties.rank).not.toHaveProperty('minimum');
    expect(outputSchema.properties.result.properties.rank.description).toContain('minimum: 1');
    expect(options?.tools).toEqual([]);
    expect(options?.maxTurns).toBe(3);
  });

  test('passes opaque recovery candidates through the Agent SDK classifier', async () => {
    let prompt = '';
    const query = ((params: { prompt: unknown }) => {
      prompt = String(params.prompt);
      async function* stream(): AsyncGenerator<SDKMessage> {
        yield __fixture.result({
          structured_output: { result: { decision: 'resolves_signal', signalIndex: 1 } },
        });
      }
      return stream() as unknown as Query;
    }) as typeof import('@anthropic-ai/claude-agent-sdk').query;
    const classifier = makeAgentSdkClassifier({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query,
    });
    const candidate = {
      externalId: 'slack-recovery',
      channel: 'C123',
      author: 'bot',
      producerId: 'bot:B_STATUSCAKE',
      text: 'luxuryescapes.com went Up',
      raw: {},
      signalState: 'firing',
      eventKey: 'slack:C123:recovery',
      eventAt: '2026-08-28T00:00:00.000Z',
      contentHash: 'hash',
      isEdit: false,
    } satisfies InboundCandidate;

    await expect(
      classifier.classify(
        candidate,
        [],
        [
          {
            id: 'signal-secret-id',
            incidentId: 'incident-secret-id',
            externalMessageId: 'slack-root',
            channel: 'C123',
            summary: 'luxuryescapes.com went Down',
            service: 'website',
            title: 'luxuryescapes.com down',
            severity: 'sev2',
          },
        ],
      ),
    ).resolves.toEqual({ decision: 'resolves_signal', signalIndex: 1 });
    expect(prompt).toContain('luxuryescapes.com went Down');
    expect(prompt).not.toContain('signal-secret-id');
    expect(prompt).not.toContain('incident-secret-id');
  });

  test('runs audited MCP tools and maps the terminal report into an RCA result', async () => {
    const onStep = vi.fn(async () => undefined);
    const lookup: ToolDefinition<{ service: string }, { status: string }> = {
      name: 'lookup_service',
      description: 'Look up a service.',
      inputSchema: z.object({ service: z.string() }),
      handler: vi.fn(async (_ctx, input) => ({
        available: true as const,
        data: { status: `${input.service}:healthy` },
      })),
    };
    const report = {
      outcome: 'conclusive' as const,
      summary: 'Checkout is healthy.',
      confidence: 92,
      rankedHypotheses: [],
      unknowns: [],
      nextStep: null,
    };
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.mcpQuery(
        async (client) => {
          const listed = await client.listTools();
          expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
            'lookup_service',
            'report_findings',
          ]);
          await client.callTool({ name: 'lookup_service', arguments: { service: 'checkout' } });
          await client.callTool({
            name: 'report_findings',
            arguments: report,
          });
        },
        [
          ...__fixture.assistantToolTurn('lookup-turn', [
            { name: 'lookup_service', input: { service: 'checkout' } },
          ]),
          ...__fixture.assistantToolTurn('terminal-turn', [
            { name: 'report_findings', input: report },
          ]),
        ],
      ),
    });
    const triageRuntime = {
      tools: [lookup],
      ctx: {
        tenantId: 'tenant-1',
        incidentId: 'incident-1',
        service: 'checkout',
        resolveConnectors: async () => [],
        audit: { record: async () => '11111111-1111-4111-8111-111111111111' },
      } satisfies ToolContext,
      signal: new AbortController().signal,
      onStep,
    };

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
        triageRuntime,
      ),
    ).resolves.toMatchObject({
      outcome: 'conclusive',
      disposition: 'rca',
      summary: 'Checkout is healthy.',
      confidence: 92,
    });
    expect(onStep).toHaveBeenCalledWith('tool_step', 'lookup_service {"service":"checkout"}');
    expect(onStep).toHaveBeenCalledWith('tool_step', expect.stringContaining('report_findings'));
  });

  test('challenges one unattempted observable gap before recording the SDK conclusion', async () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    const lookup: ToolDefinition<Record<string, never>, { configured: boolean }> = {
      name: 'read_configuration',
      description: 'Read configuration.',
      inputSchema: z.object({}),
      handler: async () => ({ available: true, data: { configured: true } }),
    };
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.mcpQuery(async (client) => {
        const draft = await client.callTool({
          name: 'report_findings',
          arguments: {
            outcome: 'inconclusive',
            summary: 'Draft',
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
        });
        expect(JSON.stringify(draft.content)).toContain('machine-checkable questions');
        await client.callTool({ name: 'read_configuration', arguments: {} });
        await client.callTool({
          name: 'report_findings',
          arguments: {
            outcome: 'conclusive',
            summary: 'Configuration verified.',
            confidence: 85,
            unknowns: [],
            evidenceIds: [evidenceId],
          },
        });
      }),
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
            audit: { record: async () => evidenceId },
          },
          signal: new AbortController().signal,
          onStep: async () => undefined,
        },
      ),
    ).resolves.toMatchObject({
      disposition: 'rca',
      summary: 'Configuration verified.',
      evidenceIds: [evidenceId],
      unknowns: [],
    });
  });

  test('requires a visible resume conclusion after an audited evidence read', async () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    const lookup: ToolDefinition<Record<string, never>, { configured: boolean }> = {
      name: 'read_configuration',
      description: 'Read configuration.',
      inputSchema: z.object({}),
      handler: async () => ({ available: true, data: { configured: true } }),
    };
    const reply = {
      summary: 'Checked',
      detail: 'The current configuration is present.',
      evidenceIds: [evidenceId],
    };
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.mcpQuery(
        async (client) => {
          await client.callTool({ name: 'read_configuration', arguments: {} });
          const rejected = await client.callTool({
            name: 'stay_silent',
            arguments: { reason: 'No response.' },
          });
          expect(JSON.stringify(rejected.content)).toMatch(/visible conclusion/i);
          await client.callTool({ name: 'respond', arguments: reply });
        },
        [
          ...__fixture.assistantToolTurn('evidence', [{ name: 'read_configuration', input: {} }]),
          ...__fixture.assistantToolTurn('silent', [
            { name: 'stay_silent', input: { reason: 'No response.' } },
          ]),
          ...__fixture.assistantToolTurn('reply', [{ name: 'respond', input: reply }]),
        ],
      ),
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
          humanMessage: 'Please check the current configuration.',
          prior: [],
        },
        {
          tools: [lookup],
          ctx: {
            tenantId: 'tenant-1',
            incidentId: 'incident-1',
            service: 'checkout',
            resolveConnectors: async () => [],
            audit: { record: async () => evidenceId },
          },
          signal: new AbortController().signal,
          onStep: vi.fn(async () => undefined),
        },
      ),
    ).resolves.toMatchObject({
      disposition: 'reply',
      ...reply,
      evidenceReceipts: [expect.objectContaining({ evidenceId, outcome: 'complete' })],
    });
  });

  test('replaces a pre-evidence conclusion with the revised conclusion', async () => {
    const lookup: ToolDefinition<Record<string, never>, { configured: boolean }> = {
      name: 'read_configuration',
      description: 'Read configuration.',
      inputSchema: z.object({}),
      handler: async () => ({ available: true, data: { configured: true } }),
    };
    const draft = {
      outcome: 'inconclusive' as const,
      summary: 'Draft before evidence',
      confidence: 35,
      unknowns: [],
    };
    const revised = {
      outcome: 'conclusive' as const,
      unknowns: [],
      confidence: 90,
      summary: 'Revised after evidence',
    };
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.mcpQuery(
        async (client) => {
          await client.callTool({
            name: 'report_findings',
            arguments: draft,
          });
          await client.callTool({ name: 'read_configuration', arguments: {} });
          await client.callTool({
            name: 'report_findings',
            arguments: revised,
          });
        },
        [
          ...__fixture.assistantToolTurn('draft-with-evidence', [
            { name: 'report_findings', input: draft },
            { name: 'read_configuration', input: {} },
          ]),
          ...__fixture.assistantToolTurn('revised-terminal', [
            { name: 'report_findings', input: revised },
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
      disposition: 'rca',
      summary: 'Revised after evidence',
      confidence: 90,
    });
  });

  test('does not accept two terminal calls from one assistant turn', async () => {
    const response = { summary: 'Reply', detail: 'First disposition.' };
    const silence = { reason: 'Conflicting disposition.' };
    const engine = makeAgentSdkEngine({
      runtime: __fixture.runtime,
      credential: 'provider-key',
      query: __fixture.mcpQuery(
        async (client) => {
          await client.callTool({ name: 'respond', arguments: response });
          await client.callTool({ name: 'stay_silent', arguments: silence });
        },
        __fixture.assistantToolTurn('conflicting-terminals', [
          { name: 'respond', input: response },
          { name: 'stay_silent', input: silence },
        ]),
      ),
    });

    const result = await engine.resume(
      {
        incident: {
          id: 'incident-1',
          tenantId: 'tenant-1',
          service: 'checkout',
          severity: 'sev2',
          fingerprint: 'fingerprint',
          alertSource: 'test',
        },
        humanMessage: 'What happened?',
        prior: [],
      },
      {
        tools: [],
        ctx: {} as ToolContext,
        signal: new AbortController().signal,
        onStep: async () => undefined,
      },
    );
    expect(result).toMatchObject({ outcome: 'inconclusive' });
    expect(result.disposition).not.toBe('rca');
  });
});
