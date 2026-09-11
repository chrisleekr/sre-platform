export const LLM_RUNTIMES = ['claude-agent-sdk', 'openai-chat'] as const;
export type LlmRuntime = (typeof LLM_RUNTIMES)[number];

export const LLM_PROVIDERS = ['anthropic', 'custom-anthropic', 'bedrock', 'openai'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const LLM_AUTH_MODES = ['api-key', 'oauth', 'ambient'] as const;
export type LlmAuthMode = (typeof LLM_AUTH_MODES)[number];

export interface LlmPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

/**
 * Whether configured pricing can account for every invocation's core input and output usage.
 *
 * @param pricing - Custom token rates, or null when configured-cost reporting is disabled.
 */
export function isUsableLlmPricing(pricing: LlmPricing | null): pricing is LlmPricing {
  return (
    pricing !== null &&
    Number.isFinite(pricing.inputPerMTok) &&
    pricing.inputPerMTok > 0 &&
    Number.isFinite(pricing.outputPerMTok) &&
    pricing.outputPerMTok > 0 &&
    Number.isFinite(pricing.cacheReadPerMTok) &&
    pricing.cacheReadPerMTok >= 0 &&
    Number.isFinite(pricing.cacheWritePerMTok) &&
    pricing.cacheWritePerMTok >= 0
  );
}

/** One platform-wide runtime configuration. Historical invocations snapshot this value. */
export interface LlmRuntimeConfig {
  runtime: LlmRuntime;
  provider: LlmProvider;
  model: string;
  baseUrl: string | null;
  authMode: LlmAuthMode;
  maxTurns: number;
  pricing: LlmPricing | null;
}

export interface LlmSettingsResponse {
  config: LlmRuntimeConfig;
  source: 'stored' | 'environment';
  credentialConfigured: boolean;
  updatedAt: string | null;
}

export interface UpdateLlmSettingsRequest {
  config: LlmRuntimeConfig;
  /** Write-only. Omit to retain the current encrypted or environment-provided credential. */
  credential?: string;
}

export const LLM_OPERATIONS = [
  'classify',
  'characterize',
  'cohort-correlate',
  'investigate',
  'reassess',
  'resume',
  'verify-recovery',
  'interpret-image',
  'runbook-distill',
  'runbook-decide',
  'postmortem-generate',
  'assessment-grade',
  'responder-intent',
  'assessment-reconcile',
] as const;
export type LlmOperation = (typeof LLM_OPERATIONS)[number];

export interface LlmTokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface LlmUsageSummary {
  from: string;
  to: string;
  invocations: number;
  succeeded: number;
  failed: number;
  unpriced: number;
  missingUsage: number;
  configuredCostUsd: number;
  providerEstimatedCostUsd: number | null;
  tokens: LlmTokenCounts;
  series: Array<{
    bucketAt: string;
    invocations: number;
    failed: number;
    configuredCostUsd: number;
    tokens: number;
  }>;
  byOperation: Array<{
    operation: LlmOperation;
    invocations: number;
    configuredCostUsd: number;
    unpriced: number;
  }>;
  byModel: Array<{
    runtime: LlmRuntime;
    provider: LlmProvider;
    model: string;
    invocations: number;
    configuredCostUsd: number;
    unpriced: number;
  }>;
}

export interface IncidentLlmUsage {
  incidentId: string;
  invocations: number;
  configuredCostUsd: number;
  providerEstimatedCostUsd: number | null;
  unpriced: number;
  missingUsage: number;
  tokens: LlmTokenCounts;
}
