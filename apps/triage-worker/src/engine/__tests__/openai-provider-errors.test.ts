import { expect, test, vi } from 'vitest';
import OpenAI from 'openai';
import { makeOpenAIEngine, sanitizeOpenAIHardError, type OpenAILike } from '../openai';
import { ProviderConfigurationError } from '../types';
import { createFixture } from './openai.fixture';

const __fixture = createFixture();

test.each([400, 401, 403, 404])(
  'a %s rejection stops the investigation as a ProviderConfigurationError without provider text',
  async (status) => {
    const sdk: OpenAILike = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw new OpenAI.APIError(status, { detail: 'PROMPT-LEAK' }, 'bad', undefined);
          }),
        },
      },
    };
    const engine = makeOpenAIEngine({ apiKey: 'k', model: 'gpt-x' }, sdk);
    const { runtime } = __fixture.makeRuntime();

    const error = await engine.investigate(__fixture.input, runtime).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderConfigurationError);
    expect((error as ProviderConfigurationError).status).toBe(status);
    expect((error as Error).message).toBe(
      `AI provider rejected the configured request (status ${status})`,
    );
  },
);

test('another client error stays a generic hard error named by its caller', () => {
  const error = new OpenAI.APIError(422, { detail: 'PROMPT-LEAK' }, 'bad', undefined);
  expect(sanitizeOpenAIHardError(error)).not.toBeInstanceOf(ProviderConfigurationError);
  expect(sanitizeOpenAIHardError(error).message).toBe('openai request failed with status 422');
  expect(sanitizeOpenAIHardError(error, 'classify').message).toBe(
    'classify request failed with status 422',
  );
});
