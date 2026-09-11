import * as z from 'zod';
import type { ToolDefinition } from '@sre/agent-tools';

export const SUGGEST_ACTION_NAME = 'suggest_action';

export const suggestActionSchema = z.object({
  level: z.enum(['L2', 'L3']),
  // Reject blank values without trimming the exact text a human must execute or look up.
  explanation: z.string().regex(/\S/),
  action: z.string().regex(/\S/),
});

export type SuggestAction = z.infer<typeof suggestActionSchema>;

export const suggestActionTool: ToolDefinition<SuggestAction, SuggestAction> = {
  name: SUGGEST_ACTION_NAME,
  description:
    'Recommend an L2 or L3 action for a human to execute. Supply a non-blank explanation and the exact command or rollback reference. The platform records Approve or Deny but never executes the action.',
  inputSchema: suggestActionSchema,
  // The loop intercepts this terminal before dispatch. The handler only satisfies ToolDefinition.
  async handler(_ctx, input) {
    return { available: true, data: input };
  },
};

export function buildRecommendedAction(input: SuggestAction): {
  prompt: string;
  options: { id: string; label: string }[];
} {
  return {
    prompt:
      `Recommended Action (${input.level})\n\n${input.explanation}\n\n` +
      `Command or rollback reference:\n${input.action}`,
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ],
  };
}
