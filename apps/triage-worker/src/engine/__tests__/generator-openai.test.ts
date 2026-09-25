import { describe, expect, test, vi } from 'vitest';
import OpenAI from 'openai';
import * as z from 'zod';
import { makeOpenAIGenerator, makeOpenAIVision } from '../generator-openai';
import type { OpenAILike } from '../openai';
import { ProviderConfigurationError } from '../types';

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

  test('trims over-length output only when the caller opts into length repair', async () => {
    const limited = z.object({ note: z.string().max(5) });
    const create = vi
      .fn()
      .mockResolvedValue(chatResponse(JSON.stringify({ note: 'far too long' })));
    const gen = makeOpenAIGenerator(
      { apiKey: 'k', model: 'gpt-x' },
      { chat: { completions: { create } } },
    );
    await expect(gen.generate('p', limited)).rejects.toThrow();
    await expect(gen.generate('p', limited, { repairOverlength: true })).resolves.toEqual({
      note: 'far …',
    });
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

  test.each([400, 401, 403, 404])(
    'a %s rejection is a ProviderConfigurationError without provider text',
    async (status) => {
      const create = vi.fn(async () => {
        throw new OpenAI.APIError(status, { detail: 'PROMPT-LEAK' }, 'bad', undefined);
      });
      const sdk: OpenAILike = { chat: { completions: { create } } };
      const config = { apiKey: 'k', model: 'gpt-4o' };
      await expect(makeOpenAIGenerator(config, sdk).generate('p', Schema)).rejects.toEqual(
        new ProviderConfigurationError(status),
      );
      await expect(
        makeOpenAIVision(config, sdk).describeImage(new ArrayBuffer(1), 'image/png', 'p'),
      ).rejects.toEqual(new ProviderConfigurationError(status));
    },
  );

  test('another client error keeps only its status', async () => {
    const create = vi.fn(async () => {
      throw new OpenAI.APIError(422, { detail: 'PROMPT-LEAK' }, 'bad', undefined);
    });
    const sdk: OpenAILike = { chat: { completions: { create } } };
    await expect(
      makeOpenAIGenerator({ apiKey: 'k', model: 'gpt-x' }, sdk).generate('p', Schema),
    ).rejects.toThrow(/^openai request failed with status 422$/);
  });
});
