import type { Options, Query, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LlmRuntimeConfig } from '@sre/contracts';

export function createFixture() {
  const runtime: LlmRuntimeConfig = {
    runtime: 'claude-agent-sdk',
    provider: 'anthropic',
    model: 'claude-test',
    baseUrl: null,
    authMode: 'api-key',
    maxTurns: 8,
    pricing: null,
  };

  function result(overrides: Partial<SDKResultMessage> = {}): SDKResultMessage {
    return {
      type: 'result',
      subtype: 'success',
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 3,
      result: 'done',
      stop_reason: 'end_turn',
      total_cost_usd: 0.123,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 10,
        server_tool_use: null,
        service_tier: null,
        cache_creation: null,
        inference_geo: null,
        iterations: [],
        speed: null,
      },
      modelUsage: {
        'claude-test': {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
          webSearchRequests: 0,
          costUSD: 0.123,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
      },
      permission_denials: [],
      uuid: '11111111-1111-4111-8111-111111111111',
      session_id: '22222222-2222-4222-8222-222222222222',
      ...overrides,
    } as SDKResultMessage;
  }

  function scriptedQuery(
    messages: SDKMessage[],
    capture: (options: Options | undefined) => void,
    iterationError?: Error,
  ): typeof import('@anthropic-ai/claude-agent-sdk').query {
    return ((params: { options?: Options }) => {
      capture(params.options);
      async function* stream(): AsyncGenerator<SDKMessage> {
        for (const message of messages) yield message;
        if (iterationError) throw iterationError;
      }
      return stream() as unknown as Query;
    }) as typeof import('@anthropic-ai/claude-agent-sdk').query;
  }

  function mcpQuery(
    run: (client: Client) => Promise<void>,
    assistantMessages: SDKMessage[] = [],
    capture?: (params: { prompt?: unknown; options?: Options }) => void,
  ): typeof import('@anthropic-ai/claude-agent-sdk').query {
    return ((params: { prompt?: unknown; options?: Options }) => {
      capture?.(params);
      async function* stream(): AsyncGenerator<SDKMessage> {
        const server = params.options?.mcpServers?.sre;
        if (!server || server.type !== 'sdk') throw new Error('missing in-process MCP server');
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client(
          { name: 'agent-sdk-test', version: '1.0.0' },
          { capabilities: {} },
        );
        await server.instance.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          await run(client);
          for (const message of assistantMessages) yield message;
          yield result();
        } finally {
          await client.close();
          await server.instance.close();
        }
      }
      return stream() as unknown as Query;
    }) as typeof import('@anthropic-ai/claude-agent-sdk').query;
  }

  function assistantToolTurn(
    id: string,
    calls: Array<{ name: string; input: Record<string, unknown> }>,
    parentToolUseId: string | null = null,
  ): SDKMessage[] {
    return calls.map(
      (call, index) =>
        ({
          type: 'assistant',
          parent_tool_use_id: parentToolUseId,
          uuid: `${id}-${index}`,
          session_id: '22222222-2222-4222-8222-222222222222',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [
              {
                type: 'tool_use',
                id: `${id}-tool-${index}`,
                name: `mcp__sre__${call.name}`,
                input: call.input,
              },
            ],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }) as unknown as SDKMessage,
    );
  }

  return {
    runtime,
    result,
    scriptedQuery,
    mcpQuery,
    assistantToolTurn,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
