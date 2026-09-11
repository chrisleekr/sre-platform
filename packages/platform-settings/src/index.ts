import {
  isUsableLlmPricing,
  type AutomaticInvestigationBudgetLimits,
  type LlmRuntimeConfig,
} from '@sre/contracts';
import { adminActions, platformSettings, type Db } from '@sre/db';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import {
  NUMERIC_SETTING_KEYS,
  isPlatformSettingKey,
  llmRuntimeConfigSchema,
  loadDefaults,
  parseWrite,
  schemas,
  type PlatformSettingKey,
  type PlatformSettingValueMap,
  type SmtpSettings,
} from './schema';

// Re-exported so `@sre/platform-settings` keeps one entrypoint: the split is internal.
export {
  SETTING_KEYS,
  llmRuntimeConfigSchema,
  smtpSettingsSchema,
  type PlatformSettingKey,
  type SmtpSettings,
} from './schema';

export interface PlatformSettingEntry {
  key: PlatformSettingKey;
  value: number;
  defaultValue: number;
}

export interface PlatformSettingsOptions {
  env?: NodeJS.ProcessEnv;
  onCacheError?: (error: unknown) => void;
}

export interface PlatformSettingAudit {
  actorUserId: string;
  reason?: string;
}

const CACHE_TTL_SEC = 30;
/**
 * Derives the secret-store key for one LLM runtime credential scope.
 *
 * @param config - Validated LLM runtime and authentication configuration.
 */
export function llmCredentialSecretName(config: LlmRuntimeConfig): string {
  const endpointScope =
    config.provider === 'custom-anthropic' && config.baseUrl
      ? `:${createHash('sha256').update(new URL(config.baseUrl).href).digest('hex')}`
      : '';
  return `llm:credential:${config.provider}:${config.authMode}${endpointScope}`;
}

/**
 * Returns the secret-free identity that binds evaluations to runtime behavior.
 * @param config - Validated LLM runtime configuration.
 */
export function llmRuntimeFingerprint(config: LlmRuntimeConfig): string {
  const behavioralConfig = {
    runtime: config.runtime,
    provider: config.provider,
    authMode: config.authMode,
    model: config.model,
    baseUrl: config.baseUrl,
    maxTurns: config.maxTurns,
  };
  return createHash('sha256').update(JSON.stringify(behavioralConfig)).digest('hex');
}
const CACHE_PREFIX = 'platform-settings:';
const INVALIDATION_CHANNEL = 'platform-settings:invalidate';
const PROPAGATE_CACHE = `
local current = tonumber(redis.call('GET', KEYS[2]))
local incoming = tonumber(ARGV[2])
if current and current > incoming then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('PUBLISH', ARGV[4], ARGV[5])
return 1
`;

/** Coordinates validated platform settings across Postgres, Valkey, and local caches. */
export class PlatformSettings {
  private readonly defaults: { [K in PlatformSettingKey]: PlatformSettingValueMap[K] };
  private readonly onCacheError?: (error: unknown) => void;
  private readonly local = new Map<
    PlatformSettingKey,
    { value: PlatformSettingValueMap[PlatformSettingKey]; expiresAt: number }
  >();
  private subscriber: Redis | null = null;

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    options: PlatformSettingsOptions = {},
  ) {
    this.defaults = loadDefaults(options.env);
    this.onCacheError = options.onCacheError;
  }

  async start(): Promise<void> {
    if (this.subscriber) return;
    let subscriber: Redis | null = null;
    try {
      subscriber = this.redis.duplicate({
        maxRetriesPerRequest: null,
        commandTimeout: undefined,
        autoResendUnfulfilledCommands: true,
        enableOfflineQueue: true,
      });
      this.subscriber = subscriber;
      subscriber.on('message', this.handleInvalidation);
      subscriber.on('error', this.handleSubscriberError);
      await subscriber.subscribe(INVALIDATION_CHANNEL);
    } catch (error) {
      if (subscriber) {
        subscriber.removeListener('message', this.handleInvalidation);
        subscriber.removeListener('error', this.handleSubscriberError);
        subscriber.disconnect();
      }
      if (this.subscriber === subscriber) this.subscriber = null;
      this.reportCacheError(error);
    }
  }

  async get<K extends PlatformSettingKey>(key: K): Promise<PlatformSettingValueMap[K]> {
    if (!isPlatformSettingKey(key)) throw new TypeError(`unknown platform setting: ${key}`);
    const local = this.local.get(key);
    if (local && local.expiresAt > Date.now()) return local.value as PlatformSettingValueMap[K];
    this.local.delete(key);

    const cacheKey = `${CACHE_PREFIX}${key}`;
    const cacheReadStartedAt = Date.now();
    try {
      const replies = await this.redis.multi().get(cacheKey).pttl(cacheKey).exec();
      const getReply = replies?.[0];
      const ttlReply = replies?.[1];
      if (!getReply || !ttlReply) throw new Error('incomplete platform settings cache read');
      if (getReply[0]) throw getReply[0];
      if (ttlReply[0]) throw ttlReply[0];

      const cached = getReply[1];
      const ttlMs = ttlReply[1];
      if (cached !== null) {
        const remainingTtlMs =
          typeof ttlMs === 'number' ? ttlMs - (Date.now() - cacheReadStartedAt) : 0;
        if (typeof cached !== 'string' || remainingTtlMs <= 0) {
          this.reportCacheError(new Error(`invalid cached platform setting: ${key}`));
        } else {
          const parsed = schemas[key].safeParse(JSON.parse(cached));
          if (parsed.success) {
            this.remember(key, parsed.data, remainingTtlMs);
            return parsed.data as PlatformSettingValueMap[K];
          }
          this.reportCacheError(new Error(`invalid cached platform setting: ${key}`));
        }
      }
    } catch (error) {
      this.reportCacheError(error);
    }

    const rows = await this.db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, key))
      .limit(1);
    if (!rows[0]) {
      const fallback = this.defaults[key];
      this.remember(key, fallback);
      return fallback as PlatformSettingValueMap[K];
    }

    const parsed = schemas[key].safeParse(rows[0].value);
    if (!parsed.success) throw new Error(`invalid durable platform setting: ${key}`);
    this.remember(key, parsed.data);
    return parsed.data as PlatformSettingValueMap[K];
  }

  async list(): Promise<PlatformSettingEntry[]> {
    return Promise.all(
      NUMERIC_SETTING_KEYS.map(async (key) => ({
        key,
        value: await this.get(key),
        defaultValue: this.defaults[key],
      })),
    );
  }

  async set(
    key: string,
    value: unknown,
    audit?: PlatformSettingAudit,
  ): Promise<PlatformSettingValueMap[PlatformSettingKey]> {
    const parsed = parseWrite(key, value);
    // postgres-js maps JavaScript null to SQL NULL. The settings column is deliberately NOT NULL,
    // while nullable structured settings use JSON null as a valid, explicit override of env defaults.
    const durableValue = parsed.value === null ? sql`'null'::jsonb` : parsed.value;
    const rows = await this.db.transaction(async (tx) => {
      const written = await tx
        .insert(platformSettings)
        .values({ key: parsed.key, value: durableValue })
        .onConflictDoUpdate({
          target: platformSettings.key,
          set: {
            value: durableValue,
            updatedAt: sql`greatest(${platformSettings.updatedAt} + interval '1 millisecond', clock_timestamp())`,
          },
        })
        .returning({ updatedAt: platformSettings.updatedAt });
      if (audit) {
        await tx.insert(adminActions).values({
          actorUserId: audit.actorUserId,
          action: 'setting.update',
          targetKind: 'setting',
          targetId: parsed.key,
          reason: audit.reason ?? null,
          details: {},
        });
      }
      return written;
    });
    const updatedAt = rows[0]?.updatedAt;
    if (!updatedAt) throw new Error(`platform setting write returned no row: ${parsed.key}`);

    try {
      const cacheKey = `${CACHE_PREFIX}${parsed.key}`;
      await this.redis.eval(
        PROPAGATE_CACHE,
        2,
        cacheKey,
        `${cacheKey}:version`,
        JSON.stringify(parsed.value),
        updatedAt.getTime(),
        CACHE_TTL_SEC,
        INVALIDATION_CHANNEL,
        parsed.key,
      );
    } catch (error) {
      this.reportCacheError(error);
    }
    return parsed.value;
  }

  async llmRuntime(): Promise<{
    config: LlmRuntimeConfig;
    source: 'stored' | 'environment';
    updatedAt: Date | null;
  }> {
    const rows = await this.db
      .select({ value: platformSettings.value, updatedAt: platformSettings.updatedAt })
      .from(platformSettings)
      .where(eq(platformSettings.key, 'LLM_RUNTIME'))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return { config: this.defaults.LLM_RUNTIME, source: 'environment', updatedAt: null };
    }
    const parsed = llmRuntimeConfigSchema.safeParse(row.value);
    if (!parsed.success) throw new Error('invalid durable platform setting: LLM_RUNTIME');
    return { config: parsed.data, source: 'stored', updatedAt: row.updatedAt };
  }

  async smtp(): Promise<{
    config: SmtpSettings | null;
    source: 'stored' | 'environment';
    updatedAt: Date | null;
  }> {
    const rows = await this.db
      .select({ value: platformSettings.value, updatedAt: platformSettings.updatedAt })
      .from(platformSettings)
      .where(eq(platformSettings.key, 'SMTP'))
      .limit(1);
    const row = rows[0];
    if (!row) return { config: this.defaults.SMTP, source: 'environment', updatedAt: null };
    const parsed = schemas.SMTP.safeParse(row.value);
    if (!parsed.success) throw new Error('invalid durable platform setting: SMTP');
    return { config: parsed.data, source: 'stored', updatedAt: row.updatedAt };
  }

  async close(): Promise<void> {
    const subscriber = this.subscriber;
    if (!subscriber) return;
    this.subscriber = null;
    subscriber.removeListener('message', this.handleInvalidation);
    subscriber.removeListener('error', this.handleSubscriberError);
    await subscriber.unsubscribe(INVALIDATION_CHANNEL);
    subscriber.disconnect();
  }

  private readonly handleInvalidation = (channel: string, key: string): void => {
    if (channel === INVALIDATION_CHANNEL && isPlatformSettingKey(key)) this.local.delete(key);
  };

  private readonly handleSubscriberError = (error: Error): void => {
    this.reportCacheError(error);
  };

  private remember(
    key: PlatformSettingKey,
    value: PlatformSettingValueMap[PlatformSettingKey],
    ttlMs = CACHE_TTL_SEC * 1000,
  ): void {
    this.local.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  private reportCacheError(error: unknown): void {
    try {
      this.onCacheError?.(error);
    } catch {
      // Reporting failures must not make a committed setting write look unsuccessful.
    }
  }
}

/**
 * Reads the one automatic-investigation policy shared by admission and operator views.
 *
 * @param settings - Durable setting and runtime readers.
 */
export async function loadAutomaticInvestigationBudgetLimits(
  settings: Pick<PlatformSettings, 'get' | 'llmRuntime'>,
): Promise<AutomaticInvestigationBudgetLimits> {
  const [
    tenantRunLimit,
    monitorRunLimit,
    tenantConfiguredCostLimitUsd,
    monitorConfiguredCostLimitUsd,
    runtime,
  ] = await Promise.all([
    settings.get('AUTO_INVESTIGATION_TENANT_LIMIT_24H'),
    settings.get('AUTO_INVESTIGATION_MONITOR_LIMIT_24H'),
    settings.get('AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H'),
    settings.get('AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H'),
    settings.llmRuntime(),
  ]);
  return {
    tenantRunLimit,
    monitorRunLimit,
    tenantConfiguredCostLimitUsd,
    monitorConfiguredCostLimitUsd,
    configuredCostReady: isUsableLlmPricing(runtime.config.pricing),
  };
}
