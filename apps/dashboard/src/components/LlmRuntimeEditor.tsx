import {
  isUsableLlmPricing,
  type LlmPricing,
  type LlmProvider,
  type LlmRuntime,
  type LlmRuntimeConfig,
} from '@sre/contracts';
import { useState } from 'react';

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  'custom-anthropic': 'Anthropic-compatible endpoint',
  bedrock: 'Amazon Bedrock',
  openai: 'OpenAI',
};

function providerConfig(
  runtimeSettings: LlmRuntimeConfig,
  provider: LlmProvider,
): LlmRuntimeConfig {
  if (provider === 'openai') {
    return {
      ...runtimeSettings,
      runtime: 'openai-chat',
      provider,
      authMode: 'api-key',
      baseUrl: null,
    };
  }
  if (provider === 'bedrock') {
    return {
      ...runtimeSettings,
      runtime: 'claude-agent-sdk',
      provider,
      authMode: 'ambient',
      baseUrl: null,
    };
  }
  return {
    ...runtimeSettings,
    runtime: 'claude-agent-sdk',
    provider,
    authMode: 'api-key',
    baseUrl: provider === 'custom-anthropic' ? (runtimeSettings.baseUrl ?? '') : null,
  };
}

function runtimeConfig(runtimeSettings: LlmRuntimeConfig, runtime: LlmRuntime): LlmRuntimeConfig {
  return providerConfig(runtimeSettings, runtime === 'openai-chat' ? 'openai' : 'anthropic');
}

export function validPricing(pricing: LlmPricing | null): boolean {
  return pricing === null || isUsableLlmPricing(pricing);
}

export function credentialIdentity(runtime: LlmRuntimeConfig): string {
  return [
    runtime.provider,
    runtime.authMode,
    runtime.provider === 'custom-anthropic' ? (runtime.baseUrl?.trim() ?? '') : '',
  ].join(':');
}

export const NUMERIC_SETTING_COPY: Record<
  string,
  { label: string; description: string; unit: string }
> = {
  MAX_TOKEN_LIFETIME_SEC: {
    label: 'Maximum API bearer-token lifetime',
    description:
      'Limits legacy API bearer tokens and development password tokens, not browser sessions.',
    unit: 'seconds',
  },
  SESSION_IDLE_SECONDS: {
    label: 'Browser session idle timeout',
    description:
      'Sign in again after this long without activity. The default is 24 hours. Activity never extends the absolute expiry.',
    unit: 'seconds',
  },
  SESSION_ABSOLUTE_SECONDS: {
    label: 'Browser session absolute timeout',
    description:
      'Maximum duration from directory authentication, even while active. The default is seven days. Changes apply to new sessions.',
    unit: 'seconds',
  },
  CLASSIFY_FAIRNESS_WINDOW_SEC: {
    label: 'Classification fairness window',
    description: 'Prevents one tenant from monopolizing the classification queue.',
    unit: 'seconds',
  },
  INCIDENT_AUTO_ARCHIVE_DAYS: {
    label: 'Automatically delete terminal incidents',
    description:
      'Removes resolved or closed incidents from every list and direct link after this many inactive days. This cannot be undone from the dashboard.',
    unit: 'days',
  },
  RECOVERY_MAX_CHECKS: {
    label: 'Maximum automated recovery checks',
    description:
      'Caps model-directed checks after provider signals clear. The investigator may schedule the next check 1–60 minutes later.',
    unit: 'checks',
  },
  EVIDENCE_BUDGET_CHARS: {
    label: 'Evidence carried into a continued investigation',
    description:
      'Size cap on the prior evidence a resumed or recovering investigation carries, spent newest first. This is what decides which evidence the investigator actually sees. Raising it past the default can push the break-even above the row ceiling below, at which point that ceiling starts binding instead.',
    unit: 'characters',
  },
  EVIDENCE_ROW_LIMIT: {
    label: 'Evidence rows loaded per investigation',
    description:
      'Ceiling on how many past tool results one investigation reads back, newest first. The prompt character budget already decides what the investigator actually sees, so this only bounds how much is read from the database. Lowering it can hide older evidence.',
    unit: 'rows',
  },
  AUTO_INVESTIGATION_TENANT_LIMIT_24H: {
    label: 'Tenant automatic run limit',
    description:
      'Maximum automatic investigations per tenant in a rolling 24-hour window. Zero is unlimited.',
    unit: 'runs / 24h',
  },
  AUTO_INVESTIGATION_MONITOR_LIMIT_24H: {
    label: 'Monitor automatic run limit',
    description:
      'Maximum automatic investigations charged to each monitor scope during a rolling 24-hour window. Zero is unlimited.',
    unit: 'runs / 24h',
  },
  AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H: {
    label: 'Tenant configured-cost limit',
    description:
      'Stops automatic investigations when tenant configured cost reaches this rolling 24-hour USD limit. Pending, missing, or unpriced usage pauses automatic work, and a positive limit requires configured pricing. Zero is unlimited.',
    unit: 'USD / 24h',
  },
  AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H: {
    label: 'Monitor configured-cost limit',
    description:
      'Applies the configured-cost guard to every monitor scope charged by a run. Pending, missing, or unpriced usage pauses automatic work, and a positive limit requires configured pricing. Zero is unlimited.',
    unit: 'USD / 24h',
  },
};

export function LlmRuntimeEditor({
  value,
  credentialConfigured,
  source,
  disabled,
  onChange,
  onSave,
}: {
  value: LlmRuntimeConfig;
  credentialConfigured: boolean;
  source: 'stored' | 'environment';
  disabled: boolean;
  onChange: (value: LlmRuntimeConfig) => void;
  onSave: (credential: string) => Promise<void>;
}) {
  const [credential, setCredential] = useState('');
  const [pricingEnabled, setPricingEnabled] = useState(value.pricing !== null);
  const providers: LlmProvider[] =
    value.runtime === 'openai-chat' ? ['openai'] : ['anthropic', 'custom-anthropic', 'bedrock'];

  const updatePricing = (key: keyof LlmPricing, raw: string) => {
    const current = value.pricing ?? {
      inputPerMTok: 0,
      outputPerMTok: 0,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
    };
    onChange({ ...value, pricing: { ...current, [key]: Number(raw) } });
  };

  return (
    <section
      aria-labelledby="llm-runtime-title"
      className="rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="llm-runtime-title" className="font-semibold text-ink">
            Investigator model
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-ink-muted">
            Changes apply to the next model invocation without restarting workers. Running
            invocations keep their configuration and price snapshot.
          </p>
        </div>
        <span className="rounded-full bg-surface-strong px-2.5 py-1 text-xs font-medium text-ink-secondary">
          {source === 'stored' ? 'Saved configuration' : 'Using environment fallback'}
        </span>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Runtime
          <select
            value={value.runtime}
            disabled={disabled}
            onChange={(event) => onChange(runtimeConfig(value, event.target.value as LlmRuntime))}
            className="min-h-11 rounded border border-line-strong bg-surface px-3 py-2 font-normal"
          >
            <option value="claude-agent-sdk">Claude Agent SDK</option>
            <option value="openai-chat">OpenAI Chat Completions</option>
          </select>
          <span className="text-xs font-normal text-ink-muted">
            Claude Agent SDK enables audited MCP tools and native provider telemetry.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Provider
          <select
            value={value.provider}
            disabled={disabled}
            onChange={(event) => onChange(providerConfig(value, event.target.value as LlmProvider))}
            className="min-h-11 rounded border border-line-strong bg-surface px-3 py-2 font-normal"
          >
            {providers.map((provider) => (
              <option key={provider} value={provider}>
                {PROVIDER_LABEL[provider]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Model ID
          <input
            value={value.model}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
            placeholder={value.runtime === 'openai-chat' ? 'gpt-5.4' : 'claude-opus-4-8'}
            className="min-h-11 rounded border border-line-strong px-3 py-2 font-normal"
          />
          <span className="text-xs font-normal text-ink-muted">
            Exact provider model identifier. No hidden default after saving.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Maximum turns
          <input
            type="number"
            min={1}
            max={64}
            value={value.maxTurns}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, maxTurns: Number(event.target.value) })}
            className="min-h-11 rounded border border-line-strong px-3 py-2 font-normal"
          />
          <span className="text-xs font-normal text-ink-muted">
            Hard cap for one agent investigation or response.
          </span>
        </label>
        {value.provider === 'custom-anthropic' && (
          <label className="flex flex-col gap-1 text-sm font-medium md:col-span-2">
            Anthropic-compatible base URL
            <input
              type="url"
              value={value.baseUrl ?? ''}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
              placeholder="https://gateway.example.com"
              className="min-h-11 rounded border border-line-strong px-3 py-2 font-normal"
            />
          </label>
        )}
        {value.provider === 'anthropic' && (
          <label className="flex flex-col gap-1 text-sm font-medium">
            Authentication
            <select
              value={value.authMode}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, authMode: event.target.value as 'api-key' | 'oauth' })
              }
              className="min-h-11 rounded border border-line-strong bg-surface px-3 py-2 font-normal"
            >
              <option value="api-key">Anthropic API key</option>
              <option value="oauth">Claude Code OAuth token</option>
            </select>
          </label>
        )}
        {value.authMode !== 'ambient' && (
          <label className="flex flex-col gap-1 text-sm font-medium">
            {value.authMode === 'oauth' ? 'Claude Code OAuth token' : 'API key'}
            <input
              type="password"
              value={credential}
              disabled={disabled}
              autoComplete="new-password"
              onChange={(event) => setCredential(event.target.value)}
              placeholder={
                credentialConfigured
                  ? 'Leave blank to retain stored credential'
                  : 'Required before use'
              }
              className="min-h-11 rounded border border-line-strong px-3 py-2 font-normal"
            />
            <span className="text-xs font-normal text-ink-muted">
              {credentialConfigured
                ? 'A credential is configured. It is write-only and never returned.'
                : 'No credential is currently configured.'}
            </span>
          </label>
        )}
      </div>

      <fieldset className="mt-5 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-semibold">Cost model</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={pricingEnabled}
            disabled={disabled}
            onChange={(event) => {
              setPricingEnabled(event.target.checked);
              onChange({
                ...value,
                pricing: event.target.checked
                  ? (value.pricing ?? {
                      inputPerMTok: 0,
                      outputPerMTok: 0,
                      cacheReadPerMTok: 0,
                      cacheWritePerMTok: 0,
                    })
                  : null,
              });
            }}
            className="mt-1"
          />
          <span>
            <strong className="font-medium">Use custom pricing</strong>
            <span className="block text-xs text-ink-muted">
              Required for configured-cost reporting. Input and output rates must be positive. A
              cache rate may be zero, but an invocation using that bucket is reported as unpriced.
              Prices are USD per one million tokens and are snapshotted per invocation.
            </span>
          </span>
        </label>
        {pricingEnabled && value.pricing && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(
              [
                ['inputPerMTok', 'Input'],
                ['outputPerMTok', 'Output'],
                ['cacheReadPerMTok', 'Cache read'],
                ['cacheWritePerMTok', 'Cache write'],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex flex-col gap-1 text-xs font-medium text-ink-secondary"
              >
                {label} / MTok
                <input
                  type="number"
                  min={0}
                  step="0.000001"
                  value={value.pricing![key]}
                  disabled={disabled}
                  onChange={(event) => updatePricing(key, event.target.value)}
                  className="min-h-10 rounded border border-line-strong px-2 py-1.5 text-sm font-normal"
                />
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-xs text-ink-muted">
          Standard Claude provider telemetry is accepted only on an authenticated loopback receiver,
          recursively redacted, and linked to the durable invocation ledger. Raw API bodies stay
          disabled.
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            void onSave(credential)
              .then(() => setCredential(''))
              .catch(() => undefined)
          }
          className="min-h-11 rounded bg-strong px-4 py-2 text-sm font-semibold text-on-strong disabled:bg-ink-faint"
        >
          {disabled ? 'Saving…' : 'Save investigator model'}
        </button>
      </div>
    </section>
  );
}
