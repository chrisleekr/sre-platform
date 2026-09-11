import { describe, expect, test } from 'vitest';
import { selectEngine } from '../select';
// Namespace import for the addition: a named import of the not-yet-exported `selectGenerator`
// would be an ESM link error that fails the whole module (breaking the selectEngine tests too). Via
// the namespace it reads as `undefined` until Phase B, so the new tests fail per-assertion with
// "selectGenerator is not a function" (a clean RED) while the existing tests still load and pass.
import * as engineSelect from '../select';
import type { LlmConfig } from '../../config';

function cfg(partial: Partial<LlmConfig>): LlmConfig {
  return {
    provider: partial.provider ?? '',
    anthropic: partial.anthropic ?? { model: 'claude-opus-4-8' },
    openai: partial.openai ?? {},
  };
}

describe('selectEngine (one provider, no fallback)', () => {
  test('fake is available for dev and tests', () => {
    expect(selectEngine(cfg({ provider: 'fake' })).provider).toBe('fake');
  });

  test('claude with a credential resolves to the Claude engine', () => {
    const engine = selectEngine(
      cfg({ provider: 'claude', anthropic: { apiKey: 'sk-x', model: 'claude-opus-4-8' } }),
    );
    expect(engine.provider).toBe('claude');
  });

  test('claude without a credential fails fast', () => {
    expect(() => selectEngine(cfg({ provider: 'claude' }))).toThrow(
      /ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });

  test('openai requires both an API key and a model', () => {
    expect(
      selectEngine(cfg({ provider: 'openai', openai: { apiKey: 'sk-x', model: 'gpt-x' } }))
        .provider,
    ).toBe('openai');
    expect(() => selectEngine(cfg({ provider: 'openai', openai: { model: 'gpt-x' } }))).toThrow(
      /OPENAI_API_KEY/,
    );
    expect(() => selectEngine(cfg({ provider: 'openai', openai: { apiKey: 'sk-x' } }))).toThrow(
      /OPENAI_MODEL/,
    );
  });

  test('an unset or unknown provider fails fast', () => {
    expect(() => selectEngine(cfg({ provider: '' }))).toThrow(/Invalid LLM_PROVIDER/);
    expect(() => selectEngine(cfg({ provider: 'bogus' }))).toThrow(/Invalid LLM_PROVIDER/);
  });
});

// selectGenerator picks the single StructuredGenerator (generate<T>(prompt, schema)) for
// this deployment — same one-provider-no-fallback contract as selectEngine. A selected
// provider missing its credentials, or an unset/unknown provider, fails fast; there is no fallback.
describe('selectGenerator (one provider, no fallback)', () => {
  test('fake resolves to a StructuredGenerator with a generate() method', () => {
    expect(typeof engineSelect.selectGenerator(cfg({ provider: 'fake' })).generate).toBe(
      'function',
    );
  });

  test('claude with a credential resolves to a generator', () => {
    const gen = engineSelect.selectGenerator(
      cfg({ provider: 'claude', anthropic: { apiKey: 'sk-x', model: 'claude-opus-4-8' } }),
    );
    expect(typeof gen.generate).toBe('function');
  });

  test('claude without a credential fails fast (no cross-provider fallback)', () => {
    expect(() => engineSelect.selectGenerator(cfg({ provider: 'claude' }))).toThrow(
      /ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });

  test('openai requires both an API key and a model', () => {
    expect(
      typeof engineSelect.selectGenerator(
        cfg({ provider: 'openai', openai: { apiKey: 'sk-x', model: 'gpt-x' } }),
      ).generate,
    ).toBe('function');
    expect(() =>
      engineSelect.selectGenerator(cfg({ provider: 'openai', openai: { model: 'gpt-x' } })),
    ).toThrow(/OPENAI_API_KEY/);
    expect(() =>
      engineSelect.selectGenerator(cfg({ provider: 'openai', openai: { apiKey: 'sk-x' } })),
    ).toThrow(/OPENAI_MODEL/);
  });

  test('an unset or unknown provider fails fast', () => {
    expect(() => engineSelect.selectGenerator(cfg({ provider: '' }))).toThrow(
      /Invalid LLM_PROVIDER/,
    );
    expect(() => engineSelect.selectGenerator(cfg({ provider: 'bogus' }))).toThrow(
      /Invalid LLM_PROVIDER/,
    );
  });
});
