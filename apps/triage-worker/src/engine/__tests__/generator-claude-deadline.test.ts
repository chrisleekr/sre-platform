import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import type { AnthropicLike } from '../claude';
import { makeClaudeGenerator, makeClaudeVision } from '../generator-claude';

const Schema = z.object({ ok: z.boolean() });
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

function sdkWith(create: AnthropicLike['messages']['create']): AnthropicLike {
  return { messages: { create } };
}

function structuredResponse() {
  return {
    content: [
      { type: 'tool_use', name: 'emit_structured_output', input: { result: { ok: true } } },
    ],
  };
}

describe('Claude one-shot deadline signal', () => {
  const config = { apiKey: 'k', model: 'claude-opus-4-8' };

  test('generate rejects an already-aborted reason without calling the provider', async () => {
    const create = vi.fn<AnthropicLike['messages']['create']>();
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);

    await expect(
      makeClaudeGenerator(config, sdkWith(create)).generate('prompt', Schema, {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(create).not.toHaveBeenCalled();
  });

  test('describeImage rejects an already-aborted reason without calling the provider', async () => {
    const create = vi.fn<AnthropicLike['messages']['create']>();
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);

    await expect(
      makeClaudeVision(config, sdkWith(create)).describeImage(bytes, 'image/png', 'describe', {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(create).not.toHaveBeenCalled();
  });

  test('generate passes a live signal to messages.create', async () => {
    const create = vi
      .fn<AnthropicLike['messages']['create']>()
      .mockResolvedValueOnce(structuredResponse());
    const controller = new AbortController();

    await makeClaudeGenerator(config, sdkWith(create)).generate('prompt', Schema, {
      signal: controller.signal,
    });

    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });

  test('describeImage passes a live signal to messages.create', async () => {
    const create = vi
      .fn<AnthropicLike['messages']['create']>()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'description' }] });
    const controller = new AbortController();

    await makeClaudeVision(config, sdkWith(create)).describeImage(bytes, 'image/png', 'describe', {
      signal: controller.signal,
    });

    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });

  test('generate prefers an abort reason over a provider error', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const create = vi.fn<AnthropicLike['messages']['create']>(async () => {
      controller.abort(reason);
      throw new Error('provider transport failed');
    });

    await expect(
      makeClaudeGenerator(config, sdkWith(create)).generate('prompt', Schema, {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  test('describeImage prefers an abort reason over a provider error', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const create = vi.fn<AnthropicLike['messages']['create']>(async () => {
      controller.abort(reason);
      throw new Error('provider transport failed');
    });

    await expect(
      makeClaudeVision(config, sdkWith(create)).describeImage(bytes, 'image/png', 'describe', {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});
