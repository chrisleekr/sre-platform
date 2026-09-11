import { describe, expect, test, vi } from 'vitest';
import { SlackConnectionError, type SlackConnectionIdentity } from '../slack-connection';
import {
  makeSlackStartupComposition,
  type SlackStartupConfig,
  type SlackStartupDeps,
} from '../slack-startup';

const APP_ID = 'ASTARTUP';
const APP_TOKEN = `xapp-1-${APP_ID}-token-secret`;
const IDENTITY: SlackConnectionIdentity = {
  botUserId: 'USTARTUP',
  botId: 'BSTARTUP',
  teamId: 'TSTARTUP',
  appId: APP_ID,
};

const completeRow = (overrides: Partial<SlackStartupConfig> = {}): SlackStartupConfig => ({
  id: 'cfg-startup',
  tenantId: 'tenant-startup',
  surface: 'slack',
  ...IDENTITY,
  ...overrides,
});

function composition(overrides: Partial<SlackStartupDeps> = {}) {
  const error = vi.fn();
  const processEvent = vi.fn(async () => 'classify_enqueued');
  const processInteraction = vi.fn(async () => 'interaction_processed');
  const deps = {
    listConfigs: async () => [] as SlackStartupConfig[],
    getBotToken: async () => 'xoxb-startup',
    getAppToken: async () => APP_TOKEN,
    validateIdentity: async () => IDENTITY,
    persistIdentity: async () => true,
    findRoute: async () => undefined,
    processEvent,
    processInteraction,
    log: { error },
    ...overrides,
  };
  return {
    startup: makeSlackStartupComposition(deps),
    error,
    processEvent,
    processInteraction,
  };
}

describe('Slack startup composition', () => {
  test('validates and atomically backfills a complete legacy identity before inventorying it', async () => {
    const row = completeRow({ botUserId: null, botId: null, teamId: null, appId: null });
    const validateIdentity = vi.fn(async () => IDENTITY);
    const persistIdentity = vi.fn(async () => true);
    const { startup, error } = composition({
      listConfigs: async () => [row],
      validateIdentity,
      persistIdentity,
    });

    await expect(startup.listConnections()).resolves.toEqual([
      { configId: row.id, appToken: APP_TOKEN, appId: APP_ID },
    ]);
    expect(validateIdentity).toHaveBeenCalledWith('xoxb-startup', APP_TOKEN);
    expect(persistIdentity).toHaveBeenCalledWith(row.id, IDENTITY);
    expect(error).not.toHaveBeenCalled();
  });

  test('propagates persisted botId from the verified route into the inbound processor', async () => {
    const row = completeRow();
    const { startup, processEvent } = composition({ findRoute: async () => row });
    const route = await startup.resolveTeam(IDENTITY.teamId, APP_ID);
    expect(route).toMatchObject({ botId: IDENTITY.botId, botUserId: IDENTITY.botUserId });

    await startup.processEvent(route!, { event: { type: 'message' } });

    expect(processEvent).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({ botId: IDENTITY.botId, botUserId: IDENTITY.botUserId }),
      expect.any(Object),
    );
  });

  test('skips an invalid complete-row app token with safe stage and config telemetry', async () => {
    const row = completeRow();
    const { startup, error } = composition({
      listConfigs: async () => [row],
      getAppToken: async () => 'xapp-invalid-secret',
    });

    await expect(startup.listConnections()).resolves.toEqual([]);
    expect(error).toHaveBeenCalledWith(
      'Slack Socket Mode startup skipped',
      expect.objectContaining({
        configId: row.id,
        stage: 'app_identity',
        error: 'invalid_app_token_shape',
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('xapp-invalid-secret');
  });

  test('skips a complete row when its stored app id disagrees with the encrypted token', async () => {
    const row = completeRow({ appId: 'AOTHER' });
    const { startup, error } = composition({ listConfigs: async () => [row] });

    await expect(startup.listConnections()).resolves.toEqual([]);
    expect(error).toHaveBeenCalledWith(
      'Slack Socket Mode startup skipped',
      expect.objectContaining({
        configId: row.id,
        stage: 'app_identity',
        error: 'stored_app_id_mismatch',
      }),
    );
  });

  test('skips rows missing either encrypted token without attempting validation', async () => {
    const missingApp = completeRow({ id: 'cfg-no-app', tenantId: 'tenant-no-app' });
    const missingBot = completeRow({ id: 'cfg-no-bot', tenantId: 'tenant-no-bot' });
    const validateIdentity = vi.fn(async () => IDENTITY);
    const { startup, error } = composition({
      listConfigs: async () => [missingApp, missingBot],
      getAppToken: async (tenantId: string) =>
        tenantId === missingApp.tenantId ? null : APP_TOKEN,
      getBotToken: async () => null,
      validateIdentity,
    });

    await expect(startup.listConnections()).resolves.toEqual([]);
    expect(validateIdentity).not.toHaveBeenCalled();
    expect(error.mock.calls.map(([, fields]) => fields.error)).toEqual([
      'missing_app_token',
      'missing_bot_token',
    ]);
  });

  test('isolates a bad legacy row and inventories a healthy row without logging tokens or raw errors', async () => {
    const bad = completeRow({ id: 'cfg-bad', tenantId: 'tenant-bad', botId: null });
    const healthy = completeRow({ id: 'cfg-good', tenantId: 'tenant-good' });
    const rawSecret = 'xoxb-do-not-log';
    const { startup, error } = composition({
      listConfigs: async () => [bad, healthy],
      getBotToken: async () => rawSecret,
      persistIdentity: async () => {
        throw Object.assign(new Error(`query failed for ${rawSecret}`), { code: '23505' });
      },
    });

    await expect(startup.listConnections()).resolves.toEqual([
      { configId: healthy.id, appToken: APP_TOKEN, appId: APP_ID },
    ]);
    expect(error).toHaveBeenCalledWith(
      'Slack Socket Mode startup skipped',
      expect.objectContaining({
        configId: bad.id,
        stage: 'identity_backfill',
        error: 'configuration_load_failed',
        errorType: 'Error',
        errorCode: '23505',
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(error.mock.calls)).not.toContain('query failed');
  });

  test('uses the shared validation stage for a rejected legacy app token', async () => {
    const row = completeRow({ appId: null });
    const { startup, error } = composition({
      listConfigs: async () => [row],
      validateIdentity: async () => {
        throw new SlackConnectionError('app_token_shape', 'invalid_app_token');
      },
    });

    await expect(startup.listConnections()).resolves.toEqual([]);
    expect(error).toHaveBeenCalledWith(
      'Slack Socket Mode startup skipped',
      expect.objectContaining({
        configId: row.id,
        stage: 'app_token_shape',
        error: 'invalid_app_token',
      }),
    );
  });
});
