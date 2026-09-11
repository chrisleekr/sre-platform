import { describe, expect, test } from 'vitest';
import { loadLlmConfig, loadRunbookSeedConfig, terminalJobRetentionSec } from '../config';

describe('loadLlmConfig', () => {
  test('reads and trims env, defaulting the anthropic model', () => {
    const c = loadLlmConfig({
      LLM_PROVIDER: ' claude ',
      ANTHROPIC_API_KEY: ' sk-a ',
      OPENAI_API_KEY: 'sk-o',
      OPENAI_MODEL: 'gpt-x',
    } as NodeJS.ProcessEnv);
    expect(c.provider).toBe('claude');
    expect(c.anthropic.apiKey).toBe('sk-a');
    expect(c.anthropic.model).toBe('claude-opus-4-8');
    expect(c.openai).toEqual({ apiKey: 'sk-o', model: 'gpt-x', maxTurns: 8 });
  });

  test('blank values become undefined', () => {
    const c = loadLlmConfig({ LLM_PROVIDER: '   ', ANTHROPIC_API_KEY: '' } as NodeJS.ProcessEnv);
    expect(c.provider).toBe('');
    expect(c.anthropic.apiKey).toBeUndefined();
  });

  test('honors an ANTHROPIC_MODEL override', () => {
    expect(
      loadLlmConfig({ ANTHROPIC_MODEL: 'claude-sonnet-4-6' } as NodeJS.ProcessEnv).anthropic.model,
    ).toBe('claude-sonnet-4-6');
  });

  test('defaults ANTHROPIC_MAX_TURNS to 8 and honors a valid override', () => {
    expect(loadLlmConfig({} as NodeJS.ProcessEnv).anthropic.maxTurns).toBe(8);
    expect(
      loadLlmConfig({ ANTHROPIC_MAX_TURNS: '5' } as NodeJS.ProcessEnv).anthropic.maxTurns,
    ).toBe(5);
  });

  test('falls back to 8 on a non-positive or non-numeric ANTHROPIC_MAX_TURNS', () => {
    expect(
      loadLlmConfig({ ANTHROPIC_MAX_TURNS: '0' } as NodeJS.ProcessEnv).anthropic.maxTurns,
    ).toBe(8);
    expect(
      loadLlmConfig({ ANTHROPIC_MAX_TURNS: '-3' } as NodeJS.ProcessEnv).anthropic.maxTurns,
    ).toBe(8);
    expect(
      loadLlmConfig({ ANTHROPIC_MAX_TURNS: 'abc' } as NodeJS.ProcessEnv).anthropic.maxTurns,
    ).toBe(8);
  });

  test('defaults OPENAI_MAX_TURNS to 8 and honors a valid override', () => {
    expect(loadLlmConfig({} as NodeJS.ProcessEnv).openai.maxTurns).toBe(8);
    expect(loadLlmConfig({ OPENAI_MAX_TURNS: '12' } as NodeJS.ProcessEnv).openai.maxTurns).toBe(12);
  });
});

describe('terminalJobRetentionSec', () => {
  test('keeps terminal job history for the effective fairness window plus one day', () => {
    expect(terminalJobRetentionSec(3600)).toBe(90_000);
    expect(terminalJobRetentionSec(900)).toBe(87_300);
  });
});

// RUNBOOK_SEED_SCORE_FLOOR gates which retrieved runbooks are proactively seeded
// into the incident-open brief. It is a cosine similarity in [0, 1]; default 0.75. A missing, non-
// numeric, or out-of-range value falls back to the default (mirrors positiveInt's fallback contract,
// and avoids silently disabling the floor by clamping to 0). RED until loadRunbookSeedConfig exists.
describe('loadRunbookSeedConfig', () => {
  test('defaults the score floor to 0.75 when unset', () => {
    expect(loadRunbookSeedConfig({} as NodeJS.ProcessEnv).scoreFloor).toBe(0.75);
  });

  test('accepts a valid float in [0, 1]', () => {
    expect(
      loadRunbookSeedConfig({ RUNBOOK_SEED_SCORE_FLOOR: '0.8' } as NodeJS.ProcessEnv).scoreFloor,
    ).toBe(0.8);
    expect(
      loadRunbookSeedConfig({ RUNBOOK_SEED_SCORE_FLOOR: '0' } as NodeJS.ProcessEnv).scoreFloor,
    ).toBe(0);
    expect(
      loadRunbookSeedConfig({ RUNBOOK_SEED_SCORE_FLOOR: '1' } as NodeJS.ProcessEnv).scoreFloor,
    ).toBe(1);
  });

  test('falls back to 0.75 on a non-numeric or out-of-range value', () => {
    expect(
      loadRunbookSeedConfig({ RUNBOOK_SEED_SCORE_FLOOR: 'abc' } as NodeJS.ProcessEnv).scoreFloor,
    ).toBe(0.75);
    expect(
      loadRunbookSeedConfig({ RUNBOOK_SEED_SCORE_FLOOR: '1.5' } as NodeJS.ProcessEnv).scoreFloor,
    ).toBe(0.75);
    expect(
      loadRunbookSeedConfig({ RUNBOOK_SEED_SCORE_FLOOR: '-0.2' } as NodeJS.ProcessEnv).scoreFloor,
    ).toBe(0.75);
  });
});
