import OpenAI from 'openai';
import { toJSONSchema, type ZodType } from 'zod';
import { parseStructuredOutput } from './structured-repair';
import { providerFetch } from './provider-fetch';
import {
  openaiText,
  observeOpenAIUsage,
  sanitizeOpenAIHardError,
  supportsTemperature,
  type OpenAIEngineConfig,
  type OpenAILike,
} from './openai';
import {
  ProviderUnavailableError,
  ProviderRateLimitError,
  STRUCTURED_UNTRUSTED_DATA_INSTRUCTION,
  type LlmUsageObserver,
  type StructuredGenerationOptions,
  type StructuredGenerator,
  type VisionModel,
} from './types';

const JSON_INSTRUCTION =
  'Respond ONLY with a single JSON object matching the requested schema — no prose, no code fences. ' +
  STRUCTURED_UNTRUSTED_DATA_INSTRUCTION;

/** Extract the first JSON object from the model text (tolerates stray wrapping). */
function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('openai returned no JSON object');
  return JSON.parse(match[0]);
}

/**
 * Map an OpenAI SDK error to a provider-agnostic `ProviderUnavailableError` on an availability
 * failure (connection/timeout with no status, 429, or >= 500) so the caller degrades and redelivers;
 * else return null (hard error, fail fast). Message is a fixed sanitized string (CWE-209).
 */
function classifyOpenAIError(err: unknown): ProviderUnavailableError | null {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 429) throw new ProviderRateLimitError();
    if (status === undefined || status === 429 || status >= 500) {
      return new ProviderUnavailableError('openai provider unavailable');
    }
  }
  return null;
}

/**
 * OpenAI binding of `StructuredGenerator`: a single chat.completions call instructing
 * JSON-only output, parsed and zod-validated (mirrors the OpenAI engine's `complete`). Authenticated
 * by API key. Pass `sdkOverride` in tests.
 */
export function makeOpenAIGenerator(
  config: OpenAIEngineConfig,
  sdkOverride?: OpenAILike,
  onUsage?: LlmUsageObserver,
): StructuredGenerator {
  if (!config.apiKey) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
  if (!config.model) throw new Error('LLM_PROVIDER=openai requires OPENAI_MODEL');
  const model = config.model;
  const sdk =
    sdkOverride ??
    (new OpenAI({ apiKey: config.apiKey, fetch: providerFetch }) as unknown as OpenAILike);
  return {
    async generate<T>(
      prompt: string,
      schema: ZodType<T>,
      options?: StructuredGenerationOptions,
    ): Promise<T> {
      if (options?.signal?.aborted) throw options.signal.reason;
      let raw: unknown;
      try {
        raw = await sdk.chat.completions.create(
          {
            model,
            // Deterministic structured output: temperature 0. Sent only for models that accept it
            // (reasoning models reject temperature != 1); the Claude path never sends temperature.
            ...(supportsTemperature(model) ? { temperature: 0 } : {}),
            messages: [
              {
                role: 'system',
                content: options?.system
                  ? `${JSON_INSTRUCTION}\n\n${options.system}`
                  : JSON_INSTRUCTION,
              },
              {
                role: 'user',
                content: `${prompt}\n\nRequired result schema:\n${JSON.stringify(toJSONSchema(schema))}`,
              },
            ],
          },
          { signal: options?.signal },
        );
      } catch (err) {
        if (options?.signal?.aborted) throw options.signal.reason;
        const unavailable = classifyOpenAIError(err);
        if (unavailable) throw unavailable;
        throw sanitizeOpenAIHardError(err);
      }
      observeOpenAIUsage(raw, model, onUsage);
      return parseStructuredOutput(schema, extractJson(openaiText(raw)), options);
    },
  };
}

/**
 * Whether an OpenAI model can interpret an image. Mirrors `supportsTemperature`:
 * a narrow capability guard. The gpt-4/gpt-5 lines and the o-series reasoning models accept image
 * parts; gpt-3.5 and older text models do not.
 */
export function openaiSupportsVision(model: string): boolean {
  return /(gpt-4|gpt-5|o\d)/i.test(model);
}

/**
 * OpenAI binding of {@link VisionModel}: a single chat.completions call with a
 * base64 data-url image part plus the caller's prompt. Authenticated by API key.
 * `supportsVision` gates the call upstream in `interpretImage`.
 */
export function makeOpenAIVision(
  config: OpenAIEngineConfig,
  sdkOverride?: OpenAILike,
  onUsage?: LlmUsageObserver,
): VisionModel {
  if (!config.apiKey) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
  if (!config.model) throw new Error('LLM_PROVIDER=openai requires OPENAI_MODEL');
  const model = config.model;
  const sdk = sdkOverride ?? (new OpenAI({ apiKey: config.apiKey }) as unknown as OpenAILike);
  return {
    provider: 'openai',
    supportsVision: openaiSupportsVision(model),
    async describeImage(
      bytes: ArrayBuffer,
      mime: string,
      prompt: string,
      options?: { signal?: AbortSignal },
    ): Promise<string> {
      if (options?.signal?.aborted) throw options.signal.reason;
      const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
      let raw: unknown;
      try {
        raw = await sdk.chat.completions.create(
          {
            model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
          },
          { signal: options?.signal },
        );
      } catch (err) {
        if (options?.signal?.aborted) throw options.signal.reason;
        const unavailable = classifyOpenAIError(err);
        if (unavailable) throw unavailable;
        throw sanitizeOpenAIHardError(err);
      }
      observeOpenAIUsage(raw, model, onUsage);
      return openaiText(raw);
    },
  };
}
