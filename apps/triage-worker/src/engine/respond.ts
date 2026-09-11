import * as z from 'zod';
import type { ToolDefinition } from '@sre/agent-tools';

/**
 * Engine-local terminal tool. On a resume the model may conclude by *replying* to
 * the human instead of overwriting the RCA: a one-line `summary` takeaway plus the full `detail` reply.
 * Bound like any other tool, but the loop intercepts it before dispatch (so the handler below never
 * runs) and turns its input into a `disposition:'reply'` result the worker appends to the hub.
 */
export const RESPOND_NAME = 'respond';

export const respondSchema = z.object({
  summary: z.string(),
  detail: z.string(),
  purpose: z.enum(['answer', 'clarification_request']).default('answer'),
  evidenceIds: z.array(z.uuid()).max(30).default([]),
});

export type Respond = z.infer<typeof respondSchema>;

export const respondTool: ToolDefinition<Respond, Respond> = {
  name: RESPOND_NAME,
  description:
    'Reply without changing the root-cause conclusion. Set purpose=clarification_request only when the platform needs specific human information to proceed; otherwise use answer. Include summary, detail, and durable evidenceIds cited in the answer.',
  inputSchema: respondSchema,
  // The loop intercepts respond and never dispatches it, so this handler is unreachable. It exists
  // only to satisfy the ToolDefinition contract when the tool is bound as a spec.
  async handler(_ctx, input) {
    return { available: true, data: input };
  },
};

/**
 * Parse a model-supplied respond into a `Respond`, defensively. The loop must always be able to
 * conclude, so this never throws: on a schema miss it salvages a usable summary/detail where present.
 */
export function parseRespond(input: unknown): Respond {
  const parsed = respondSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const obj = (input ?? {}) as Record<string, unknown>;
  const summary =
    typeof obj.summary === 'string' && obj.summary.length > 0 ? obj.summary : 'Replied.';
  let detail: string;
  if (typeof obj.detail === 'string' && obj.detail.length > 0) {
    detail = obj.detail;
  } else if (typeof obj.summary === 'string') {
    detail = obj.summary;
  } else {
    detail = 'No reply text produced.';
  }
  return { summary, detail, purpose: 'answer', evidenceIds: [] };
}
