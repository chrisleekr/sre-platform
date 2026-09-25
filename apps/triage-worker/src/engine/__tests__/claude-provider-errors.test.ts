import { describe, expect, test, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { makeClaudeProvider, sanitizeHardError } from '../claude';
import { ProviderConfigurationError } from '../types';

describe('sanitizeHardError configuration rejections', () => {
  test('400/401/403/404 become ProviderConfigurationError without provider text', () => {
    for (const status of [400, 401, 403, 404]) {
      const safe = sanitizeHardError(
        Anthropic.APIError.generate(status, { detail: 'PROMPT-LEAK' }, 'bad', new Headers()),
      );
      expect(safe).toBeInstanceOf(ProviderConfigurationError);
      expect((safe as ProviderConfigurationError).status).toBe(status);
      expect(safe.message).toBe(`AI provider rejected the configured request (status ${status})`);
    }
  });

  test('another client error stays a generic hard error that keeps its status', () => {
    const other = sanitizeHardError(Anthropic.APIError.generate(422, {}, 'bad', new Headers()));
    expect(other).not.toBeInstanceOf(ProviderConfigurationError);
    expect(other.message).toBe('claude request failed with status 422');
  });
});

describe('makeClaudeProvider tool choice', () => {
  test('never sends a forced tool_choice, even when the loop names a tool', async () => {
    // Opus 5.5 returns 400 for tool_choice tool/any; the loop validates the terminal call itself.
    const create = vi.fn(async (_req: unknown) => ({ content: [], stop_reason: 'end_turn' }));
    const provider = makeClaudeProvider({ messages: { create } }, 'apikey', 'claude-opus-5-5');
    await provider.call('system', [], [], 'report_findings');
    expect(create.mock.calls[0]![0]).not.toHaveProperty('tool_choice');
  });
});
