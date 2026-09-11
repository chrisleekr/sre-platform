// The two secret-free identity derivations. Pure functions over a validated config: no Postgres and
// no Valkey, so this file writes nothing to the global platform_settings table and cannot race the
// store tests beside it. Split out because index.test.ts is at its line cap.
import { describe, expect, test } from 'vitest';
import { llmCredentialSecretName, llmRuntimeFingerprint } from '../index';

describe('LLM runtime identity', () => {
  test('binds classifier approval to the model-visible authentication mode', () => {
    const config = {
      runtime: 'claude-agent-sdk' as const,
      provider: 'anthropic' as const,
      model: 'claude-test',
      baseUrl: null,
      authMode: 'api-key' as const,
      maxTurns: 8,
      pricing: null,
    };
    expect(llmRuntimeFingerprint(config)).not.toBe(
      llmRuntimeFingerprint({ ...config, authMode: 'oauth' }),
    );
  });

  test('scopes custom-provider credentials to the canonical endpoint', () => {
    const config = {
      runtime: 'claude-agent-sdk' as const,
      provider: 'custom-anthropic' as const,
      model: 'claude-test',
      baseUrl: 'https://llm.example.com/v1',
      authMode: 'api-key' as const,
      maxTurns: 8,
      pricing: null,
    };
    expect(llmCredentialSecretName(config)).toBe(
      llmCredentialSecretName({ ...config, baseUrl: 'https://LLM.example.com/v1' }),
    );
    expect(llmCredentialSecretName(config)).not.toBe(
      llmCredentialSecretName({ ...config, baseUrl: 'https://other.example.com/v1' }),
    );
  });
});
