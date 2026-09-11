import { McpServer } from '@modelcontextprotocol/server';
import { runTool } from './dispatch';
import type { ToolContext, ToolDefinition } from './types';

/**
 * Builds an MCP server over the investigator's validated and audited tools.
 *
 * @param tools - Tenant-scoped tool definitions available to the investigator.
 * @param context - Tenant and incident context bound to every invocation.
 */
export function makeInvestigatorMcpServer(
  tools: ToolDefinition<any, any>[],
  context: ToolContext,
): McpServer {
  const server = new McpServer({ name: 'sre-platform-investigator', version: '1.0.0' });
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`duplicate investigator tool name: ${tool.name}`);
    names.add(tool.name);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) => {
        const result = await runTool(tool, context, input);
        const payload = result.available
          ? { available: true as const, evidenceId: result.evidenceId, data: result.data }
          : {
              available: false as const,
              evidenceId: result.evidenceId,
              reason: result.reason,
            };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
          structuredContent: payload,
          ...(!result.available ? { isError: true } : {}),
        };
      },
    );
  }
  return server;
}
