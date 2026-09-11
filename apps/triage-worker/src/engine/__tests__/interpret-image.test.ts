import { describe, expect, test, vi } from 'vitest';
import { interpretImage, VISION_PROMPT } from '../interpret-image';
import { VisionUnsupported, type VisionModel } from '../types';
import { makeClaudeVision } from '../generator-claude';
import { makeOpenAIVision } from '../generator-openai';

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer; // PNG magic

describe('interpretImage', () => {
  test('throws VisionUnsupported without calling the provider when the model lacks vision', async () => {
    const describeImage =
      vi.fn<(bytes: ArrayBuffer, mime: string, prompt: string) => Promise<string>>();
    const vision: VisionModel = { provider: 'claude', supportsVision: false, describeImage };
    await expect(interpretImage(vision, bytes, 'image/png')).rejects.toBeInstanceOf(
      VisionUnsupported,
    );
    // No cross-provider fallback and no provider call at all.
    expect(describeImage).not.toHaveBeenCalled();
  });

  test('calls the single configured provider with the untrusted-data vision prompt', async () => {
    const describeImage = vi.fn<
      (bytes: ArrayBuffer, mime: string, prompt: string) => Promise<string>
    >(async () => 'error 500 on checkout at 10:02');
    const vision: VisionModel = { provider: 'claude', supportsVision: true, describeImage };
    const out = await interpretImage(vision, bytes, 'image/png');
    expect(out).toBe('error 500 on checkout at 10:02');
    expect(describeImage).toHaveBeenCalledTimes(1);
    const [passedBytes, passedMime, passedPrompt] = describeImage.mock.calls[0]!;
    expect(passedBytes).toBe(bytes);
    expect(passedMime).toBe('image/png');
    expect(passedPrompt).toBe(VISION_PROMPT);
    expect(VISION_PROMPT).toMatch(/untrusted/i);
  });
});

describe('makeClaudeVision', () => {
  test('reports supportsVision by model capability (opus-4-8 yes, legacy no)', () => {
    const sdk = { messages: { create: vi.fn() } };
    expect(makeClaudeVision({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk).supportsVision).toBe(
      true,
    );
    expect(makeClaudeVision({ apiKey: 'k', model: 'claude-2.1' }, sdk).supportsVision).toBe(false);
  });

  test('sends a base64 image block + the prompt in one Messages call', async () => {
    const create = vi.fn<(req: unknown) => Promise<unknown>>(async () => ({
      content: [{ type: 'text', text: 'a graph' }],
    }));
    const vision = makeClaudeVision(
      { apiKey: 'k', model: 'claude-opus-4-8' },
      { messages: { create } },
    );
    const out = await vision.describeImage(bytes, 'image/png', 'describe');
    expect(out).toBe('a graph');
    const req = create.mock.calls[0]![0] as {
      messages: { content: { type: string; source?: { media_type?: string } }[] }[];
    };
    const content = req.messages[0]!.content;
    expect(content.some((b) => b.type === 'image' && b.source?.media_type === 'image/png')).toBe(
      true,
    );
    expect(content.some((b) => b.type === 'text')).toBe(true);
  });
});

describe('makeOpenAIVision', () => {
  test('reports supportsVision by model capability (gpt-4o yes, gpt-3.5 no)', () => {
    const sdk = { chat: { completions: { create: vi.fn() } } };
    expect(makeOpenAIVision({ apiKey: 'k', model: 'gpt-4o' }, sdk).supportsVision).toBe(true);
    expect(makeOpenAIVision({ apiKey: 'k', model: 'gpt-3.5-turbo' }, sdk).supportsVision).toBe(
      false,
    );
  });

  test('sends a base64 data-url image_url part', async () => {
    const create = vi.fn<(req: unknown) => Promise<unknown>>(async () => ({
      choices: [{ message: { content: 'a chart' } }],
    }));
    const vision = makeOpenAIVision(
      { apiKey: 'k', model: 'gpt-4o' },
      { chat: { completions: { create } } },
    );
    const out = await vision.describeImage(bytes, 'image/png', 'describe');
    expect(out).toBe('a chart');
    const req = create.mock.calls[0]![0] as {
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    const part = req.messages[0]!.content.find((p) => p.type === 'image_url');
    expect(part?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
  });
});
