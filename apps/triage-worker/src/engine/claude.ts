import Anthropic from '@anthropic-ai/sdk';
import { toJsonSchema, type ToolDefinition } from '@sre/agent-tools';
import { ProviderRateLimitError, ProviderUnavailableError } from './types';
import { providerFetch } from './provider-fetch';
import type {
  RecoveryInput,
  ResumeInput,
  TriageEngine,
  TriageInput,
  TriageResult,
  TriageRuntime,
  LlmUsageObserver,
} from './types';
import type { LoopProvider, ModelTurn, TerminalName, ToolCall, ToolRunResult } from './loop';
import { runLoop } from './loop';
import { REPORT_FINDINGS_NAME } from './report-findings';
import { REPORT_RECOVERY_NAME } from './report-recovery';
import { RESPOND_NAME } from './respond';
import { STAY_SILENT_NAME } from './stay-silent';
import { SUGGEST_ACTION_NAME } from './suggest-action';
import {
  RECOVERY_SYSTEM_PROMPT,
  REASSESS_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
  buildInvestigationPrompt,
  buildRecoveryPrompt,
  buildResumePrompt,
  reassessmentTurnBudget,
} from './shared';

/**
 * Anthropic gates `sk-ant-oat...` OAuth tokens to a degraded-quota pool unless the FIRST system
 * block is exactly this identifier. The check is exact-match on the first block, so the OAuth path
 * uses the array form `[{identifier}, {caller system}]` to keep both intact.
 */
export const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";

export type ClaudeAuthMode = 'apikey' | 'oauth';

/**
 * Classify a thrown Claude SDK error: return a ProviderUnavailableError for an availability failure
 * (connection/timeout with no status, or >= 500). Rate limits are terminal instead.
 * else null so the worker treats it as a hard error and dead-letters fast. The message is a fixed
 * sanitized string, never the raw SDK text, so no provider/credential detail is persisted (CWE-209).
 */
export function classifyProviderError(
  err: unknown,
): ProviderUnavailableError | ProviderRateLimitError | null {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 429) return new ProviderRateLimitError();
    if (status === undefined || status >= 500) {
      return new ProviderUnavailableError('claude provider unavailable');
    }
  }
  return null;
}

/**
 * Sanitize a hard (non-availability) SDK error before it leaves the engine. `APIError.message`
 * embeds the provider response body, which can echo the request (incident/alert data) or connection
 * detail; the worker dead-letters this error and the queue persists its message as `jobs.last_error`,
 * which must stay secret-free (CWE-209). Keep only the non-sensitive HTTP status for ops triage.
 */
export function sanitizeHardError(err: unknown): Error {
  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  return new Error(
    status ? `claude request failed with status ${status}` : 'claude request failed',
  );
}

/** The slice of the Anthropic SDK used here — fully stubbable in tests. */
export interface AnthropicLike {
  messages: { create(req: unknown, options?: { signal?: AbortSignal }): Promise<unknown> };
}

export interface ClaudeEngineConfig {
  apiKey?: string;
  oauthToken?: string;
  model: string;
  baseUrl?: string;
  /** Exploration-turn budget before at most one evidence-only finalizer. Default 8. */
  maxTurns?: number;
}

/**
 * Pick the auth path: prefer the API key (lower friction), else the OAuth token. OAuth tokens
 * authenticate via `Authorization: Bearer` (SDK `authToken`), NOT `x-api-key` — passing one as
 * `apiKey` yields a 401. Throws when neither credential is present.
 */
export function claudeAuthMode(config: ClaudeEngineConfig): ClaudeAuthMode {
  if (config.apiKey) return 'apikey';
  if (config.oauthToken) return 'oauth';
  throw new Error('LLM_PROVIDER=claude requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN');
}

export function buildAnthropic(
  config: ClaudeEngineConfig,
  authMode: ClaudeAuthMode,
): AnthropicLike {
  return (authMode === 'apikey'
    ? new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch: providerFetch })
    : new Anthropic({
        authToken: config.oauthToken,
        baseURL: config.baseUrl,
        fetch: providerFetch,
      })) as unknown as AnthropicLike;
}

/**
 * The system parameter for a request. On the OAuth path the Claude Code identifier is prepended as
 * the exact first block (quota gate); the API-key path uses a plain string.
 */
export function systemParam(authMode: ClaudeAuthMode, system: string): unknown {
  return authMode === 'oauth'
    ? [
        { type: 'text', text: CLAUDE_CODE_IDENTIFIER },
        { type: 'text', text: system },
      ]
    : system;
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface ClaudeResponse {
  content?: ClaudeContentBlock[];
  stop_reason?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function observeClaudeUsage(
  raw: unknown,
  fallbackModel: string,
  onUsage?: LlmUsageObserver,
): void {
  const response = raw as ClaudeResponse;
  if (!response.usage || !onUsage) return;
  onUsage({
    model: response.model ?? fallbackModel,
    input: response.usage.input_tokens ?? Number.NaN,
    output: response.usage.output_tokens ?? Number.NaN,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
  });
}

/**
 * The Claude binding of the provider seam. Maps the loop's opaque messages onto the
 * Anthropic Messages request/response shape. No `temperature`/`top_p`/`thinking` — all 400 on
 * claude-opus-4-8.
 */
export function makeClaudeProvider(
  sdk: AnthropicLike,
  authMode: ClaudeAuthMode,
  model: string,
  onUsage?: LlmUsageObserver,
): LoopProvider {
  return {
    toolSpecs(tools: ToolDefinition<any, any>[]) {
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: toJsonSchema(tool),
      }));
    },
    userMsg(text: string) {
      return { role: 'user', content: text };
    },
    async call(system, messages, specs, forceTool, signal): Promise<ModelTurn> {
      let response: ClaudeResponse;
      try {
        response = (await sdk.messages.create(
          {
            model,
            max_tokens: 2048,
            system: systemParam(authMode, system),
            tools: specs,
            ...(forceTool ? { tool_choice: { type: 'tool', name: forceTool } } : {}),
            messages,
          },
          { signal },
        )) as ClaudeResponse;
      } catch (err) {
        // An availability failure becomes a provider-agnostic ProviderUnavailableError so the worker
        // degrades and redelivers. A hard error (401/400/bug) fails fast, but its raw message is
        // sanitized first: it would otherwise be persisted as jobs.last_error (CWE-209).
        const unavailable = classifyProviderError(err);
        if (unavailable) throw unavailable;
        throw sanitizeHardError(err);
      }
      observeClaudeUsage(response, model, onUsage);
      const content = response.content ?? [];
      const text = content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text ?? '')
        .join('');
      const toolCalls: ToolCall[] = content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: block.id ?? '', name: block.name ?? '', input: block.input }));
      return {
        text,
        toolCalls,
        stopReason: response.stop_reason ?? '',
        assistantMsg: { role: 'assistant', content: response.content },
      };
    },
    toolResultMsgs(results: ToolRunResult[]) {
      return [
        {
          role: 'user',
          content: results.map((result) => ({
            type: 'tool_result',
            tool_use_id: result.id,
            content: result.content,
            is_error: result.isError,
          })),
        },
      ];
    },
  };
}

/**
 * Claude triage engine: a hand-rolled multi-turn tool-use loop over the Anthropic Messages SDK.
 * Binds `@sre/agent-tools` plus the terminal `report_findings`, dispatches tool calls
 * under the runtime's tenant-scoped context, and streams every step to the hub. Pass `sdkOverride`
 * in tests to script the model turns without the network. `resume` reconstructs context from the
 * hub transcript (textually, not by replaying tool_use blocks) and runs the same loop.
 */
export function makeClaudeEngine(
  config: ClaudeEngineConfig,
  sdkOverride?: AnthropicLike,
  onUsage?: LlmUsageObserver,
): TriageEngine {
  const authMode = claudeAuthMode(config);
  const sdk = sdkOverride ?? buildAnthropic(config, authMode);
  const provider = makeClaudeProvider(sdk, authMode, config.model, onUsage);
  const maxTurns = config.maxTurns ?? 8;

  return {
    provider: 'claude',
    investigate(input: TriageInput, runtime: TriageRuntime): Promise<TriageResult> {
      const focused = input.mode === 'focused';
      return runLoop({
        provider,
        system: focused ? REASSESS_SYSTEM_PROMPT : TRIAGE_SYSTEM_PROMPT,
        initialUser: buildInvestigationPrompt(input),
        tools: runtime.tools,
        ctx: runtime.ctx,
        onStep: (kind, content) => runtime.onStep(kind, content),
        maxTurns: focused ? reassessmentTurnBudget(maxTurns) : maxTurns,
        engineProvider: 'claude',
        sessionId: `claude:${input.incident.id}`,
        model: config.model,
        path: 'investigate',
        priorEvidence: input.evidence,
        onExecutionMetadata: runtime.onExecutionMetadata,
        onEvidenceReceipt: runtime.onEvidenceReceipt,
        readEvidence: runtime.readEvidence,
        signal: runtime.signal,
        // The initial turn must classify its outcome through the structured findings terminal.
        terminals: [REPORT_FINDINGS_NAME],
      });
    },
    resume(input: ResumeInput, runtime: TriageRuntime): Promise<TriageResult> {
      const terminals: TerminalName[] = [
        REPORT_FINDINGS_NAME,
        RESPOND_NAME,
        STAY_SILENT_NAME,
        SUGGEST_ACTION_NAME,
      ];
      if (input.recoveryContext) terminals.push(REPORT_RECOVERY_NAME);
      return runLoop({
        provider,
        system: TRIAGE_SYSTEM_PROMPT,
        initialUser: buildResumePrompt(input),
        tools: runtime.tools,
        ctx: runtime.ctx,
        onStep: (kind, content) => runtime.onStep(kind, content),
        maxTurns,
        engineProvider: 'claude',
        sessionId: `claude:${input.incident.id}`,
        model: config.model,
        path: 'resume',
        priorEvidence: input.evidence,
        onExecutionMetadata: runtime.onExecutionMetadata,
        onEvidenceReceipt: runtime.onEvidenceReceipt,
        readEvidence: runtime.readEvidence,
        signal: runtime.signal,
        // A resume may recommend a human-executed action after the initial RCA exists.
        terminals,
      });
    },
    verifyRecovery(input: RecoveryInput, runtime: TriageRuntime): Promise<TriageResult> {
      return runLoop({
        provider,
        system: RECOVERY_SYSTEM_PROMPT,
        initialUser: buildRecoveryPrompt(input),
        tools: runtime.tools,
        ctx: runtime.ctx,
        onStep: (kind, content) => runtime.onStep(kind, content),
        maxTurns,
        engineProvider: 'claude',
        sessionId: `claude:${input.incident.id}`,
        model: config.model,
        path: 'recovery',
        priorEvidence: input.evidence,
        onExecutionMetadata: runtime.onExecutionMetadata,
        onEvidenceReceipt: runtime.onEvidenceReceipt,
        readEvidence: runtime.readEvidence,
        signal: runtime.signal,
        terminals: [REPORT_RECOVERY_NAME],
      });
    },
  };
}
