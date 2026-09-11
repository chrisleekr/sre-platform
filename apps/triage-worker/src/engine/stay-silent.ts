import * as z from 'zod';
import type { ToolDefinition } from '@sre/agent-tools';

/**
 * Engine-local terminal tool. On a resume the model may decide the human message
 * needs no response (an acknowledgement, chatter, or a note it recorded). It concludes by staying
 * silent with an optional `reason`. Bound like any other tool, but the loop intercepts it before
 * dispatch (so the handler below never runs) and turns its input into a `disposition:'silent'` result
 * the worker records for the log/evidence without surfacing it.
 */
export const STAY_SILENT_NAME = 'stay_silent';

export const staySilentSchema = z.object({
  reason: z.string().optional(),
});

export type StaySilent = z.infer<typeof staySilentSchema>;

export const staySilentTool: ToolDefinition<StaySilent, StaySilent> = {
  name: STAY_SILENT_NAME,
  description:
    'Conclude without replying, when the human message needs no response. Optionally pass reason to record why (for the log/evidence). Nothing is surfaced to the human.',
  inputSchema: staySilentSchema,
  // The loop intercepts stay_silent and never dispatches it, so this handler is unreachable. It exists
  // only to satisfy the ToolDefinition contract when the tool is bound as a spec.
  async handler(_ctx, input) {
    return { available: true, data: input };
  },
};

/**
 * Parse a model-supplied stay_silent into a `StaySilent`, defensively. The loop must always be able to
 * conclude, so this never throws: on a schema miss it falls back to an absent reason.
 */
export function parseStaySilent(input: unknown): StaySilent {
  const parsed = staySilentSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const obj = (input ?? {}) as Record<string, unknown>;
  return { reason: typeof obj.reason === 'string' ? obj.reason : undefined };
}
