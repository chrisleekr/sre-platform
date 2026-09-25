import OpenAI from 'openai';
import { toJsonSchema, type ToolDefinition } from '@sre/agent-tools';
import type { LoopProvider, ModelTurn, TerminalName, ToolCall, ToolRunResult } from './loop';
import { runLoop } from './loop';
import { REPORT_FINDINGS_NAME } from './report-findings';
import { REPORT_RECOVERY_NAME } from './report-recovery';
import { SUGGEST_ACTION_NAME } from './suggest-action';
import { RESPOND_NAME } from './respond';
import { STAY_SILENT_NAME } from './stay-silent';
import {
  RECOVERY_SYSTEM_PROMPT,
  REASSESS_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
  buildInvestigationPrompt,
  buildRecoveryPrompt,
  buildResumePrompt,
  reassessmentTurnBudget,
} from './shared';
import {
  isProviderConfigurationStatus,
  ProviderConfigurationError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from './types';
import { providerFetch } from './provider-fetch';
import type {
  LlmUsageObserver,
  RecoveryInput,
  ResumeInput,
  TriageEngine,
  TriageInput,
  TriageRuntime,
} from './types';

/** The slice of the OpenAI SDK used here, fully stubbable in tests. */
export interface OpenAILike {
  chat: {
    completions: {
      create(req: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
    };
  };
}

export interface OpenAIEngineConfig {
  apiKey?: string;
  model?: string;
  /** Exploration-turn budget before at most one evidence-only finalizer. Default 8. */
  maxTurns?: number;
}

interface OpenAIToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIResponse {
  choices?: Array<{ finish_reason?: string | null; message?: OpenAIMessage }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export function observeOpenAIUsage(
  raw: unknown,
  fallbackModel: string,
  onUsage?: LlmUsageObserver,
): void {
  const response = raw as OpenAIResponse;
  if (!response.usage || !onUsage) return;
  const prompt = response.usage.prompt_tokens;
  const output = response.usage.completion_tokens;
  const cached = response.usage.prompt_tokens_details?.cached_tokens ?? 0;
  onUsage({
    model: response.model ?? fallbackModel,
    input: prompt === undefined ? Number.NaN : prompt - cached,
    output: output ?? Number.NaN,
    cacheRead: cached,
    cacheWrite: 0,
  });
}

const INVESTIGATE_TERMINALS = [REPORT_FINDINGS_NAME] as const;
const RESUME_TERMINALS = [
  REPORT_FINDINGS_NAME,
  RESPOND_NAME,
  STAY_SILENT_NAME,
  SUGGEST_ACTION_NAME,
] as const;
const RECOVERY_TERMINALS = [REPORT_RECOVERY_NAME] as const;
/** Whether a model accepts a temperature override. */
export function supportsTemperature(model: string): boolean {
  return !/^(o\d|gpt-5)/i.test(model);
}

function openaiParameters(tool: ToolDefinition<any, any>): Record<string, unknown> {
  const schema = { ...(toJsonSchema(tool) as Record<string, unknown>) };
  delete schema.$schema;
  return schema;
}

function openAIToolSpecs(tools: ToolDefinition<any, any>[]): OpenAIToolSpec[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: openaiParameters(tool),
    },
  }));
}

function completionRequest(
  model: string,
  system: string,
  messages: unknown[],
  tools: unknown,
  forceTool?: string,
): Record<string, unknown> {
  return {
    model,
    ...(supportsTemperature(model) ? { temperature: 0 } : {}),
    messages: [{ role: 'system', content: system }, ...messages],
    tools,
    ...(forceTool ? { tool_choice: { type: 'function', function: { name: forceTool } } } : {}),
  };
}

/** Read the assistant text from the first choice. */
export function openaiText(raw: unknown): string {
  const choices = (raw as OpenAIResponse).choices ?? [];
  return choices[0]?.message?.content ?? '';
}

/** Map availability failures to the provider-independent retry signal. */
function classifyOpenAIProviderError(
  err: unknown,
): ProviderUnavailableError | ProviderRateLimitError | null {
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    if (status === 429) return new ProviderRateLimitError();
    if (status === undefined || status === 408 || status === 409 || status >= 500) {
      return new ProviderUnavailableError('openai provider unavailable');
    }
  }
  return null;
}

/**
 * Keep provider response bodies and request data out of persisted job errors (CWE-209). A rejected
 * configuration becomes `ProviderConfigurationError`, matching the Claude bindings, so the worker
 * stops redelivering a request that cannot succeed.
 *
 * @param err - Error thrown by the OpenAI SDK or the request path.
 * @param label - Prefix naming the caller in the generic message.
 */
export function sanitizeOpenAIHardError(err: unknown, label = 'openai'): Error {
  const status = err instanceof OpenAI.APIError ? err.status : undefined;
  if (status !== undefined && isProviderConfigurationStatus(status))
    return new ProviderConfigurationError(status);
  return new Error(
    status ? `${label} request failed with status ${status}` : `${label} request failed`,
  );
}

function parseArguments(
  argumentsJson: string | undefined,
): Pick<ToolCall, 'input' | 'invalidInput'> {
  if (argumentsJson === undefined) return { input: undefined, invalidInput: true };
  try {
    return { input: JSON.parse(argumentsJson) };
  } catch {
    return { input: undefined, invalidInput: true };
  }
}

/** Chat Completions binding for the provider-independent tool loop. */
export function makeOpenAIProvider(
  sdk: OpenAILike,
  model: string,
  onUsage?: LlmUsageObserver,
): LoopProvider {
  return {
    toolSpecs: openAIToolSpecs,
    userMsg(text: string) {
      return { role: 'user', content: text };
    },
    async call(system, messages, specs, forceTool, signal): Promise<ModelTurn> {
      let response: OpenAIResponse;
      try {
        response = (await sdk.chat.completions.create(
          completionRequest(model, system, messages, specs, forceTool),
          { signal },
        )) as OpenAIResponse;
      } catch (err) {
        const unavailable = classifyOpenAIProviderError(err);
        if (unavailable) throw unavailable;
        throw sanitizeOpenAIHardError(err);
      }
      observeOpenAIUsage(response, model, onUsage);

      const choice = response.choices?.[0];
      const message = choice?.message ?? {};
      const rawCalls = message.tool_calls ?? [];
      const toolCalls: ToolCall[] = rawCalls.map((call) => ({
        id: call.id ?? '',
        name: call.function?.name ?? '',
        ...parseArguments(call.function?.arguments),
      }));
      return {
        text: message.content ?? '',
        toolCalls,
        stopReason: choice?.finish_reason ?? '',
        assistantMsg: {
          role: 'assistant',
          content: message.content ?? null,
          ...(rawCalls.length > 0 ? { tool_calls: rawCalls } : {}),
        },
      };
    },
    toolResultMsgs(results: ToolRunResult[]) {
      return results.map((result) => ({
        role: 'tool',
        tool_call_id: result.id,
        content: result.content,
      }));
    },
  };
}

/** OpenAI Chat Completions adapter over the shared multi-turn loop. */
export function makeOpenAIEngine(
  config: OpenAIEngineConfig,
  sdkOverride?: OpenAILike,
  onUsage?: LlmUsageObserver,
): TriageEngine {
  if (!config.apiKey) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
  if (!config.model) throw new Error('LLM_PROVIDER=openai requires OPENAI_MODEL');
  const model = config.model;
  const sdk =
    sdkOverride ??
    (new OpenAI({ apiKey: config.apiKey, fetch: providerFetch }) as unknown as OpenAILike);
  const provider = makeOpenAIProvider(sdk, model, onUsage);
  const maxTurns = config.maxTurns ?? 8;

  return {
    provider: 'openai',
    investigate(input: TriageInput, runtime: TriageRuntime) {
      const focused = input.mode === 'focused';
      return runLoop({
        provider,
        system: focused ? REASSESS_SYSTEM_PROMPT : TRIAGE_SYSTEM_PROMPT,
        initialUser: buildInvestigationPrompt(input),
        tools: runtime.tools,
        ctx: runtime.ctx,
        onStep: (kind, content) => runtime.onStep(kind, content),
        maxTurns: focused ? reassessmentTurnBudget(maxTurns) : maxTurns,
        path: 'investigate',
        engineProvider: 'openai',
        sessionId: `openai:${input.incident.id}`,
        model,
        priorEvidence: input.evidence,
        onExecutionMetadata: runtime.onExecutionMetadata,
        onEvidenceReceipt: runtime.onEvidenceReceipt,
        readEvidence: runtime.readEvidence,
        terminals: [...INVESTIGATE_TERMINALS],
        signal: runtime.signal,
      });
    },
    resume(input: ResumeInput, runtime: TriageRuntime) {
      const terminals: TerminalName[] = [...RESUME_TERMINALS];
      if (input.recoveryContext) terminals.push(REPORT_RECOVERY_NAME);
      return runLoop({
        provider,
        system: TRIAGE_SYSTEM_PROMPT,
        initialUser: buildResumePrompt(input),
        tools: runtime.tools,
        ctx: runtime.ctx,
        onStep: (kind, content) => runtime.onStep(kind, content),
        maxTurns,
        path: 'resume',
        priorEvidence: input.evidence,
        onExecutionMetadata: runtime.onExecutionMetadata,
        onEvidenceReceipt: runtime.onEvidenceReceipt,
        readEvidence: runtime.readEvidence,
        engineProvider: 'openai',
        sessionId: `openai:${input.incident.id}`,
        model,
        terminals,
        signal: runtime.signal,
      });
    },
    verifyRecovery(input: RecoveryInput, runtime: TriageRuntime) {
      return runLoop({
        provider,
        system: RECOVERY_SYSTEM_PROMPT,
        initialUser: buildRecoveryPrompt(input),
        tools: runtime.tools,
        ctx: runtime.ctx,
        onStep: (kind, content) => runtime.onStep(kind, content),
        maxTurns,
        path: 'recovery',
        priorEvidence: input.evidence,
        onExecutionMetadata: runtime.onExecutionMetadata,
        onEvidenceReceipt: runtime.onEvidenceReceipt,
        readEvidence: runtime.readEvidence,
        engineProvider: 'openai',
        sessionId: `openai:${input.incident.id}`,
        model,
        terminals: [...RECOVERY_TERMINALS],
        signal: runtime.signal,
      });
    },
  };
}
