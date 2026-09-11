import type { LlmUsageObserver, StructuredGenerator, TriageEngine, VisionModel } from './types';
import type { LlmConfig } from '../config';
import { makeFakeEngine, makeFakeGenerator, makeFakeVision } from './fake';
import { makeClaudeEngine } from './claude';
import { makeOpenAIEngine } from './openai';
import { makeClaudeGenerator, makeClaudeVision } from './generator-claude';
import { makeOpenAIGenerator, makeOpenAIVision } from './generator-openai';

/**
 * Select the single triage engine for this deployment. Exactly one provider; no
 * cross-provider fallback. `claude` (apiKey or OAuth) and `openai` (apiKey) are the production
 * engines; `fake` is for dev and tests. An unset or unknown provider — or a selected provider
 * missing its credentials — fails fast.
 */
export function selectEngine(config: LlmConfig, onUsage?: LlmUsageObserver): TriageEngine {
  switch (config.provider) {
    case 'fake':
      return makeFakeEngine();
    case 'claude':
      return makeClaudeEngine(config.anthropic, undefined, onUsage);
    case 'openai':
      return makeOpenAIEngine(config.openai, undefined, onUsage);
    default:
      throw new Error(
        `Invalid LLM_PROVIDER: ${config.provider || '(unset)'} — expected claude | openai`,
      );
  }
}

/**
 * Select the single StructuredGenerator for this deployment, the sibling of
 * {@link selectEngine} for one-shot structured output (e.g. runbook generation). Same rule:
 * exactly one provider, no cross-provider fallback; a selected provider missing its credentials — or
 * an unset/unknown provider — fails fast.
 */
export function selectGenerator(
  config: LlmConfig,
  onUsage?: LlmUsageObserver,
): StructuredGenerator {
  switch (config.provider) {
    case 'fake':
      return makeFakeGenerator();
    case 'claude':
      return makeClaudeGenerator(config.anthropic, undefined, onUsage);
    case 'openai':
      return makeOpenAIGenerator(config.openai, undefined, onUsage);
    default:
      throw new Error(
        `Invalid LLM_PROVIDER: ${config.provider || '(unset)'} — expected claude | openai`,
      );
  }
}

/**
 * Select the single {@link VisionModel} for this deployment, the vision sibling of
 * {@link selectGenerator} for one-shot image interpretation. Same rule: exactly
 * one provider, no cross-provider fallback; a selected provider missing its credentials — or an
 * unset/unknown provider — fails fast. `supportsVision` on the returned model gates the actual call.
 */
export function selectVision(config: LlmConfig, onUsage?: LlmUsageObserver): VisionModel {
  switch (config.provider) {
    case 'fake':
      return makeFakeVision();
    case 'claude':
      return makeClaudeVision(config.anthropic, undefined, onUsage);
    case 'openai':
      return makeOpenAIVision(config.openai, undefined, onUsage);
    default:
      throw new Error(
        `Invalid LLM_PROVIDER: ${config.provider || '(unset)'} — expected claude | openai`,
      );
  }
}
