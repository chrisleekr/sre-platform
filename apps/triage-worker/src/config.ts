import { DEFAULT_MAX_PROCESSING_MS } from '@sre/queue';

/** LLM engine configuration, all from environment. */
export interface LlmConfig {
  /** LLM_PROVIDER: claude | openai | fake. */
  provider: string;
  anthropic: {
    apiKey?: string;
    oauthToken?: string;
    model: string;
    maxTurns?: number;
    baseUrl?: string;
  };
  openai: { apiKey?: string; model?: string; maxTurns?: number };
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/** Parse a positive integer from env, falling back when unset, non-numeric, or non-positive. */
function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(nonEmpty(v));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface JobDeadlineConfig {
  /** Triage queue per-attempt ceiling in ms (TRIAGE_JOB_DEADLINE_MS). */
  triageMaxProcessingMs: number;
}

/** Load queue processing ceilings from environment.
 *
 * @param env - Environment values to parse.
 */
export function loadJobDeadlineConfig(env: NodeJS.ProcessEnv = process.env): JobDeadlineConfig {
  return {
    triageMaxProcessingMs: positiveInt(env.TRIAGE_JOB_DEADLINE_MS, DEFAULT_MAX_PROCESSING_MS),
  };
}

/**
 * Parse a float in [lo, hi] from env, falling back when unset, non-numeric, or out of range (mirrors
 * positiveInt). Out-of-range falls back rather than clamps: clamping to 0 would silently disable a
 * score floor (searchChunks treats <= 0 as no floor), which is more surprising than the default.
 */
function boundedFloat(v: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = Number(nonEmpty(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}

/** Runbook-seed retrieval configuration. */
export interface RunbookSeedConfig {
  /** Minimum cosine similarity in [0, 1] for a runbook to be seeded into the incident-open brief. */
  scoreFloor: number;
}

export function loadRunbookSeedConfig(env: NodeJS.ProcessEnv = process.env): RunbookSeedConfig {
  return { scoreFloor: boundedFloat(env.RUNBOOK_SEED_SCORE_FLOOR, 0.75, 0, 1) };
}

/** Keep terminal history beyond the effective fairness lookback until the next daily prune. */
export function terminalJobRetentionSec(fairnessWindowSec: number): number {
  return fairnessWindowSec + 86_400;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  return {
    provider: nonEmpty(env.LLM_PROVIDER) ?? '',
    anthropic: {
      apiKey: nonEmpty(env.ANTHROPIC_API_KEY),
      oauthToken: nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN),
      model: nonEmpty(env.ANTHROPIC_MODEL) ?? 'claude-opus-4-8',
      // Max tool-use turns before the loop forces a degraded conclusion.
      maxTurns: positiveInt(env.ANTHROPIC_MAX_TURNS, 8),
    },
    openai: {
      apiKey: nonEmpty(env.OPENAI_API_KEY),
      model: nonEmpty(env.OPENAI_MODEL),
      maxTurns: positiveInt(env.OPENAI_MAX_TURNS, 8),
    },
  };
}
