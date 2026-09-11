import {
  resolveSettings,
  query as sdkQuery,
  type Options,
  type ResolvedSettings,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { redactInput } from '@sre/agent-tools';
import { startClaudeTelemetry } from '../../llm-telemetry';
import { ProviderRateLimitError, ProviderUnavailableError, type LlmUsageObserver } from '../types';
import { STRUCTURED_UNTRUSTED_DATA_INSTRUCTION } from '../types';
import type { AgentSdkConfig } from './contracts';

export const STRUCTURED_SYSTEM = `Return only the requested structured result. ${STRUCTURED_UNTRUSTED_DATA_INSTRUCTION}`;

/** An SDK abort controller that follows the job deadline. Already aborted if the signal is.
 *
 * @param signal - Job processing signal to follow.
 */
export function linkedAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return controller;
}

const BASE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
] as const;

const AWS_AUTH_ENV = [
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
] as const;

const MANAGED_OTLP_DESTINATIONS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_LOGS_CLIENT_CERTIFICATE',
  'OTEL_LOG_RAW_API_BODIES',
] as const;

const MANAGED_PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

export interface RunOutput {
  result: SDKResultMessage;
  messages: SDKMessage[];
}

function childEnvironment(config: AgentSdkConfig): Record<string, string | undefined> {
  const source = config.env ?? process.env;
  const names =
    config.runtime.provider === 'bedrock'
      ? [...BASE_ENV_ALLOWLIST, ...AWS_AUTH_ENV]
      : [...BASE_ENV_ALLOWLIST];
  const env: Record<string, string | undefined> = {};
  for (const name of names) if (source[name] !== undefined) env[name] = source[name];
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'sre-platform/0.0.0';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (config.runtime.provider === 'bedrock') env.CLAUDE_CODE_USE_BEDROCK = '1';
  else if (config.runtime.authMode === 'oauth') {
    if (!config.credential) throw new Error('Claude OAuth credential is not configured');
    env.CLAUDE_CODE_OAUTH_TOKEN = config.credential;
  } else {
    if (!config.credential) throw new Error('Anthropic API credential is not configured');
    env.ANTHROPIC_API_KEY = config.credential;
  }
  if (config.runtime.provider === 'custom-anthropic' && config.runtime.baseUrl)
    env.ANTHROPIC_BASE_URL = config.runtime.baseUrl;
  return env;
}

function withLoopbackNoProxy(env: Record<string, string | undefined>): void {
  const entries = [env.NO_PROXY, env.no_proxy].flatMap((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const value = entries.includes('*')
    ? '*'
    : [...new Set([...entries, '127.0.0.1', 'localhost', '::1'])].join(',');
  env.NO_PROXY = value;
  env.no_proxy = value;
}

function managedTelemetryConflict(resolved: ResolvedSettings): string | null {
  for (const source of resolved.sources) {
    if (source.source !== 'managed') continue;
    if (source.settings.policyHelper !== undefined)
      return 'managed policyHelper can change the telemetry destination after inspection';
    if (source.settings.otelHeadersHelper !== undefined)
      return 'managed otelHeadersHelper can replace the receiver authorization';
    const env = source.settings.env ?? {};
    const destination = MANAGED_OTLP_DESTINATIONS.find((key) => env[key] !== undefined);
    if (destination) return `managed settings control ${destination}`;
    const proxy = MANAGED_PROXY_KEYS.find((key) => env[key] !== undefined);
    if (proxy) return `managed settings control ${proxy}`;
    if (
      env.OTEL_EXPORTER_OTLP_PROTOCOL !== undefined &&
      env.OTEL_EXPORTER_OTLP_PROTOCOL !== 'http/json'
    )
      return 'managed settings control OTEL_EXPORTER_OTLP_PROTOCOL';
    if (
      env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL !== undefined &&
      env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL !== 'http/json'
    )
      return 'managed settings control OTEL_EXPORTER_OTLP_LOGS_PROTOCOL';
    if (env.OTEL_LOGS_EXPORTER !== undefined && env.OTEL_LOGS_EXPORTER !== 'otlp')
      return 'managed settings control OTEL_LOGS_EXPORTER';
    if (env.CLAUDE_CODE_ENABLE_TELEMETRY !== undefined && env.CLAUDE_CODE_ENABLE_TELEMETRY !== '1')
      return 'managed settings disable Claude telemetry';
  }
  return null;
}

export function baseOptions(config: AgentSdkConfig, systemPrompt: string): Options {
  return {
    model: config.runtime.model,
    systemPrompt,
    maxTurns: config.runtime.maxTurns,
    tools: [],
    allowedTools: [],
    permissionMode: 'dontAsk',
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    env: childEnvironment(config),
  };
}

function sanitizedAgentError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/\b(?:429|rate[ _-]?limit(?:ed)?|too many requests)\b/iu.test(text))
    return new ProviderRateLimitError();
  return /\b(?:429|5\d\d|overloaded|timeout|network|ECONN)\b/iu.test(text)
    ? new ProviderUnavailableError('Claude Agent SDK provider unavailable')
    : new Error('Claude Agent SDK query failed');
}

function sanitizedAgentResultError(
  result: SDKResultMessage,
  rateLimit?: ProviderRateLimitError,
): Error {
  if (result.subtype === 'success' && result.api_error_status != null) {
    if (result.api_error_status === 429) return rateLimit ?? new ProviderRateLimitError();
    return result.api_error_status >= 500
      ? new ProviderUnavailableError('Claude Agent SDK provider unavailable')
      : new Error('Claude Agent SDK execution failed');
  }
  if (rateLimit) return rateLimit;
  const text = result.subtype === 'success' ? result.result : result.errors.join(' ');
  if (/\b(?:429|rate[ _-]?limit(?:ed)?|too many requests)\b/iu.test(text))
    return new ProviderRateLimitError();
  return /\b(?:429|5\d\d|overloaded|timeout|network|ECONN)\b/iu.test(text)
    ? new ProviderUnavailableError('Claude Agent SDK provider unavailable')
    : new Error('Claude Agent SDK execution failed');
}

function observeAgentUsage(
  result: SDKResultMessage,
  fallbackModel: string,
  onUsage?: LlmUsageObserver,
): void {
  if (!onUsage) return;
  const totals = Object.values(result.modelUsage).reduce(
    (sum, usage) => ({
      input: sum.input + usage.inputTokens,
      output: sum.output + usage.outputTokens,
      cacheRead: sum.cacheRead + usage.cacheReadInputTokens,
      cacheWrite: sum.cacheWrite + usage.cacheCreationInputTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  onUsage({
    model: Object.keys(result.modelUsage)[0] ?? fallbackModel,
    requestCount: result.num_turns,
    ...totals,
    providerEstimatedCostUsd: result.total_cost_usd,
  });
}

export async function runQuery(
  config: AgentSdkConfig,
  prompt: string | AsyncIterable<SDKUserMessage>,
  options: Options,
  onAssistantText?: (text: string) => Promise<void>,
): Promise<RunOutput> {
  let telemetry: Awaited<ReturnType<typeof startClaudeTelemetry>> | undefined;
  if (config.observability) {
    try {
      const resolved = await resolveSettings({ settingSources: [] });
      const conflict = managedTelemetryConflict(resolved);
      if (conflict) throw new Error(`Raw Claude telemetry disabled: ${conflict}`);
      telemetry = await startClaudeTelemetry(config.observability.persist);
      Object.assign(options.env!, telemetry.env);
      withLoopbackNoProxy(options.env!);
    } catch (error) {
      config.observability.setComplete(false);
      await config.observability.persist({
        kind: 'trace_gap',
        payload: redactInput({
          reason: error instanceof Error ? error.message : 'Claude telemetry could not start',
        }),
      });
    }
  }
  const messages: SDKMessage[] = [];
  const published = new Set<string>();
  let result: SDKResultMessage | undefined;
  let iterationError: unknown;
  let rateLimit: ProviderRateLimitError | undefined;
  options.abortController ??= new AbortController();
  try {
    const query = (config.query ?? sdkQuery)({ prompt, options });
    for await (const message of query) {
      messages.push(message);
      if (
        (message.type === 'assistant' && message.error === 'rate_limit') ||
        (message.type === 'system' &&
          message.subtype === 'api_retry' &&
          (message.error_status === 429 || message.error === 'rate_limit'))
      ) {
        const error = new ProviderRateLimitError();
        options.abortController.abort(error);
        throw error;
      }
      if (message.type === 'assistant')
        rateLimit =
          message.error === 'rate_limit' ? (rateLimit ?? new ProviderRateLimitError()) : undefined;
      if (message.type === 'rate_limit_event' && message.rate_limit_info.status !== 'rejected')
        rateLimit = undefined;
      if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') {
        rateLimit ??= new ProviderRateLimitError();
      }
      if (message.type === 'assistant' && !message.error && onAssistantText) {
        for (const block of message.message.content) {
          if (block.type !== 'text' || !block.text.trim()) continue;
          const key = `${message.message.id}:${block.text}`;
          if (published.has(key)) continue;
          published.add(key);
          await onAssistantText(block.text);
        }
      }
      if (message.type === 'result') result = message;
    }
  } catch (error) {
    iterationError = error;
  } finally {
    if (telemetry) {
      const outcome = await telemetry.close().catch(async () => {
        await config.observability?.persist({
          kind: 'trace_gap',
          payload: { reason: 'Claude telemetry cleanup failed' },
        });
        return { complete: false };
      });
      config.observability?.setComplete(outcome.complete);
    }
  }
  if (result) {
    observeAgentUsage(result, config.runtime.model, config.onUsage);
    if (
      result.subtype !== 'error_max_turns' &&
      (result.is_error || result.subtype === 'error_during_execution')
    )
      throw sanitizedAgentResultError(result, rateLimit);
    return { result, messages };
  }
  if (iterationError !== undefined) {
    if (options.abortController?.signal.aborted) throw options.abortController.signal.reason;
    throw rateLimit ?? sanitizedAgentError(iterationError);
  }
  throw new Error('Claude Agent SDK returned no result');
}
