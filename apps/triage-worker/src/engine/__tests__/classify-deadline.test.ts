import type { InboundCandidate } from '@sre/connectors';
import { describe, expect, test, vi } from 'vitest';
import { CLASSIFY_TOOL_NAME, makeClaudeClassifier, makeOpenAIClassifier } from '../classify';
import type { AnthropicLike } from '../claude';
import type { OpenAILike } from '../openai';

const candidate: InboundCandidate = {
  externalId: 'message-1',
  channel: 'channel-1',
  author: 'human',
  text: 'checkout is returning 500s',
  raw: {},
  signalState: 'unknown',
  eventKey: 'slack:channel-1:message-1',
  eventAt: '2026-09-08T00:00:00.000Z',
  contentHash: 'hash',
  isEdit: false,
};

function claudeSdk(create: AnthropicLike['messages']['create']): AnthropicLike {
  return { messages: { create } };
}

function openaiSdk(create: OpenAILike['chat']['completions']['create']): OpenAILike {
  return { chat: { completions: { create } } };
}

function claudeVerdict() {
  return {
    content: [{ type: 'tool_use', name: CLASSIFY_TOOL_NAME, input: { decision: 'not_worthy' } }],
  };
}

function openaiVerdict() {
  return { choices: [{ message: { content: '{"decision":"not_worthy"}' } }] };
}

describe('classifier deadline signal', () => {
  test('Claude rejects an already-aborted reason without calling the provider', async () => {
    const create = vi.fn<AnthropicLike['messages']['create']>();
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);

    await expect(
      makeClaudeClassifier({ apiKey: 'k', model: 'claude-opus-4-8' }, claudeSdk(create)).classify(
        candidate,
        [],
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(create).not.toHaveBeenCalled();
  });

  test('OpenAI rejects an already-aborted reason without calling the provider', async () => {
    const create = vi.fn<OpenAILike['chat']['completions']['create']>();
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);

    await expect(
      makeOpenAIClassifier({ apiKey: 'k', model: 'gpt-5' }, openaiSdk(create)).classify(
        candidate,
        [],
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(create).not.toHaveBeenCalled();
  });

  test('Claude passes a live signal to messages.create', async () => {
    const create = vi
      .fn<AnthropicLike['messages']['create']>()
      .mockResolvedValueOnce(claudeVerdict());
    const controller = new AbortController();

    await makeClaudeClassifier(
      { apiKey: 'k', model: 'claude-opus-4-8' },
      claudeSdk(create),
    ).classify(candidate, [], undefined, { signal: controller.signal });

    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });

  test('OpenAI passes a live signal to chat.completions.create', async () => {
    const create = vi
      .fn<OpenAILike['chat']['completions']['create']>()
      .mockResolvedValueOnce(openaiVerdict());
    const controller = new AbortController();

    await makeOpenAIClassifier({ apiKey: 'k', model: 'gpt-5' }, openaiSdk(create)).classify(
      candidate,
      [],
      undefined,
      { signal: controller.signal },
    );

    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
  });

  test('Claude prefers an abort reason over a provider error', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const create = vi.fn<AnthropicLike['messages']['create']>(async () => {
      controller.abort(reason);
      throw new Error('provider transport failed');
    });

    await expect(
      makeClaudeClassifier({ apiKey: 'k', model: 'claude-opus-4-8' }, claudeSdk(create)).classify(
        candidate,
        [],
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });

  test('OpenAI prefers an abort reason over a provider error', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const create = vi.fn<OpenAILike['chat']['completions']['create']>(async () => {
      controller.abort(reason);
      throw new Error('provider transport failed');
    });

    await expect(
      makeOpenAIClassifier({ apiKey: 'k', model: 'gpt-5' }, openaiSdk(create)).classify(
        candidate,
        [],
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });
});
