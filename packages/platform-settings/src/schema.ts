// Setting keys, their validation schemas, and bootstrap defaults. Split from index.ts, which holds
// the store and is at its line cap; a new setting lands here rather than growing that file.
import { isUsableLlmPricing, type LlmRuntimeConfig } from '@sre/contracts';
import { DEFAULT_EVIDENCE_BUDGET_CHARS, SHORTEST_EVIDENCE_BLOCK_CHARS } from '@sre/db';
import { z } from 'zod';

const NUMERIC_SETTING_KEYS = [
  'MAX_TOKEN_LIFETIME_SEC',
  'SESSION_IDLE_SECONDS',
  'SESSION_ABSOLUTE_SECONDS',
  'CLASSIFY_FAIRNESS_WINDOW_SEC',
  'INCIDENT_AUTO_ARCHIVE_DAYS',
  'RECOVERY_MAX_CHECKS',
  'EVIDENCE_ROW_LIMIT',
  'EVIDENCE_BUDGET_CHARS',
  'AUTO_INVESTIGATION_TENANT_LIMIT_24H',
  'AUTO_INVESTIGATION_MONITOR_LIMIT_24H',
  'AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H',
  'AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H',
] as const;
/** Every platform-global setting key. Exported so the documentation generator cannot miss one. */
export const SETTING_KEYS = [
  ...NUMERIC_SETTING_KEYS,
  'REGISTRATION_MODE',
  'PRODUCT_NAME',
  'PRODUCT_VALUE_LINE',
  'TERMS_URL',
  'PRIVACY_URL',
  'SUPPORT_URL',
  'LLM_RUNTIME',
  'SMTP',
] as const;
export type PlatformSettingKey = (typeof SETTING_KEYS)[number];

const pricingSchema = z
  .object({
    inputPerMTok: z.number().nonnegative(),
    outputPerMTok: z.number().nonnegative(),
    cacheReadPerMTok: z.number().nonnegative(),
    cacheWritePerMTok: z.number().nonnegative(),
  })
  .refine(isUsableLlmPricing, {
    message: 'configured pricing requires positive input and output rates',
  });

export const llmRuntimeConfigSchema = z
  .object({
    runtime: z.enum(['claude-agent-sdk', 'openai-chat']),
    provider: z.enum(['anthropic', 'custom-anthropic', 'bedrock', 'openai']),
    model: z.string().trim().min(1).max(200),
    baseUrl: z
      .string()
      .trim()
      .pipe(z.url({ protocol: /^https$/ }))
      .nullable(),
    authMode: z.enum(['api-key', 'oauth', 'ambient']),
    maxTurns: z.number().int().min(1).max(64),
    pricing: pricingSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const allowed =
      (value.runtime === 'openai-chat' &&
        value.provider === 'openai' &&
        value.authMode === 'api-key') ||
      (value.runtime === 'claude-agent-sdk' &&
        value.provider === 'anthropic' &&
        (value.authMode === 'api-key' || value.authMode === 'oauth')) ||
      (value.runtime === 'claude-agent-sdk' &&
        value.provider === 'custom-anthropic' &&
        value.authMode === 'api-key') ||
      (value.runtime === 'claude-agent-sdk' &&
        value.provider === 'bedrock' &&
        value.authMode === 'ambient');
    if (!allowed) {
      ctx.addIssue({
        code: 'custom',
        message: 'runtime, provider, and authentication mode are not compatible',
      });
    }
    if (value.provider === 'custom-anthropic' && value.baseUrl === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'custom provider requires a URL',
      });
    }
    if (value.provider === 'custom-anthropic' && value.baseUrl !== null) {
      const url = new URL(value.baseUrl);
      if (url.username || url.password || url.search || url.hash) {
        ctx.addIssue({
          code: 'custom',
          path: ['baseUrl'],
          message:
            'custom provider URL cannot contain credentials, query parameters, or a fragment',
        });
      }
    }
    if (value.provider !== 'custom-anthropic' && value.baseUrl !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'base URL is only valid for a custom Anthropic-compatible provider',
      });
    }
  });

export const smtpSettingsSchema = z
  .object({
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    secure: z.boolean(),
    from: z.email(),
    username: z.string().trim().min(1).max(320).optional(),
  })
  .nullable();
export type SmtpSettings = Exclude<z.infer<typeof smtpSettingsSchema>, null>;

interface PlatformSettingValueMap {
  MAX_TOKEN_LIFETIME_SEC: number;
  SESSION_IDLE_SECONDS: number;
  SESSION_ABSOLUTE_SECONDS: number;
  CLASSIFY_FAIRNESS_WINDOW_SEC: number;
  INCIDENT_AUTO_ARCHIVE_DAYS: number;
  RECOVERY_MAX_CHECKS: number;
  EVIDENCE_ROW_LIMIT: number;
  EVIDENCE_BUDGET_CHARS: number;
  AUTO_INVESTIGATION_TENANT_LIMIT_24H: number;
  AUTO_INVESTIGATION_MONITOR_LIMIT_24H: number;
  AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H: number;
  AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H: number;
  REGISTRATION_MODE: 'open' | 'approval_required' | 'closed';
  PRODUCT_NAME: string;
  PRODUCT_VALUE_LINE: string;
  TERMS_URL: string | null;
  PRIVACY_URL: string | null;
  SUPPORT_URL: string | null;
  LLM_RUNTIME: LlmRuntimeConfig;
  SMTP: SmtpSettings | null;
}

const schemas: { [K in PlatformSettingKey]: z.ZodType<PlatformSettingValueMap[K]> } = {
  MAX_TOKEN_LIFETIME_SEC: z.number().int().min(300).max(2_592_000),
  SESSION_IDLE_SECONDS: z.number().int().min(300).max(604_800),
  SESSION_ABSOLUTE_SECONDS: z.number().int().min(300).max(2_592_000),
  CLASSIFY_FAIRNESS_WINDOW_SEC: z.number().int().positive(),
  INCIDENT_AUTO_ARCHIVE_DAYS: z.number().int().min(0).max(3_650),
  RECOVERY_MAX_CHECKS: z.number().int().min(1).max(10),
  // The most lines the DEFAULT budget can pay for. Below it the row ceiling stops bounding the read
  // and starts deciding what the investigator sees. Computed rather than restated, so neither
  // constant can drift away from it. Raising the BUDGET past its default moves the real break-even
  // above this floor, which the reload reports rather than this bound predicting it.
  EVIDENCE_ROW_LIMIT: z
    .number()
    .int()
    .min(Math.floor(DEFAULT_EVIDENCE_BUDGET_CHARS / SHORTEST_EVIDENCE_BLOCK_CHARS))
    .max(10_000),
  // One whole block is the floor: below it every candidate line overflows the budget and the reload
  // returns nothing, so an investigation would resume blind rather than merely trimmed. The ceiling
  // is a chosen guard on prompt size, not a derived quantity.
  EVIDENCE_BUDGET_CHARS: z.number().int().min(SHORTEST_EVIDENCE_BLOCK_CHARS).max(200_000),
  AUTO_INVESTIGATION_TENANT_LIMIT_24H: z.number().int().nonnegative(),
  AUTO_INVESTIGATION_MONITOR_LIMIT_24H: z.number().int().nonnegative(),
  AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H: z.number().nonnegative(),
  AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H: z.number().nonnegative(),
  REGISTRATION_MODE: z.enum(['open', 'approval_required', 'closed']),
  PRODUCT_NAME: z.string().trim().min(1).max(80),
  PRODUCT_VALUE_LINE: z.string().trim().min(1).max(180),
  TERMS_URL: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^https?$/ }))
    .nullable(),
  PRIVACY_URL: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^https?$/ }))
    .nullable(),
  SUPPORT_URL: z
    .string()
    .trim()
    .pipe(z.url({ protocol: /^https?$/ }))
    .nullable(),
  LLM_RUNTIME: llmRuntimeConfigSchema,
  SMTP: smtpSettingsSchema,
};

function isPlatformSettingKey(key: string): key is PlatformSettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

function parseWrite(
  key: string,
  value: unknown,
): { key: PlatformSettingKey; value: PlatformSettingValueMap[PlatformSettingKey] } {
  if (!isPlatformSettingKey(key)) throw new TypeError(`unknown platform setting: ${key}`);
  const parsed = schemas[key].safeParse(value);
  if (!parsed.success) throw new TypeError(`invalid value for platform setting: ${key}`);
  return { key, value: parsed.data };
}

function llmDefault(env: NodeJS.ProcessEnv): LlmRuntimeConfig {
  const maxTurns = (value: string | undefined): number => {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? Math.max(1, Math.min(64, parsed)) : 8;
  };
  const provider = env.LLM_PROVIDER?.trim() === 'openai' ? 'openai' : 'anthropic';
  if (provider === 'openai') {
    return {
      runtime: 'openai-chat',
      provider,
      model: env.OPENAI_MODEL?.trim() ?? '',
      baseUrl: null,
      authMode: 'api-key',
      maxTurns: maxTurns(env.OPENAI_MAX_TURNS),
      pricing: null,
    };
  }
  return {
    runtime: 'claude-agent-sdk',
    provider,
    model: env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-8',
    baseUrl: null,
    authMode: env.ANTHROPIC_API_KEY?.trim() ? 'api-key' : 'oauth',
    maxTurns: maxTurns(env.ANTHROPIC_MAX_TURNS),
    pricing: null,
  };
}

function smtpDefault(env: NodeJS.ProcessEnv): SmtpSettings | null {
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_FROM', 'SMTP_USERNAME'] as const;
  if (keys.every((key) => env[key] === undefined)) return null;
  const secure =
    env.SMTP_SECURE === 'true' ? true : env.SMTP_SECURE === 'false' ? false : undefined;
  const parsed = smtpSettingsSchema.safeParse({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT),
    secure,
    from: env.SMTP_FROM,
    ...(env.SMTP_USERNAME?.trim() ? { username: env.SMTP_USERNAME.trim() } : {}),
  });
  if (!parsed.success || !parsed.data) throw new Error('invalid SMTP environment');
  return parsed.data;
}

function automaticBudgetDefault(
  env: NodeJS.ProcessEnv,
  key: (typeof AUTOMATIC_BUDGET_KEYS)[number],
): number {
  const raw = env[key];
  if (raw === undefined) return 0;
  if (raw.trim() === '')
    throw new Error(`invalid automatic investigation budget environment: ${key}`);
  const parsed = schemas[key].safeParse(Number(raw));
  if (!parsed.success)
    throw new Error(`invalid automatic investigation budget environment: ${key}`);
  return parsed.data;
}

function optionalUrlDefault(
  env: NodeJS.ProcessEnv,
  key: 'TERMS_URL' | 'PRIVACY_URL' | 'SUPPORT_URL',
) {
  const value = env[key]?.trim();
  if (!value) return null;
  const parsed = schemas[key].safeParse(value);
  if (!parsed.success) throw new Error(`invalid platform URL environment: ${key}`);
  return parsed.data;
}

const AUTOMATIC_BUDGET_KEYS = [
  'AUTO_INVESTIGATION_TENANT_LIMIT_24H',
  'AUTO_INVESTIGATION_MONITOR_LIMIT_24H',
  'AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H',
  'AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H',
] as const;

/**
 * Reads one bootstrap-fallback setting from the environment.
 *
 * These keys ignore an unusable environment value and use the built-in default, unlike the spending
 * limits above, which refuse to start. The difference is the fail direction: a wrong evidence bound
 * trims a prompt, a wrong spending limit spends money.
 */
function numericDefault(
  env: NodeJS.ProcessEnv,
  key: Exclude<(typeof NUMERIC_SETTING_KEYS)[number], (typeof AUTOMATIC_BUDGET_KEYS)[number]>,
  fallback: number,
): number {
  const parsed = schemas[key].safeParse(Number(env[key]));
  return parsed.success ? parsed.data : fallback;
}

function loadDefaults(env: NodeJS.ProcessEnv = process.env): {
  [K in PlatformSettingKey]: PlatformSettingValueMap[K];
} {
  return {
    MAX_TOKEN_LIFETIME_SEC: numericDefault(env, 'MAX_TOKEN_LIFETIME_SEC', 86_400),
    SESSION_IDLE_SECONDS: numericDefault(env, 'SESSION_IDLE_SECONDS', 86_400),
    SESSION_ABSOLUTE_SECONDS: numericDefault(env, 'SESSION_ABSOLUTE_SECONDS', 604_800),
    CLASSIFY_FAIRNESS_WINDOW_SEC: numericDefault(env, 'CLASSIFY_FAIRNESS_WINDOW_SEC', 3600),
    INCIDENT_AUTO_ARCHIVE_DAYS: numericDefault(env, 'INCIDENT_AUTO_ARCHIVE_DAYS', 7),
    RECOVERY_MAX_CHECKS: numericDefault(env, 'RECOVERY_MAX_CHECKS', 3),
    EVIDENCE_ROW_LIMIT: numericDefault(env, 'EVIDENCE_ROW_LIMIT', 1000),
    EVIDENCE_BUDGET_CHARS: numericDefault(
      env,
      'EVIDENCE_BUDGET_CHARS',
      DEFAULT_EVIDENCE_BUDGET_CHARS,
    ),
    AUTO_INVESTIGATION_TENANT_LIMIT_24H: automaticBudgetDefault(
      env,
      'AUTO_INVESTIGATION_TENANT_LIMIT_24H',
    ),
    AUTO_INVESTIGATION_MONITOR_LIMIT_24H: automaticBudgetDefault(
      env,
      'AUTO_INVESTIGATION_MONITOR_LIMIT_24H',
    ),
    AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H: automaticBudgetDefault(
      env,
      'AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H',
    ),
    AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H: automaticBudgetDefault(
      env,
      'AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H',
    ),
    REGISTRATION_MODE:
      env.REGISTRATION_MODE === 'open' || env.REGISTRATION_MODE === 'closed'
        ? env.REGISTRATION_MODE
        : 'approval_required',
    PRODUCT_NAME: env.PRODUCT_NAME?.trim() || 'SRE Platform',
    PRODUCT_VALUE_LINE:
      env.PRODUCT_VALUE_LINE?.trim() ||
      'Built to work alongside you like a senior SRE: investigate problems, connect evidence across your systems, and help determine what to do next.',
    TERMS_URL: optionalUrlDefault(env, 'TERMS_URL'),
    PRIVACY_URL: optionalUrlDefault(env, 'PRIVACY_URL'),
    SUPPORT_URL: optionalUrlDefault(env, 'SUPPORT_URL'),
    LLM_RUNTIME: llmDefault(env),
    SMTP: smtpDefault(env),
  };
}

// SETTING_KEYS, llmRuntimeConfigSchema and PlatformSettingKey are already exported inline above.
export {
  isPlatformSettingKey,
  parseWrite,
  loadDefaults,
  schemas,
  AUTOMATIC_BUDGET_KEYS,
  NUMERIC_SETTING_KEYS,
};
export type { PlatformSettingValueMap };
