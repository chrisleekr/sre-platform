import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { makeOpenAIGenerator } from '../generator-openai';
import type { OpenAILike } from '../openai';

// the OpenAI binding of the generic StructuredGenerator primitive. `generate<T>(prompt,
// schema)` makes a single chat.completions call instructing JSON-only output, parses the assistant
// text, then zod-validates it. RED now: makeOpenAIGenerator does not exist. Domain-agnostic — the
// runbook prompts/schemas live in the consumer.
const Schema = z.object({ outcome: z.string(), title: z.string() });

function chatResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('makeOpenAIGenerator (single-shot JSON structured output)', () => {
  test('parses and schema-validates the JSON answer into the typed object', async () => {
    const payload = { outcome: 'nothing', title: 'not reusable' };
    const create = vi.fn().mockResolvedValueOnce(chatResponse(JSON.stringify(payload)));
    const sdk: OpenAILike = { chat: { completions: { create } } };
    const gen = makeOpenAIGenerator({ apiKey: 'k', model: 'gpt-x' }, sdk);

    const out = await gen.generate('distil this incident', Schema);
    expect(out).toEqual(payload);

    // Single-shot chat.completions: the configured model, and the caller's prompt reaches the request.
    const req = create.mock.calls[0]![0] as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(req.model).toBe('gpt-x');
    expect(req.messages.some((m) => m.content.includes('distil this incident'))).toBe(true);
  });

  test('rejects when the JSON violates the schema (structured contract enforced)', async () => {
    const create = vi.fn().mockResolvedValueOnce(chatResponse(JSON.stringify({ outcome: 'x' })));
    const sdk: OpenAILike = { chat: { completions: { create } } };
    const gen = makeOpenAIGenerator({ apiKey: 'k', model: 'gpt-x' }, sdk);
    await expect(gen.generate('p', Schema)).rejects.toThrow();
  });

  test('requires both an API key and a model (fail-fast, no fallback)', () => {
    expect(() => makeOpenAIGenerator({ model: 'gpt-x' })).toThrow(/OPENAI_API_KEY/);
    expect(() => makeOpenAIGenerator({ apiKey: 'k' })).toThrow(/OPENAI_MODEL/);
  });
});
