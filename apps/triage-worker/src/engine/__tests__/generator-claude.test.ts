import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { makeClaudeGenerator } from '../generator-claude';
import type { AnthropicLike } from '../claude';

// the Claude binding of the generic StructuredGenerator primitive. `generate<T>(prompt,
// schema)` produces ONE structured object from a single strict tool the model is told to call, then
// zod-validates the tool input. The provider stays domain-agnostic; the runbook prompts and schemas
// live in the consumer.
const Schema = z.object({ outcome: z.string(), title: z.string() });

// A real discriminated union — the shape the runbook consumer actually passes. Zod renders a union as
// a top-level `{anyOf:[...]}` with NO `type:'object'`, which Anthropic rejects as a tool input_schema,
// so the generator must wrap it in an object before conversion (FIX 1).
const UnionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('resolution_found'), title: z.string() }),
  z.object({ outcome: z.literal('nothing'), reason: z.string() }),
]);

/**
 * A scripted tool-use response. The generator wraps the caller schema under `result`, so the
 * model's tool input is `{ result: <value> }`; this helper wraps to match that contract.
 */
function toolUseResponse(value: unknown) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'emit', input: { result: value } }],
  };
}

describe('makeClaudeGenerator (strict tool-use structured output)', () => {
  test('returns the schema-validated tool input from one strict tool under auto choice', async () => {
    const payload = { outcome: 'resolution_found', title: 'DB pool exhaustion' };
    const create = vi.fn().mockResolvedValueOnce(toolUseResponse(payload));
    const sdk: AnthropicLike = { messages: { create } };
    const gen = makeClaudeGenerator({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);

    const out = await gen.generate('distil this incident', Schema);
    expect(out).toEqual(payload);

    // One strict tool under auto choice: Opus 5.5 returns 400 for a forced tool_choice. The system
    // prompt names the tool instead, and the 4096 token ceiling fits a distilled runbook.
    const req = create.mock.calls[0]![0] as {
      tools: Array<{ name: string; input_schema: unknown; strict?: boolean }>;
      tool_choice: { type: string; name?: string };
      system: string;
      max_tokens: number;
    };
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0]!.input_schema).toBeDefined();
    expect(req.tools[0]!.strict).toBe(true);
    expect(req.tool_choice).toEqual({ type: 'auto' });
    expect(req.system).toContain(`Respond only by calling ${req.tools[0]!.name}`);
    expect(req.max_tokens).toBe(4096);
  });

  test('strips strict-unsupported limits from the wire schema while zod still enforces them', async () => {
    const limited = z.object({ note: z.string().max(5), items: z.array(z.string()).max(1) });
    const create = vi
      .fn()
      .mockResolvedValue(toolUseResponse({ note: 'too long for five', items: ['a'] }));
    const sdk: AnthropicLike = { messages: { create } };
    const gen = makeClaudeGenerator({ apiKey: 'k', model: 'claude-opus-5-5' }, sdk);

    await expect(gen.generate('p', limited)).rejects.toThrow();
    const req = create.mock.calls[0]![0] as { tools: Array<{ input_schema: unknown }> };
    const wire = JSON.stringify(req.tools[0]!.input_schema);
    expect(wire).not.toContain('"maxLength"');
    expect(wire).not.toContain('"maxItems"');
    expect(wire).toContain('"additionalProperties":false');
  });

  test('trims over-length output only when the caller opts into length repair', async () => {
    const limited = z.object({ note: z.string().max(5) });
    const create = vi.fn().mockResolvedValue(toolUseResponse({ note: 'far too long' }));
    const gen = makeClaudeGenerator(
      { apiKey: 'k', model: 'claude-opus-5-5' },
      { messages: { create } },
    );
    await expect(gen.generate('p', limited)).rejects.toThrow();
    await expect(gen.generate('p', limited, { repairOverlength: true })).resolves.toEqual({
      note: 'far …',
    });
  });

  test('fails closed when the model answers in prose instead of calling the tool', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] });
    const sdk: AnthropicLike = { messages: { create } };
    const gen = makeClaudeGenerator({ apiKey: 'k', model: 'claude-opus-5-5' }, sdk);
    await expect(gen.generate('p', Schema)).rejects.toThrow('claude returned no structured output');
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
  // `result`) so Anthropic accepts the tool; the inner union value is unwrapped on return.
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
