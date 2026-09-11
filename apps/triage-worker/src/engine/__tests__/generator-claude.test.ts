import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { makeClaudeGenerator } from '../generator-claude';
import type { AnthropicLike } from '../claude';

// the Claude binding of the generic StructuredGenerator primitive. `generate<T>(prompt,
// schema)` produces ONE structured object by forcing a single-tool tool_use turn (Anthropic's
// structured-output pattern), then zod-validates the tool input. RED now: makeClaudeGenerator does
// not exist. The provider stays domain-agnostic — the runbook prompts/schemas live in the consumer.
const Schema = z.object({ outcome: z.string(), title: z.string() });

// A real discriminated union — the shape the runbook consumer actually passes. Zod renders a union as
// a top-level `{anyOf:[...]}` with NO `type:'object'`, which Anthropic rejects as a tool input_schema,
// so the generator must wrap it in an object before conversion (FIX 1).
const UnionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('resolution_found'), title: z.string() }),
  z.object({ outcome: z.literal('nothing'), reason: z.string() }),
]);

/**
 * A scripted forced-tool-use response. The generator wraps the caller schema under `result`, so the
 * model's tool input is `{ result: <value> }`; this helper wraps to match that contract.
 */
function toolUseResponse(value: unknown) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'emit', input: { result: value } }],
  };
}

describe('makeClaudeGenerator (forced tool-use structured output)', () => {
  test('returns the schema-validated tool input and forces exactly one tool', async () => {
    const payload = { outcome: 'resolution_found', title: 'DB pool exhaustion' };
    const create = vi.fn().mockResolvedValueOnce(toolUseResponse(payload));
    const sdk: AnthropicLike = { messages: { create } };
    const gen = makeClaudeGenerator({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);

    const out = await gen.generate('distil this incident', Schema);
    expect(out).toEqual(payload);

    // The request bound a single tool and forced it via tool_choice, with a JSON input_schema derived
    // from the zod schema, and the 4096 token ceiling (a distilled runbook is larger than triage).
    const req = create.mock.calls[0]![0] as {
      tools: Array<{ name: string; input_schema: unknown }>;
      tool_choice: { type: string; name: string };
      max_tokens: number;
    };
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0]!.input_schema).toBeDefined();
    expect(req.tool_choice).toMatchObject({ type: 'tool', name: req.tools[0]!.name });
    expect(req.max_tokens).toBe(4096);
  });

  test('rejects when the tool input violates the schema (structured contract enforced)', async () => {
    const create = vi.fn().mockResolvedValueOnce(toolUseResponse({ outcome: 'x' })); // missing title
    const sdk: AnthropicLike = { messages: { create } };
    const gen = makeClaudeGenerator({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);
    await expect(gen.generate('p', Schema)).rejects.toThrow();
  });

  test('throws without a credential (fail-fast, no fallback)', () => {
    expect(() => makeClaudeGenerator({ model: 'claude-opus-4-8' })).toThrow(
      /ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });

  // FIX 1 (regression): a discriminated union must still yield an OBJECT input_schema (wrapped under
  // `result`) so Anthropic accepts the forced tool; the inner union value is unwrapped on return.
  test('wraps a discriminated-union schema so input_schema.type is object, and unwraps the result', async () => {
    const value = { outcome: 'nothing', reason: 'x' };
    const create = vi.fn().mockResolvedValueOnce(toolUseResponse(value));
    const sdk: AnthropicLike = { messages: { create } };
    const gen = makeClaudeGenerator({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);

    const out = await gen.generate('distil', UnionSchema);
    // The union value is returned unwrapped (the `result` envelope is provider-internal).
    expect(out).toEqual(value);

    const req = create.mock.calls[0]![0] as { tools: Array<{ input_schema: { type?: string } }> };
    expect(req.tools[0]!.input_schema.type).toBe('object'); // NOT a bare anyOf union
  });
});
