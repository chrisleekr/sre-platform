import * as z from 'zod';
import type {
  ToolContext,
  ToolDefinition,
  ToolFailure,
  ToolHandlerResult,
  ToolOutcome,
  ToolResult,
} from './types';

/**
 * Executes one investigator tool through validation and durable audit.
 *
 * @remarks Provider errors become secret-free unavailable results, while audit failures propagate.
 * Once `ctx.signal` has aborted, the call throws the signal's reason instead, so a cancelled run
 * ends with its deadline rather than continuing on a fabricated tool error.
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
  ctx.signal?.throwIfAborted();
  const startedAt = Date.now();
  const meta = { tool: tool.name, tenantId: ctx.tenantId, incidentId: ctx.incidentId, input };
  let result: ToolHandlerResult<O>;
  let outcome: ToolOutcome;
  try {
    result = await tool.handler(ctx, input);
    outcome = result.available ? 'data' : result.reason;
  } catch (error) {
    // An abort surfaces as whatever the provider client throws; the run's reason is what the queue
    // and engine account for, and it needs no audit row because the run itself is ending.
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    result = { available: false, reason: 'error', failure: classifyToolError(error) };
    outcome = 'error';
  }
  // The model and the audit sink see the same handler data. An `error` carries no data, only its
  // code-owned failure class; raw error text stays out (CWE-209).
  const output = result.available
    ? result.data
    : result.failure
      ? { failure: result.failure }
      : undefined;
  const evidenceId = await ctx.audit.record({
    ...meta,
    latencyMs: Date.now() - startedAt,
    outcome,
    output,
  });
  return { ...result, evidenceId };
}

/**
 * Classifies a thrown tool error from typed connector fields, never its message.
 *
 * @remarks Reads `status`, `failureCategory` and a `TimeoutError` name; provider text can carry
 * secrets. A typed category wins over a status.
 * @param error - Value thrown by a tool handler.
 */
export function classifyToolError(error: unknown): ToolFailure {
  if (typeof error !== 'object' || error === null) return 'provider_error';
  const { name, status, failureCategory } = error as Record<string, unknown>;
  if (name === 'TimeoutError') return 'timeout';
  // GitHub reports an exhausted quota as 403, so the category wins over the status.
  if (failureCategory === 'rate_limited' || status === 429) return 'rate_limited';
  if (failureCategory === 'target_not_allowed') return 'target_not_allowed';
  // GitHub hides what a credential cannot see behind a 404 and tags it permission_denied, so the
  // category wins over a 404 status: an invisible target is not proof of absence.
  if (failureCategory === 'permission_denied' || status === 401 || status === 403)
    return 'permission_denied';
  if (status === 404) return 'not_found';
  if (failureCategory === 'unreachable' || failureCategory === 'tls') return 'unreachable';
  return 'provider_error';
}

/**
 * Derives the engine-facing JSON Schema from a tool's runtime Zod schema.
 *
 * @param tool - Tool definition whose input contract should be exposed.
 */
export function toJsonSchema<I, O>(tool: ToolDefinition<I, O>) {
  return z.toJSONSchema(tool.inputSchema);
}
