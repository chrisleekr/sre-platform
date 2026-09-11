import { safeErrorMetadata, type Logger } from './logger';
import {
  SlackConnectionError,
  slackAppIdFromToken,
  type SlackConnectionIdentity,
} from './slack-connection';
import type { SlackConfig } from './surfaces/slack-inbound';
import type { SlackSocketManagerDeps, SlackTeamRoute } from './surfaces/slack-socket';

export interface SlackStartupConfig {
  id: string;
  tenantId: string;
  surface: string;
  botUserId: string | null;
  botId: string | null;
  teamId: string | null;
  appId: string | null;
}

export interface SlackStartupDeps {
  listConfigs(): Promise<SlackStartupConfig[]>;
  getBotToken(tenantId: string): Promise<string | null>;
  getAppToken(tenantId: string): Promise<string | null>;
  validateIdentity(botToken: string, appToken: string): Promise<SlackConnectionIdentity>;
  persistIdentity(configId: string, identity: SlackConnectionIdentity): Promise<boolean>;
  findRoute(teamId: string, appId: string): Promise<SlackStartupConfig | undefined>;
  processEvent(
    configId: string,
    config: SlackConfig,
    body: Record<string, unknown>,
  ): Promise<string | void>;
  processInteraction(
    configId: string,
    config: SlackConfig,
    body: Record<string, unknown>,
  ): Promise<string | void>;
  log: Pick<Logger, 'error'>;
}

type SlackStartupComposition = Pick<
  SlackSocketManagerDeps,
  'listConnections' | 'resolveTeam' | 'processEvent' | 'processInteraction'
>;

function hasCompleteIdentity(row: SlackStartupConfig): boolean {
  return Boolean(row.botUserId && row.botId && row.teamId && row.appId);
}

function processorConfig(route: SlackTeamRoute): SlackConfig {
  return {
    tenantId: route.tenantId,
    surface: 'slack',
    botUserId: route.botUserId ?? '',
    botId: route.botId,
  };
}

/** Compose startup inventory, verified routing, and transport-neutral inbound processors. */
export function makeSlackStartupComposition(deps: SlackStartupDeps): SlackStartupComposition {
  const skip = (configId: string, stage: string, error: string, cause?: unknown): void => {
    deps.log.error('Slack Socket Mode startup skipped', {
      configId,
      stage,
      error,
      ...(cause === undefined ? {} : safeErrorMetadata(cause)),
    });
  };

  return {
    listConnections: async () => {
      const connections: { configId: string; appToken: string; appId: string }[] = [];
      for (const row of await deps.listConfigs()) {
        let stage = 'credentials';
        try {
          const appToken = await deps.getAppToken(row.tenantId);
          if (!appToken) {
            skip(row.id, stage, 'missing_app_token');
            continue;
          }
          const botToken = await deps.getBotToken(row.tenantId);
          if (!botToken) {
            skip(row.id, stage, 'missing_bot_token');
            continue;
          }

          if (!hasCompleteIdentity(row)) {
            stage = 'identity_validation';
            const identity = await deps.validateIdentity(botToken, appToken);
            stage = 'identity_backfill';
            if (!(await deps.persistIdentity(row.id, identity))) {
              skip(row.id, stage, 'config_no_longer_incomplete');
              continue;
            }
            connections.push({ configId: row.id, appToken, appId: identity.appId });
            continue;
          }

          stage = 'app_identity';
          const tokenAppId = slackAppIdFromToken(appToken);
          if (!tokenAppId) {
            skip(row.id, stage, 'invalid_app_token_shape');
            continue;
          }
          if (row.appId !== tokenAppId) {
            skip(row.id, stage, 'stored_app_id_mismatch');
            continue;
          }
          connections.push({ configId: row.id, appToken, appId: tokenAppId });
        } catch (error) {
          skip(
            row.id,
            error instanceof SlackConnectionError ? error.stage : stage,
            error instanceof SlackConnectionError ? error.message : 'configuration_load_failed',
            error,
          );
        }
      }
      return connections;
    },

    resolveTeam: async (teamId, appId) => {
      const row = await deps.findRoute(teamId, appId);
      if (!row || row.surface !== 'slack' || !hasCompleteIdentity(row)) return undefined;
      return {
        configId: row.id,
        tenantId: row.tenantId,
        appId: row.appId!,
        botUserId: row.botUserId!,
        botId: row.botId!,
      };
    },

    processEvent: (route, body) => deps.processEvent(route.configId, processorConfig(route), body),
    processInteraction: (route, body) =>
      deps.processInteraction(route.configId, processorConfig(route), body),
  };
}
