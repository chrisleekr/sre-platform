import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { LlmRuntimeConfig } from '@sre/contracts';
import type { LlmTelemetryEventInput } from '@sre/db';
import type { LlmUsageObserver } from '../types';

export interface AgentSdkObservability {
  persist(event: LlmTelemetryEventInput): Promise<void>;
  setComplete(complete: boolean): void;
}

export interface AgentSdkConfig {
  runtime: LlmRuntimeConfig;
  credential: string | null;
  onUsage?: LlmUsageObserver;
  observability?: AgentSdkObservability;
  env?: NodeJS.ProcessEnv;
  query?: typeof sdkQuery;
}
