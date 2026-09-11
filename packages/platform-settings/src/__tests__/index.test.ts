import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Redis } from 'ioredis';
import { makeDb, platformSettings, type DbHandle } from '@sre/db';
import { DEFAULT_EVIDENCE_BUDGET_CHARS, SHORTEST_EVIDENCE_BLOCK_CHARS } from '@sre/db';
import { PlatformSettings } from '../index';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';
const TOKEN_LIFETIME_KEY = 'MAX_TOKEN_LIFETIME_SEC';
const KEY = 'CLASSIFY_FAIRNESS_WINDOW_SEC';
const ARCHIVE_KEY = 'INCIDENT_AUTO_ARCHIVE_DAYS';
const RECOVERY_KEY = 'RECOVERY_MAX_CHECKS';
const EVIDENCE_ROWS_KEY = 'EVIDENCE_ROW_LIMIT';
const EVIDENCE_BUDGET_KEY = 'EVIDENCE_BUDGET_CHARS';
const AUTOMATIC_BUDGET_KEYS = [
  'AUTO_INVESTIGATION_TENANT_LIMIT_24H',
  'AUTO_INVESTIGATION_MONITOR_LIMIT_24H',
  'AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H',
  'AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H',
] as const;
const automaticBudgetDefaults = AUTOMATIC_BUDGET_KEYS.map((key) => ({
  key,
  value: 0,
  defaultValue: 0,
}));
function numericDefaults(value: number, defaultValue: number) {
  return [
    { key: TOKEN_LIFETIME_KEY, value: 86_400, defaultValue: 86_400 },
    { key: 'SESSION_IDLE_SECONDS', value: 86_400, defaultValue: 86_400 },
    { key: 'SESSION_ABSOLUTE_SECONDS', value: 604_800, defaultValue: 604_800 },
    { key: KEY, value, defaultValue },
    { key: ARCHIVE_KEY, value: 7, defaultValue: 7 },
    { key: RECOVERY_KEY, value: 3, defaultValue: 3 },
    { key: EVIDENCE_ROWS_KEY, value: 1000, defaultValue: 1000 },
    { key: EVIDENCE_BUDGET_KEY, value: 24000, defaultValue: 24000 },
    ...automaticBudgetDefaults,
  ];
}
const CACHE_KEY = `platform-settings:${KEY}`;
const VERSION_KEY = `${CACHE_KEY}:version`;
let admin: DbHandle;
let redis: Redis;

async function clearState(): Promise<void> {
  await admin.sql.unsafe('DELETE FROM public.platform_settings');
  await redis.flushdb();
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  redis = new Redis(VALKEY_URL, { db: 14, maxRetriesPerRequest: null });
}, 30_000);

afterAll(async () => {
  redis?.disconnect();
  if (admin) await admin.close();
});

describe('platform setting registry', () => {
  test('loads a complete SMTP fallback and accepts a durable disable', async () => {
    await clearState();
    const configured = new PlatformSettings(admin.db, redis, {
      env: {
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_FROM: 'alerts@example.test',
      } as NodeJS.ProcessEnv,
    });
    await expect(configured.smtp()).resolves.toMatchObject({
      source: 'environment',
      config: { host: 'smtp.example.test', port: 465, secure: true },
    });
    await expect(configured.set('SMTP', null)).resolves.toBeNull();
    await expect(configured.smtp()).resolves.toMatchObject({ source: 'stored', config: null });
  });

  test('lists numeric automation settings and derives missing-row defaults from env', async () => {
    await clearState();
    const valid = new PlatformSettings(admin.db, redis, {
      env: { CLASSIFY_FAIRNESS_WINDOW_SEC: '900' } as NodeJS.ProcessEnv,
    });
    try {
      expect(await valid.list()).toEqual(numericDefaults(900, 900));
    } finally {
      await valid.close();
    }

    for (const value of [undefined, '0', '-1', '1.5', 'invalid']) {
      const settings = new PlatformSettings(admin.db, redis, {
        env: (value === undefined
          ? {}
          : { CLASSIFY_FAIRNESS_WINDOW_SEC: value }) as NodeJS.ProcessEnv,
      });
      try {
        expect(await settings.list()).toEqual(numericDefaults(3600, 3600));
      } finally {
        await settings.close();
      }
    }
  });

  test('resolves an environment LLM fallback, validates a stored replacement, and keeps it out of the numeric registry', async () => {
    await clearState();
    const settings = new PlatformSettings(admin.db, redis, {
      env: {
        LLM_PROVIDER: 'openai',
        OPENAI_MODEL: 'gpt-test',
      } as NodeJS.ProcessEnv,
    });
    try {
      expect(await settings.llmRuntime()).toMatchObject({
        source: 'environment',
        updatedAt: null,
        config: {
          runtime: 'openai-chat',
          provider: 'openai',
          model: 'gpt-test',
          authMode: 'api-key',
          pricing: null,
        },
      });
      const stored = {
        runtime: 'claude-agent-sdk' as const,
        provider: 'custom-anthropic' as const,
        model: 'private-model',
        baseUrl: 'https://llm.example.com',
        authMode: 'api-key' as const,
        maxTurns: 12,
        pricing: {
          inputPerMTok: 1,
          outputPerMTok: 2,
          cacheReadPerMTok: 0.1,
          cacheWritePerMTok: 1.25,
        },
      };
      await expect(settings.set('LLM_RUNTIME', stored)).resolves.toEqual(stored);
      expect(await settings.llmRuntime()).toMatchObject({ source: 'stored', config: stored });
      expect((await settings.llmRuntime()).updatedAt).toBeInstanceOf(Date);
      expect((await settings.list()).map((entry) => entry.key)).toEqual([
        TOKEN_LIFETIME_KEY,
        'SESSION_IDLE_SECONDS',
        'SESSION_ABSOLUTE_SECONDS',
        KEY,
        ARCHIVE_KEY,
        RECOVERY_KEY,
        EVIDENCE_ROWS_KEY,
        EVIDENCE_BUDGET_KEY,
        ...AUTOMATIC_BUDGET_KEYS,
      ]);
    } finally {
      await settings.close();
    }
  });

  test('rejects malformed automatic-budget environment values instead of disabling the guard', () => {
    for (const value of ['', '-1', '1.5', 'invalid', 'Infinity'])
      expect(
        () =>
          new PlatformSettings(admin.db, redis, {
            env: {
              AUTO_INVESTIGATION_TENANT_LIMIT_24H: value,
            } as NodeJS.ProcessEnv,
          }),
      ).toThrow('invalid automatic investigation budget environment');
  });

  test('rejects incompatible runtime, provider, auth, URL, and pricing combinations', async () => {
    await clearState();
    const settings = new PlatformSettings(admin.db, redis);
    try {
      await expect(
        settings.set('LLM_RUNTIME', {
          runtime: 'openai-chat',
          provider: 'anthropic',
          model: 'wrong',
          baseUrl: null,
          authMode: 'oauth',
          maxTurns: 8,
          pricing: null,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        settings.set('LLM_RUNTIME', {
          runtime: 'openai-chat',
          provider: 'openai',
          model: 'zero-cost-placeholder',
          baseUrl: null,
          authMode: 'api-key',
          maxTurns: 8,
          pricing: {
            inputPerMTok: 0,
            outputPerMTok: 0,
            cacheReadPerMTok: 1,
            cacheWritePerMTok: 0,
          },
        }),
      ).rejects.toBeInstanceOf(TypeError);
      for (const baseUrl of [
        'https://user:password@llm.example.com',
        'https://llm.example.com?api_key=secret',
        'https://llm.example.com#credential',
      ]) {
        await expect(
          settings.set('LLM_RUNTIME', {
            runtime: 'claude-agent-sdk',
            provider: 'custom-anthropic',
            model: 'wrong',
            baseUrl,
            authMode: 'api-key',
            maxTurns: 8,
            pricing: null,
          }),
        ).rejects.toBeInstanceOf(TypeError);
      }
      await expect(
        settings.set('LLM_RUNTIME', {
          runtime: 'claude-agent-sdk',
          provider: 'custom-anthropic',
          model: 'wrong',
          baseUrl: 'http://llm.example.com',
          authMode: 'api-key',
          maxTurns: 8,
          pricing: null,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        settings.set('LLM_RUNTIME', {
          runtime: 'claude-agent-sdk',
          provider: 'custom-anthropic',
          model: 'wrong',
          baseUrl: null,
          authMode: 'api-key',
          maxTurns: 8,
          pricing: null,
        }),
      ).rejects.toBeInstanceOf(TypeError);
    } finally {
      await settings.close();
    }
  });
});

describe('PlatformSettings', () => {
  test('returns the env fallback for a missing row and a valid durable value when present', async () => {
    await clearState();
    const first = new PlatformSettings(admin.db, redis, {
      env: { CLASSIFY_FAIRNESS_WINDOW_SEC: '7200' } as NodeJS.ProcessEnv,
    });
    try {
      expect(await first.get(KEY)).toBe(7200);
      expect(await first.list()).toEqual(numericDefaults(7200, 7200));
      expect(await first.set(KEY, 900)).toBe(900);
    } finally {
      await first.close();
    }

    await redis.flushdb();
    const second = new PlatformSettings(admin.db, redis);
    try {
      expect(await second.get(KEY)).toBe(900);
      expect(await second.list()).toEqual(numericDefaults(900, 3600));
    } finally {
      await second.close();
    }
  });

  test('accepts a bounded archive policy and uses zero to disable it', async () => {
    await clearState();
    const settings = new PlatformSettings(admin.db, redis, {
      env: { INCIDENT_AUTO_ARCHIVE_DAYS: '14' } as NodeJS.ProcessEnv,
    });
    try {
      expect(await settings.get(ARCHIVE_KEY)).toBe(14);
      await expect(settings.set(ARCHIVE_KEY, 0)).resolves.toBe(0);
      await expect(settings.set(ARCHIVE_KEY, 3_651)).rejects.toBeInstanceOf(TypeError);
      await expect(settings.set(ARCHIVE_KEY, 1.5)).rejects.toBeInstanceOf(TypeError);
    } finally {
      await settings.close();
    }
  });

  test('bounds the recovery-check and both evidence bounds', async () => {
    await clearState();
    const settings = new PlatformSettings(admin.db, redis, {
      env: { RECOVERY_MAX_CHECKS: '4' } as NodeJS.ProcessEnv,
    });
    // One instance, one test: platform_settings is global, so a second file writing it would race
    // this one's list assertions. Each rejected low value is the case that matters: 288 cuts rows
    // the default budget could have paid for, and one below a block returns nothing at all.
    const block = SHORTEST_EVIDENCE_BLOCK_CHARS;
    const cases = [
      { key: RECOVERY_KEY, accept: [1, 10], reject: [0, 11, 1.5] },
      { key: EVIDENCE_ROWS_KEY, accept: [289, 10_000], reject: [288, 10_001, 1.5] },
      {
        key: EVIDENCE_BUDGET_KEY,
        accept: [block, 200_000],
        reject: [block - 1, 200_001, 24_000.5],
      },
    ];
    try {
      expect(await settings.get(RECOVERY_KEY)).toBe(4);
      expect(Math.floor(DEFAULT_EVIDENCE_BUDGET_CHARS / block)).toBe(289);
      for (const { key, accept, reject } of cases) {
        for (const value of accept) await expect(settings.set(key, value)).resolves.toBe(value);
        for (const value of reject)
          await expect(settings.set(key, value)).rejects.toBeInstanceOf(TypeError);
      }
    } finally {
      await settings.close();
    }
  });

  test('accepts zero-unlimited automatic count and configured-cost budgets', async () => {
    await clearState();
    const settings = new PlatformSettings(admin.db, redis, {
      env: {
        AUTO_INVESTIGATION_TENANT_LIMIT_24H: '12',
        AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H: '4.5',
      } as NodeJS.ProcessEnv,
    });
    try {
      expect(await settings.get(AUTOMATIC_BUDGET_KEYS[0])).toBe(12);
      expect(await settings.get(AUTOMATIC_BUDGET_KEYS[3])).toBe(4.5);
      await expect(settings.set(AUTOMATIC_BUDGET_KEYS[0], 0)).resolves.toBe(0);
      await expect(settings.set(AUTOMATIC_BUDGET_KEYS[2], 1.25)).resolves.toBe(1.25);
      await expect(settings.set(AUTOMATIC_BUDGET_KEYS[0], 1.5)).rejects.toBeInstanceOf(TypeError);
      await expect(settings.set(AUTOMATIC_BUDGET_KEYS[2], -1)).rejects.toBeInstanceOf(TypeError);
    } finally {
      await settings.close();
    }
  });

  test('rejects unknown keys and invalid values before mutating the durable store', async () => {
    await clearState();
    const settings = new PlatformSettings(admin.db, redis);
    try {
      await expect(settings.set('UNKNOWN', 10)).rejects.toBeInstanceOf(TypeError);
      for (const value of [0, -1, 1.5, '900', null]) {
        await expect(settings.set(KEY, value)).rejects.toBeInstanceOf(TypeError);
      }
      const rows = await admin.sql`SELECT key FROM public.platform_settings`;
      expect(rows).toHaveLength(0);
    } finally {
      await settings.close();
    }
  });

  test.each([
    ['malformed JSON', '{not-json', true],
    ['a schema-invalid value', '0', true],
    ['a non-expiring value', '1200', false],
  ])(
    'reports %s in shared cache and falls through to Postgres',
    async (_label, cached, expires) => {
      await clearState();
      const writer = new PlatformSettings(admin.db, redis);
      await writer.set(KEY, 1800);
      await writer.close();
      if (expires) await redis.set(CACHE_KEY, cached, 'EX', 30);
      else await redis.set(CACHE_KEY, cached);

      const onCacheError = vi.fn();
      const reader = new PlatformSettings(admin.db, redis, { onCacheError });
      try {
        expect(await reader.get(KEY)).toBe(1800);
        expect(onCacheError).toHaveBeenCalledTimes(1);
      } finally {
        await reader.close();
      }
    },
  );

  test('surfaces invalid durable data', async () => {
    await clearState();
    await redis.flushdb();
    await admin.sql.unsafe(
      `INSERT INTO public.platform_settings (key, value) VALUES ('${KEY}', '0'::jsonb)`,
    );
    const corruptReader = new PlatformSettings(admin.db, redis);
    try {
      await expect(corruptReader.get(KEY)).rejects.toThrow(/invalid|corrupt/i);
    } finally {
      await corruptReader.close();
    }
  });

  test('falls through to Postgres when the shared cache read fails', async () => {
    await clearState();
    const writer = new PlatformSettings(admin.db, redis);
    await writer.set(KEY, 1500);
    await writer.close();
    await redis.flushdb();

    const onCacheError = vi.fn();
    const transaction = redis.multi();
    const exec = vi
      .spyOn(transaction, 'exec')
      .mockRejectedValueOnce(new Error('Valkey unavailable'));
    const multi = vi.spyOn(redis, 'multi').mockReturnValueOnce(transaction);
    const reader = new PlatformSettings(admin.db, redis, { onCacheError });
    try {
      expect(await reader.get(KEY)).toBe(1500);
      expect(onCacheError).toHaveBeenCalledTimes(1);
    } finally {
      multi.mockRestore();
      exec.mockRestore();
      await reader.close();
    }
  });

  test('a local cache entry cannot outlive the remaining shared cache TTL', async () => {
    await clearState();
    const writer = new PlatformSettings(admin.db, redis);
    await writer.set(KEY, 2400);
    await writer.close();
    await redis.set(CACHE_KEY, '1200', 'PX', 1_000);

    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const reader = new PlatformSettings(admin.db, redis);
    try {
      expect(await reader.get(KEY)).toBe(1200);
      await redis.del(CACHE_KEY);
      now.mockReturnValue(1_001_500);
      expect(await reader.get(KEY)).toBe(2400);
    } finally {
      now.mockRestore();
      await reader.close();
    }
  });

  test('pub/sub invalidates another live instance and TTL bounds a missed event', async () => {
    await clearState();
    const duplicate = vi.spyOn(redis, 'duplicate');
    const publisher = new PlatformSettings(admin.db, redis);
    const subscriber = new PlatformSettings(admin.db, redis);
    await Promise.all([publisher.start(), subscriber.start()]);
    try {
      expect(duplicate).toHaveBeenCalledWith({
        maxRetriesPerRequest: null,
        commandTimeout: undefined,
        autoResendUnfulfilledCommands: true,
        enableOfflineQueue: true,
      });
      expect(await subscriber.get(KEY)).toBe(3600);
      await publisher.set(KEY, 4800);
      await expect.poll(() => subscriber.get(KEY), { timeout: 1_000, interval: 20 }).toBe(4800);
    } finally {
      await Promise.all([publisher.close(), subscriber.close()]);
      duplicate.mockRestore();
    }

    await clearState();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const writer = new PlatformSettings(admin.db, redis);
    const missedSubscriber = new PlatformSettings(admin.db, redis);
    try {
      expect(await missedSubscriber.get(KEY)).toBe(3600);
      await writer.set(KEY, 5400);
      expect(await missedSubscriber.get(KEY)).toBe(3600);
      now.mockReturnValue(1_031_000);
      expect(await missedSubscriber.get(KEY)).toBe(5400);
    } finally {
      now.mockRestore();
      await Promise.all([writer.close(), missedSubscriber.close()]);
    }
  });

  test('reports subscription setup failure without rejecting start', async () => {
    const onCacheError = vi.fn();
    const error = new Error('subscription setup failed');
    const duplicate = vi.spyOn(redis, 'duplicate').mockImplementationOnce(() => {
      throw error;
    });
    const settings = new PlatformSettings(admin.db, redis, { onCacheError });
    try {
      await expect(settings.start()).resolves.toBeUndefined();
      expect(onCacheError).toHaveBeenCalledWith(error);
    } finally {
      duplicate.mockRestore();
      await settings.close();
    }
  });

  test('a timed-out atomic cache propagation reports degradation without hiding the durable write', async () => {
    await clearState();
    const onCacheError = vi.fn();
    const settings = new PlatformSettings(admin.db, redis, { onCacheError });
    const evalCommand = vi
      .spyOn(redis, 'eval')
      .mockRejectedValueOnce(new Error('Command timed out'));
    try {
      await expect(settings.set(KEY, 7800)).resolves.toBe(7800);
      expect(onCacheError).toHaveBeenCalledTimes(1);
    } finally {
      evalCommand.mockRestore();
      await settings.close();
    }

    await redis.flushdb();
    const reader = new PlatformSettings(admin.db, redis);
    try {
      expect(await reader.get(KEY)).toBe(7800);
    } finally {
      await reader.close();
    }
  });

  test('setting the same key twice updates one row and a fresh reader gets the second value', async () => {
    await clearState();
    const settings = new PlatformSettings(admin.db, redis);
    let firstUpdatedAt: Date;
    try {
      expect(await settings.set(KEY, 1200)).toBe(1200);
      const firstRows = await admin.db
        .select({ updatedAt: platformSettings.updatedAt })
        .from(platformSettings);
      firstUpdatedAt = firstRows[0]!.updatedAt;
      expect(firstUpdatedAt).toBeInstanceOf(Date);
      expect(await settings.set(KEY, 2400)).toBe(2400);
    } finally {
      await settings.close();
    }

    const rows = await admin.db
      .select({ value: platformSettings.value, updatedAt: platformSettings.updatedAt })
      .from(platformSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(2400);
    expect(rows[0]!.updatedAt).toBeInstanceOf(Date);
    expect(rows[0]!.updatedAt.getTime()).toBeGreaterThan(firstUpdatedAt.getTime());

    const reader = new PlatformSettings(admin.db, redis);
    try {
      expect(await reader.get(KEY)).toBe(2400);
    } finally {
      await reader.close();
    }
  });

  test('a delayed older cache command cannot overwrite a newer durable version', async () => {
    await clearState();
    const redisA = new Redis(VALKEY_URL, { db: 14, maxRetriesPerRequest: null });
    const redisB = new Redis(VALKEY_URL, { db: 14, maxRetriesPerRequest: null });
    const delayed = new PlatformSettings(admin.db, redisA);
    const later = new PlatformSettings(admin.db, redisB);
    const evalCommand = vi.spyOn(redisA, 'eval').mockResolvedValueOnce(0);
    try {
      await expect(delayed.set(KEY, 1200)).resolves.toBe(1200);
      const captured = evalCommand.mock.calls[0];
      expect(captured).toBeDefined();
      evalCommand.mockRestore();

      await expect(later.set(KEY, 2400)).resolves.toBe(2400);
      expect(await redisB.get(CACHE_KEY)).toBe('2400');
      const currentVersion = await redisB.get(VERSION_KEY);
      expect(Number.isSafeInteger(Number(currentVersion))).toBe(true);
      expect(Number(currentVersion)).toBeGreaterThan(Number(captured![5]));
      expect(await redisB.pttl(VERSION_KEY)).toBe(-1);

      await redisB.del(CACHE_KEY);
      const [script, keyCount, ...args] = captured!;
      await expect(redisA.eval(script, keyCount, ...args)).resolves.toBe(0);
      expect(await redisB.get(CACHE_KEY)).toBeNull();
      expect(await redisB.get(VERSION_KEY)).toBe(currentVersion);
    } finally {
      evalCommand.mockRestore();
      await Promise.all([delayed.close(), later.close()]);
      redisA.disconnect();
      redisB.disconnect();
    }

    const rows = await admin.sql`SELECT value FROM public.platform_settings WHERE key = ${KEY}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(2400);
    const reader = new PlatformSettings(admin.db, redis);
    try {
      expect(await reader.get(KEY)).toBe(2400);
    } finally {
      await reader.close();
    }
  });
});
