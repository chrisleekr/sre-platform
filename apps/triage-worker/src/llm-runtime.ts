import type { LlmOperation, LlmRuntimeConfig, LlmTokenCounts } from '@sre/contracts';
import { assertSafeHttpsUrl } from '@sre/connectors';
import {
  completeLlmInvocation,
  priceLlmTokens,
  recordLlmTelemetryEvent,
  startLlmInvocation,
  type Db,
  type PlatformSecretStore,
} from '@sre/db';
import {
  llmCredentialSecretName,
  llmRuntimeFingerprint,
  type PlatformSettings,
} from '@sre/platform-settings';
import { selectClassifier, type Classifier } from './engine/classify';
import { selectEngine, selectGenerator, selectVision } from './engine/select';
import { reviewedEngine } from './engine/evidence-review';
import {
  ProviderUnavailableError,
  type LlmUsageObserver,
  type LlmUsageSample,
  type StructuredGenerator,
  type TriageEngine,
  type VisionModel,
} from './engine/types';
import type { LlmConfig } from './config';
import {
  makeAgentSdkClassifier,
  makeAgentSdkEngine,
  makeAgentSdkGenerator,
  makeAgentSdkVision,
  type AgentSdkObservability,
} from './engine/agent-sdk';

export interface LlmClients {
  engine: TriageEngine;
  classifier: Classifier;
  generator: StructuredGenerator;
  vision: VisionModel;
}

export interface LlmInvocationMeta {
  tenantId: string;
  incidentId?: string;
  jobId?: string;
  operation: LlmOperation;
  /** Rejects model work if the active behavioral configuration changed after a safety gate. */
  expectedConfigurationFingerprint?: string;
  signal?: AbortSignal;
}

export interface LlmRuntimeManager {
  execute<T>(meta: LlmInvocationMeta, run: (clients: LlmClients) => Promise<T>): Promise<T>;
  configurationFingerprint?(): Promise<string>;
}

interface UsageTotals {
  requestCount: number;
  tokens: LlmTokenCounts;
  providerEstimatedCostUsd: number | null;
  reported: boolean;
  valid: boolean;
  telemetryComplete: boolean | null;
}

class UsageCollector {
  private totals: UsageTotals = {
    requestCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    providerEstimatedCostUsd: null,
    reported: false,
    valid: true,
    telemetryComplete: null,
  };

  readonly observe: LlmUsageObserver = (sample) => this.add(sample);

  add(sample: LlmUsageSample): void {
    this.totals.reported = true;
    const requestCount = sample.requestCount ?? 1;
    const counts = [requestCount, sample.input, sample.output, sample.cacheRead, sample.cacheWrite];
    const nextCounts = [
      this.totals.requestCount + requestCount,
      this.totals.tokens.input + sample.input,
      this.totals.tokens.output + sample.output,
      this.totals.tokens.cacheRead + sample.cacheRead,
      this.totals.tokens.cacheWrite + sample.cacheWrite,
    ];
    const providerCost = sample.providerEstimatedCostUsd;
    const nextProviderCost =
      providerCost === undefined
        ? this.totals.providerEstimatedCostUsd
        : (this.totals.providerEstimatedCostUsd ?? 0) + providerCost;
    if (
      counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      requestCount === 0 ||
      counts.slice(1).every((value) => value === 0) ||
      nextCounts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      (providerCost !== undefined && (!Number.isFinite(providerCost) || providerCost < 0)) ||
      (nextProviderCost !== null && (!Number.isFinite(nextProviderCost) || nextProviderCost < 0))
    ) {
      this.totals.valid = false;
      return;
    }
    this.totals.requestCount = nextCounts[0]!;
    this.totals.tokens.input += sample.input;
    this.totals.tokens.output += sample.output;
    this.totals.tokens.cacheRead += sample.cacheRead;
    this.totals.tokens.cacheWrite += sample.cacheWrite;
    if (providerCost !== undefined) this.totals.providerEstimatedCostUsd = nextProviderCost;
  }

  setTelemetryComplete(complete: boolean): void {
    this.totals.telemetryComplete = complete;
  }

  snapshot(): UsageTotals {
    return {
      ...this.totals,
      tokens: { ...this.totals.tokens },
      providerEstimatedCostUsd: this.totals.valid ? this.totals.providerEstimatedCostUsd : null,
    };
  }
}

function environmentCredential(config: LlmRuntimeConfig, env: NodeJS.ProcessEnv): string | null {
  if (config.authMode === 'ambient') return null;
  if (config.provider === 'custom-anthropic') return null;
  if (config.runtime === 'openai-chat') return env.OPENAI_API_KEY?.trim() || null;
  return config.authMode === 'oauth'
    ? env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || null
    : env.ANTHROPIC_API_KEY?.trim() || null;
}

function engineConfig(config: LlmRuntimeConfig, credential: string | null): LlmConfig {
  return {
    provider: config.runtime === 'openai-chat' ? 'openai' : 'claude',
    anthropic: {
      ...(config.authMode === 'oauth'
        ? { oauthToken: credential ?? undefined }
        : { apiKey: credential ?? undefined }),
      model: config.model,
      maxTurns: config.maxTurns,
      baseUrl: config.baseUrl ?? undefined,
    },
    openai: {
      apiKey: credential ?? undefined,
      model: config.model,
      maxTurns: config.maxTurns,
    },
  };
}

function clientsFor(
  config: LlmRuntimeConfig,
  credential: string | null,
  usage: UsageCollector,
  observability: AgentSdkObservability,
  env: NodeJS.ProcessEnv,
): LlmClients {
  if (config.runtime === 'claude-agent-sdk') {
    const selected = {
      runtime: config,
      credential,
      onUsage: usage.observe,
      observability,
      env,
    };
    return {
      engine: reviewedEngine(makeAgentSdkEngine(selected), makeAgentSdkGenerator(selected)),
      classifier: makeAgentSdkClassifier(selected),
      generator: makeAgentSdkGenerator(selected),
      vision: makeAgentSdkVision(selected),
    };
  }
  const selected = engineConfig(config, credential);
  return {
    engine: reviewedEngine(
      selectEngine(selected, usage.observe),
      selectGenerator(selected, usage.observe),
    ),
    classifier: selectClassifier(selected, usage.observe),
    generator: selectGenerator(selected, usage.observe),
    vision: selectVision(selected, usage.observe),
  };
}

function errorCategory(error: unknown): string {
  if (error instanceof ProviderUnavailableError) return 'provider_unavailable';
  if (error instanceof Error && error.name) return error.name.slice(0, 100);
  return 'unknown_error';
}

export function makeLlmRuntimeManager(deps: {
  db: Db;
  settings: Pick<PlatformSettings, 'llmRuntime'>;
  secrets: PlatformSecretStore;
  validateCustomProviderUrl?: (url: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}): LlmRuntimeManager {
  const env = deps.env ?? process.env;
  const validateCustomProviderUrl =
    deps.validateCustomProviderUrl ??
    (async (url: string) => {
      await assertSafeHttpsUrl(url, undefined, { allowPrivate: true });
    });
  return {
    async configurationFingerprint(): Promise<string> {
      return llmRuntimeFingerprint((await deps.settings.llmRuntime()).config);
    },
    async execute<T>(
      meta: LlmInvocationMeta,
      run: (clients: LlmClients) => Promise<T>,
    ): Promise<T> {
      if (meta.signal?.aborted) throw meta.signal.reason;
      const current = await deps.settings.llmRuntime();
      if (
        meta.expectedConfigurationFingerprint &&
        llmRuntimeFingerprint(current.config) !== meta.expectedConfigurationFingerprint
      ) {
        throw new Error('LLM runtime configuration changed before the gated operation');
      }
      const storedCredential = await deps.secrets.get(llmCredentialSecretName(current.config));
      const credential = storedCredential ?? environmentCredential(current.config, env);
      const invocationId = await startLlmInvocation(deps.db, {
        ...meta,
        config: current.config,
        configUpdatedAt: current.updatedAt,
      });
      const usage = new UsageCollector();
      const observability = {
        persist: (event: Parameters<typeof recordLlmTelemetryEvent>[3]) =>
          recordLlmTelemetryEvent(deps.db, meta.tenantId, invocationId, event),
        setComplete: (complete: boolean) => usage.setTelemetryComplete(complete),
      };

      try {
        if (current.config.provider === 'custom-anthropic') {
          await validateCustomProviderUrl(current.config.baseUrl!);
        }
        const clients = clientsFor(current.config, credential, usage, observability, env);
        const signal = meta.signal;
        const runClients: LlmClients = signal
          ? {
              engine: clients.engine,
              generator: {
                generate: (prompt, schema, options) =>
                  clients.generator.generate(prompt, schema, {
                    ...options,
                    signal: options?.signal ?? signal,
                  }),
              },
              classifier: {
                classify: (candidate, candidates, resolutionCandidates, options) =>
                  clients.classifier.classify(candidate, candidates, resolutionCandidates, {
                    ...options,
                    signal: options?.signal ?? signal,
                  }),
              },
              vision: {
                provider: clients.vision.provider,
                supportsVision: clients.vision.supportsVision,
                describeImage: (bytes, mime, prompt, options) =>
                  clients.vision.describeImage(bytes, mime, prompt, {
                    ...options,
                    signal: options?.signal ?? signal,
                  }),
              },
            }
          : clients;
        const result = await run(runClients);
        if (meta.expectedConfigurationFingerprint) {
          const after = await deps.settings.llmRuntime();
          if (llmRuntimeFingerprint(after.config) !== meta.expectedConfigurationFingerprint) {
            throw new Error('LLM runtime configuration changed during the gated operation');
          }
        }
        const totals = usage.snapshot();
        await completeLlmInvocation(deps.db, meta.tenantId, invocationId, {
          status: 'succeeded',
          requestCount: totals.requestCount,
          tokens: totals.tokens,
          usageReported: totals.reported,
          configuredCostUsd:
            totals.reported && totals.valid
              ? priceLlmTokens(totals.tokens, current.config.pricing)
              : null,
          providerEstimatedCostUsd: totals.providerEstimatedCostUsd,
          telemetryComplete: totals.telemetryComplete,
        });
        return result;
      } catch (error) {
        const totals = usage.snapshot();
        await completeLlmInvocation(deps.db, meta.tenantId, invocationId, {
          status: 'failed',
          errorCategory: errorCategory(error),
          requestCount: totals.requestCount,
          tokens: totals.tokens,
          usageReported: totals.reported,
          configuredCostUsd:
            totals.reported && totals.valid
              ? priceLlmTokens(totals.tokens, current.config.pricing)
              : null,
          providerEstimatedCostUsd: totals.providerEstimatedCostUsd,
          telemetryComplete: totals.telemetryComplete,
        });
        throw error;
      }
    },
  };
}
