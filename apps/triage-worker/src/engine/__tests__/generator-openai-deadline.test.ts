import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { makeOpenAIGenerator, makeOpenAIVision } from '../generator-openai';
import type { OpenAILike } from '../openai';

const Schema = z.object({ ok: z.boolean() });
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

function sdkWith(create: OpenAILike['chat']['completions']['create']): OpenAILike {
  return { chat: { completions: { create } } };
}

function completion(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('OpenAI one-shot deadline signal', () => {
  const config = { apiKey: 'k', model: 'gpt-5' };

  test('generate rejects an already-aborted reason without calling the provider', async () => {
    const create = vi.fn<OpenAILike['chat']['completions']['create']>();
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);

    await expect(
      makeOpenAIGenerator(config, sdkWith(create)).generate('prompt', Schema, {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(create).not.toHaveBeenCalled();
  });

  test('describeImage rejects an already-aborted reason without calling the provider', async () => {
    const create = vi.fn<OpenAILike['chat']['completions']['create']>();
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);

    await expect(
      makeOpenAIVision(config, sdkWith(create)).describeImage(bytes, 'image/png', 'describe', {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(create).not.toHaveBeenCalled();
  });

  test('generate passes a live signal to chat.completions.create', async () => {
    const create = vi
      .fn<OpenAILike['chat']['completions']['create']>()
      .mockResolvedValueOnce(completion('{"ok":true}'));
    const controller = new AbortController();

    await makeOpenAIGenerator(config, sdkWith(create)).generate('prompt', Schema, {
      signal: controller.signal,
    });

    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });

  test('describeImage passes a live signal to chat.completions.create', async () => {
    const create = vi
      .fn<OpenAILike['chat']['completions']['create']>()
      .mockResolvedValueOnce(completion('description'));
    const controller = new AbortController();

    await makeOpenAIVision(config, sdkWith(create)).describeImage(bytes, 'image/png', 'describe', {
      signal: controller.signal,
    });

    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });

  test('generate prefers an abort reason over a provider error', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const create = vi.fn<OpenAILike['chat']['completions']['create']>(async () => {
      controller.abort(reason);
      throw new Error('provider transport failed');
    });

    await expect(
      makeOpenAIGenerator(config, sdkWith(create)).generate('prompt', Schema, {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  test('describeImage prefers an abort reason over a provider error', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const create = vi.fn<OpenAILike['chat']['completions']['create']>(async () => {
      controller.abort(reason);
      throw new Error('provider transport failed');
    });

    await expect(
      makeOpenAIVision(config, sdkWith(create)).describeImage(bytes, 'image/png', 'describe', {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});
