import * as z from 'zod';
import type { ZodType } from 'zod';
import {
  buildAnthropic,
  claudeAuthMode,
  classifyProviderError,
  sanitizeHardError,
  systemParam,
  observeClaudeUsage,
  type AnthropicLike,
  type ClaudeEngineConfig,
} from './claude';
import type {
  LlmUsageObserver,
  StructuredGenerationOptions,
  StructuredGenerator,
  VisionModel,
} from './types';
import { STRUCTURED_UNTRUSTED_DATA_INSTRUCTION } from './types';

/**
 * The forced single-tool name. Claude's structured-output pattern is a tool_use turn constrained to
 * exactly one tool via `tool_choice`, so the model must emit the schema-shaped object as that tool's
 * input rather than prose. [Anthropic Messages tool-use]
 */
const OUTPUT_TOOL = 'emit_structured_output';

const SYSTEM =
  'Return the answer by calling the provided tool exactly once with a value matching its schema. ' +
  `Do not write prose. ${STRUCTURED_UNTRUSTED_DATA_INSTRUCTION}`;

interface ClaudeBlock {
  type?: string;
  input?: unknown;
}
interface ClaudeResponse {
  content?: ClaudeBlock[];
}

/**
 * Claude binding of `StructuredGenerator`: one forced-tool-use call whose tool input is the
 * structured result, then zod-validated. Reuses the engine's auth (`claudeAuthMode`/`buildAnthropic`/
 * `systemParam` — OAuth quota gate) and error handling (`classifyProviderError`/
 * `sanitizeHardError` — CWE-209). Pass `sdkOverride` in tests. `max_tokens: 4096` — a distilled
 * runbook is larger than a triage turn.
 */
export function makeClaudeGenerator(
  config: ClaudeEngineConfig,
  sdkOverride?: AnthropicLike,
  onUsage?: LlmUsageObserver,
): StructuredGenerator {
  const authMode = claudeAuthMode(config);
  const sdk = sdkOverride ?? buildAnthropic(config, authMode);
  return {
    async generate<T>(
      prompt: string,
      schema: ZodType<T>,
      options?: StructuredGenerationOptions,
    ): Promise<T> {
      if (options?.signal?.aborted) throw options.signal.reason;
      // Anthropic requires the tool input_schema to be a top-level OBJECT schema. A caller schema that
      // is itself a union (e.g. a discriminatedUnion) renders as a top-level `{anyOf:[...]}` with no
      // `type:'object'`, which the API rejects. Wrap it under `result` so input_schema is always an
      // object (the union rides under properties.result), then unwrap the validated value.
      const wrapped = z.object({ result: schema });
      const inputSchema = z.toJSONSchema(wrapped);
      let response: ClaudeResponse;
      try {
        response = (await sdk.messages.create(
          {
            model: config.model,
            max_tokens: 4096,
            system: systemParam(
              authMode,
              options?.system ? `${SYSTEM}\n\n${options.system}` : SYSTEM,
            ),
            tools: [
              {
                name: OUTPUT_TOOL,
                description: 'Emit the structured result matching the provided JSON schema.',
                input_schema: inputSchema,
              },
            ],
            tool_choice: { type: 'tool', name: OUTPUT_TOOL },
            messages: [{ role: 'user', content: prompt }],
          },
          { signal: options?.signal },
        )) as ClaudeResponse;
      } catch (err) {
        if (options?.signal?.aborted) throw options.signal.reason;
        const unavailable = classifyProviderError(err);
        if (unavailable) throw unavailable;
        throw sanitizeHardError(err);
      }
      observeClaudeUsage(response, config.model, onUsage);
      // A forced single tool yields exactly one tool_use block; validate against the wrapped schema
      // and unwrap the caller's value from `result`.
      const toolUse = (response.content ?? []).find((b) => b.type === 'tool_use');
      if (!toolUse) throw new Error('claude returned no structured output');
      return wrapped.parse(toolUse.input).result;
    },
  };
}

/**
 * Whether a Claude model can interpret an image. Mirrors `supportsTemperature`:
 * a narrow model-capability guard. Claude 3+ (opus/sonnet/haiku families and the 4/5 lines) are
 * vision-capable; the legacy claude-2 / instant text models are not.
 */
export function claudeSupportsVision(model: string): boolean {
  return /(opus|sonnet|haiku|claude-3|claude-[4-9])/i.test(model);
}

interface ClaudeTextBlock {
  type?: string;
  text?: string;
}

/**
 * Claude binding of {@link VisionModel}: one Messages call carrying a base64 image
 * content block plus the caller's prompt. Reuses the engine's auth (`claudeAuthMode`/`buildAnthropic`/
 * `systemParam` — OAuth quota gate) and error handling (`classifyProviderError`/
 * `sanitizeHardError` — CWE-209). `supportsVision` gates the call upstream in `interpretImage`.
 */
export function makeClaudeVision(
  config: ClaudeEngineConfig,
  sdkOverride?: AnthropicLike,
  onUsage?: LlmUsageObserver,
): VisionModel {
  const authMode = claudeAuthMode(config);
  const sdk = sdkOverride ?? buildAnthropic(config, authMode);
  return {
    provider: 'claude',
    supportsVision: claudeSupportsVision(config.model),
    async describeImage(
      bytes: ArrayBuffer,
      mime: string,
      prompt: string,
      options?: { signal?: AbortSignal },
    ): Promise<string> {
      if (options?.signal?.aborted) throw options.signal.reason;
      const data = Buffer.from(bytes).toString('base64');
      let response: { content?: ClaudeTextBlock[] };
      try {
        response = (await sdk.messages.create(
          {
            model: config.model,
            max_tokens: 1024,
            system: systemParam(authMode, SYSTEM),
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: mime, data } },
                  { type: 'text', text: prompt },
                ],
              },
            ],
          },
          { signal: options?.signal },
        )) as { content?: ClaudeTextBlock[] };
      } catch (err) {
        if (options?.signal?.aborted) throw options.signal.reason;
        const unavailable = classifyProviderError(err);
        if (unavailable) throw unavailable;
        throw sanitizeHardError(err);
      }
      observeClaudeUsage(response, config.model, onUsage);
      return (response.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text ?? '')
        .join('');
    },
  };
}
