import { describe, expect, test } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { baseOptions, runQuery } from '../agent-sdk/query';
import {
  ProviderConfigurationError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '../types';
import { createFixture } from './agent-sdk.fixture';

const fixture = createFixture();

describe('Claude rate-limit failures', () => {
  const failure = fixture.result({
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['Execution failed'],
  });
  async function run(messages: SDKMessage[], error?: Error) {
    const config = {
      runtime: fixture.runtime,
      credential: 'test-key',
      query: fixture.scriptedQuery(messages, () => {}, error),
    };
    return runQuery(config, 'Check service health', baseOptions(config, 'Investigate'));
  }

  test('recognizes the observed provider wording without exposing raw result text', async () => {
    await expect(
      run([
        fixture.result({
          subtype: 'error_during_execution',
          is_error: true,
          errors: [
            "This request would exceed your account's rate limit. Please try again later. secret",
          ],
        }),
      ]),
    ).rejects.toEqual(new ProviderRateLimitError());
  });

  test('uses structured assistant errors even when the final result is generic', async () => {
    const message = { type: 'assistant', error: 'rate_limit' } as SDKMessage;
    await expect(run([message, failure])).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  test('stops SDK rate-limit retries instead of waiting for its retry delay', async () => {
    const message = {
      type: 'system',
      subtype: 'api_retry',
      error: 'rate_limit',
      error_status: 429,
      retry_delay_ms: 180_000,
    } as SDKMessage;
    let consumedAfterRetry = false;
    const config = {
      runtime: fixture.runtime,
      credential: 'test-key',
      query: fixture.scriptedQuery([message, failure], () => {}),
    };
    const options = baseOptions(config, 'Investigate');
    const originalQuery = config.query;
    config.query = ((input: Parameters<typeof originalQuery>[0]) => {
      const stream = originalQuery(input);
      return (async function* () {
        for await (const event of stream) {
          yield event;
          consumedAfterRetry = true;
        }
      })() as ReturnType<typeof originalQuery>;
    }) as typeof originalQuery;
    const error = await runQuery(config, 'Check health', options).catch((error) => error);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).not.toHaveProperty('retryAfterMs');
    expect(options.abortController?.signal.aborted).toBe(true);
    expect(options.abortController?.signal.reason).toBe(error);
    expect(consumedAfterRetry).toBe(false);
  });

  test('uses the terminal HTTP status rather than guessing from generic text or earlier errors', async () => {
    await expect(
      run([fixture.result({ is_error: true, api_error_status: 429, result: 'Request failed' })]),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
    const earlier = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected' },
    } as SDKMessage;
    const error = await run([
      earlier,
      fixture.result({ is_error: true, api_error_status: 401 }),
    ]).catch((error) => error);
    expect(error).not.toBeInstanceOf(ProviderRateLimitError);
    expect(error).toBeInstanceOf(ProviderConfigurationError);
    expect(error.message).toBe('AI provider rejected the configured request (status 401)');
  });

  test('classifies a rejected request by status, keeping 5xx retryable', async () => {
    // An unknown model id comes back as a 400 success-subtype result with zero tokens.
    const rejected = await run([
      fixture.result({ is_error: true, api_error_status: 400, result: 'model secret' }),
    ]).catch((error) => error);
    expect(rejected).toBeInstanceOf(ProviderConfigurationError);
    expect(rejected.status).toBe(400);
    expect(rejected.message).not.toContain('secret');
    await expect(
      run([fixture.result({ is_error: true, api_error_status: 503 })]),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    const other = await run([fixture.result({ is_error: true, api_error_status: 422 })]).catch(
      (error) => error,
    );
    expect(other).not.toBeInstanceOf(ProviderConfigurationError);
    expect(other.message).toBe('Claude Agent SDK execution failed (status 422)');
  });

  test('recognizes thrown rate limits and keeps unrelated errors generic', async () => {
    await expect(run([], new Error('HTTP 429 secret'))).rejects.toBeInstanceOf(
      ProviderRateLimitError,
    );
    await expect(run([failure])).rejects.toThrow('Claude Agent SDK execution failed');
    await expect(run([], new Error('invalid credentials secret'))).rejects.toThrow(
      'Claude Agent SDK query failed',
    );
  });

  test('does not turn a recovered limit or usage warning into a failure', async () => {
    const rejected = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning' },
    } as SDKMessage;
    await expect(run([rejected, fixture.result()])).resolves.toHaveProperty(
      'result.is_error',
      false,
    );
  });

  test('does not mislabel an unrelated failure after a successful provider turn', async () => {
    const rejected = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected' },
    } as SDKMessage;
    const recovered = { type: 'assistant' } as SDKMessage;
    await expect(run([rejected, recovered, failure])).rejects.toThrow(
      'Claude Agent SDK execution failed',
    );
  });
});
