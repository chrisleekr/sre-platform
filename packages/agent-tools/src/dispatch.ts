import * as z from 'zod';
import { redactInput } from './redact';
import type {
  ToolContext,
  ToolDefinition,
  ToolHandlerResult,
  ToolOutcome,
  ToolResult,
} from './types';

/**
 * Executes one investigator tool through validation, redaction, and durable audit.
 *
 * @remarks Provider errors become secret-free unavailable results, while audit failures propagate.
 * @param tool - Validated tool definition to invoke.
 * @param ctx - Tenant and incident context for execution and audit.
 * @param rawInput - Untrusted model input validated by the tool schema.
 */
export async function runTool<I, O>(
  tool: ToolDefinition<I, O>,
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolResult<O>> {
  const input = tool.inputSchema.parse(rawInput);
  const startedAt = Date.now();
  const meta = { tool: tool.name, tenantId: ctx.tenantId, incidentId: ctx.incidentId, input };
  let result: ToolHandlerResult<O>;
  let outcome: ToolOutcome;
  try {
    result = await tool.handler(ctx, input);
    outcome = result.available ? 'data' : result.reason;
  } catch {
    result = { available: false, reason: 'error' };
    outcome = 'error';
  }
  // Single output-redaction point (CWE-532): scrub the handler's data ONCE, then feed the SAME
  // redacted value to BOTH the model (the returned result the loop renders) and the audit sink
  // (persisted to agent_tool_calls.output). An `error` carries no data, so nothing to redact.
  // `redactInput` recurses without cycle detection, so a handler returning a circular object graph
  // would throw here (outside the handler try) and reject the whole engine job; degrade to an `error`
  // result instead so one pathological tool never poison-loops triage. Raw error text stays out
  // (CWE-209).
  let output: unknown;
  if (result.available) {
    try {
      output = redactInput(result.data);
      result = { available: true, data: output as O };
    } catch {
      result = { available: false, reason: 'error' };
      outcome = 'error';
      output = undefined;
    }
  }
  const evidenceId = await ctx.audit.record({
    ...meta,
    latencyMs: Date.now() - startedAt,
    outcome,
    output,
  });
  return { ...result, evidenceId };
}

/**
 * Derives the engine-facing JSON Schema from a tool's runtime Zod schema.
 *
 * @param tool - Tool definition whose input contract should be exposed.
 */
export function toJsonSchema<I, O>(tool: ToolDefinition<I, O>) {
  return z.toJSONSchema(tool.inputSchema);
}
