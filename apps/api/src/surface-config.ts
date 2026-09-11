import {
  deleteSurfaceConfig,
  disableInboundChannels,
  disconnectSurfaceConfig,
  getSurfaceConfig,
  getSurfaceInboundHealth,
  listSubscribedChannels,
  listSurfaceConfigs,
  subscribeChannel,
  surfaceAppTokenKey,
  surfaceBotTokenKey,
  surfaceSigningSecretKey,
  upsertSurfaceConfig,
  type Db,
  type SecretStore,
} from '@sre/db';
import { type FetchLike } from '@sre/surfaces';
import { Hono } from 'hono';
import { authMiddleware, type AuthDeps, type TenantAuthVariables } from './auth';
import { type Logger } from './logger';
import type { ChannelsCache } from './slack-channels-cache';
import {
  SlackConnectionError,
  validateSlackConnection,
  type SlackConnectionIdentity,
} from './slack-connection';
import type { SlackSocketManager } from './surfaces/slack-socket';

export interface SurfaceRoutesDeps {
  auth: AuthDeps;
  db: Db;
  /** System connection for the non-RLS Socket Mode intake ledger. */
  adminDb?: Db;
  secrets: SecretStore;
  /** Injected for the Slack probes so they are unit-testable with a fake; defaults to global fetch. */
  fetch?: FetchLike;
  /** Per-tenant available-channels cache. Optional: without it the route still works, it just
   *  reads Slack on every request. */
  channels?: ChannelsCache;
  slackSockets?: Pick<SlackSocketManager, 'replace' | 'stop' | 'status'>;
  /** Structured application logger. Optional only for isolated route tests. */
  log?: Logger;
}

// Slack is the only surface. One config row per surface, and the row's EXISTENCE is the
// connection: nothing to enable, and no channel to post to — the AI answers in the alert's own
// thread. What we listen to is the per-channel inbound subscription. Bot and app tokens
// live in tenant_secrets via the SecretStore, never on the row and never returned. Any authed tenant
// member may configure (setup action, no admin gate, matching connectorRoutes). All DB access goes
// through the repo fns, which wrap withTenant (RLS).
import {
  CHANNELS_CACHE_TTL_SEC,
  SLACK,
  SLACK_CHANNEL_ID,
  SlackApiError,
  logConnectionFailure,
  slackAvailableChannels,
  slackScopeWarning,
  type AvailableChannelsResult,
} from './surface-config/slack';

export type { AvailableChannel, AvailableChannelsResult } from './surface-config/slack';

export function surfaceRoutes(deps: SurfaceRoutesDeps): Hono<{ Variables: TenantAuthVariables }> {
  const r = new Hono<{ Variables: TenantAuthVariables }>();
  r.use('*', authMiddleware(deps.auth));

  const fetchImpl: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const configMutations = new Map<string, Promise<void>>();
  const serializeSlackMutation = <T>(tenantId: string, operation: () => Promise<T>): Promise<T> => {
    const key = `${tenantId}:${SLACK}`;
    const previous = configMutations.get(key) ?? Promise.resolve();
    const run = previous.then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    configMutations.set(key, settled);
    void settled.then(() => {
      if (configMutations.get(key) === settled) configMutations.delete(key);
    });
    return run;
  };

  r.get('/', async (c) => {
    const { tenantId } = c.get('tenant');
    const rows = await listSurfaceConfigs(deps.db, tenantId);
    const surfaces = await Promise.all(
      rows.map(async (row) => {
        const inbound = deps.adminDb
          ? await getSurfaceInboundHealth(deps.adminDb, tenantId, row.surface, row.id)
          : null;
        return {
          id: row.id,
          surface: row.surface,
          botUserId: row.botUserId,
          hasAppToken: await deps.secrets.has(tenantId, surfaceAppTokenKey(row.surface)),
          hasBotToken: await deps.secrets.has(tenantId, surfaceBotTokenKey(row.surface)),
          runtime: {
            socket: deps.slackSockets?.status(row.id) ?? null,
            inbound,
          },
        };
      }),
    );
    return c.json({ surfaces });
  });

  r.put('/:surface', async (c) => {
    const { tenantId } = c.get('tenant');
    const surface = c.req.param('surface');
    if (surface !== SLACK) return c.json({ error: 'unknown surface' }, 400);
    let body: { appToken?: string; botToken?: string };
    try {
      body = await c.req.json();
    } catch {
      logConnectionFailure(deps, {
        tenantId,
        stage: 'request_body',
        status: 400,
        error: 'invalid_json',
      });
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    return serializeSlackMutation(tenantId, async () => {
      const existing = await getSurfaceConfig(deps.db, tenantId, SLACK);
      const enteredBotToken = body.botToken?.trim() || undefined;
      const enteredAppToken = body.appToken?.trim() || undefined;
      const storedBotToken = await deps.secrets.get(tenantId, surfaceBotTokenKey(SLACK));
      const storedAppToken = await deps.secrets.get(tenantId, surfaceAppTokenKey(SLACK));
      const botToken = enteredBotToken ?? storedBotToken ?? undefined;
      const appToken = enteredAppToken ?? storedAppToken ?? undefined;
      if (!botToken || !appToken) {
        logConnectionFailure(deps, {
          tenantId,
          stage: 'credentials',
          status: 400,
          error: 'missing_token',
        });
        return c.json({ error: 'botToken and appToken are required for Slack Socket Mode' }, 400);
      }
      if (existing && !enteredBotToken && !enteredAppToken) {
        deps.log?.info('Slack surface connection unchanged', {
          tenantId,
          surface: SLACK,
          configId: existing.id,
          teamId: existing.teamId,
        });
        return c.json({
          ok: true,
          botUserId: existing.botUserId,
          team: existing.teamId,
        });
      }

      let identity: SlackConnectionIdentity;
      try {
        identity = await validateSlackConnection(fetchImpl, botToken, appToken);
      } catch (error) {
        logConnectionFailure(deps, {
          tenantId,
          stage: error instanceof SlackConnectionError ? error.stage : 'slack_validation',
          status: 400,
          error: error instanceof SlackConnectionError ? error.message : 'slack_validation_failed',
          cause: error,
        });
        return c.json(
          {
            ok: false,
            error:
              error instanceof SlackConnectionError ? error.message : 'Slack validation failed',
          },
          400,
        );
      }

      let row;
      let failureStage = 'config_persist';
      try {
        row = await upsertSurfaceConfig(deps.db, tenantId, {
          surface: SLACK,
          botUserId: identity.botUserId,
          botId: identity.botId,
          teamId: identity.teamId,
          appId: identity.appId,
        });
        failureStage = 'bot_secret';
        if (enteredBotToken || !existing) {
          await deps.secrets.put(tenantId, surfaceBotTokenKey(SLACK), botToken);
        }
        failureStage = 'app_secret';
        if (enteredAppToken || !existing) {
          await deps.secrets.put(tenantId, surfaceAppTokenKey(SLACK), appToken);
        }
        failureStage = 'socket_start';
        if (enteredAppToken || !existing) {
          await deps.slackSockets?.replace(row.id, appToken, identity.appId);
        }
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : cause && typeof cause === 'object' && 'code' in cause
              ? cause.code
              : undefined;
        if (code === '23505') {
          logConnectionFailure(deps, {
            tenantId,
            stage: 'workspace_claim',
            status: 409,
            error: 'workspace_already_connected',
            teamId: identity.teamId,
          });
          return c.json({ error: 'Slack workspace is already connected to another tenant' }, 409);
        }

        try {
          if (existing) {
            await upsertSurfaceConfig(deps.db, tenantId, {
              surface: SLACK,
              botUserId: existing.botUserId,
              botId: existing.botId,
              teamId: existing.teamId,
              appId: existing.appId,
            });
            if (storedBotToken === null)
              await deps.secrets.delete(tenantId, surfaceBotTokenKey(SLACK));
            else await deps.secrets.put(tenantId, surfaceBotTokenKey(SLACK), storedBotToken);
            if (storedAppToken === null)
              await deps.secrets.delete(tenantId, surfaceAppTokenKey(SLACK));
            else await deps.secrets.put(tenantId, surfaceAppTokenKey(SLACK), storedAppToken);
          } else {
            if (row) await deps.slackSockets?.stop(row.id);
            await deps.secrets.delete(tenantId, surfaceBotTokenKey(SLACK));
            await deps.secrets.delete(tenantId, surfaceAppTokenKey(SLACK));
            await deleteSurfaceConfig(deps.db, tenantId, SLACK);
          }
        } catch (cleanupError) {
          logConnectionFailure(deps, {
            tenantId,
            stage: 'rollback_cleanup',
            status: 500,
            error: 'rollback_cleanup_failed',
            cause: cleanupError,
            teamId: identity.teamId,
            configId: row?.id ?? existing?.id,
          });
        }

        const socketFailure = failureStage === 'socket_start';
        logConnectionFailure(deps, {
          tenantId,
          stage: failureStage,
          status: socketFailure ? 400 : 500,
          error: socketFailure ? 'socket_start_failed' : 'persistence_failed',
          cause: error,
          teamId: identity.teamId,
          configId: row?.id ?? existing?.id,
        });
        return c.json(
          {
            error: socketFailure
              ? 'Slack rejected the Socket Mode app token'
              : 'Slack connection could not be saved',
          },
          socketFailure ? 400 : 500,
        );
      }
      const warning = await slackScopeWarning(fetchImpl, botToken, identity.botUserId);
      deps.log?.info('Slack surface connected', {
        tenantId,
        surface: SLACK,
        configId: row.id,
        teamId: identity.teamId,
        appId: identity.appId,
        botUserId: identity.botUserId,
        appTokenChanged: Boolean(enteredAppToken || !existing),
        botTokenChanged: Boolean(enteredBotToken || !existing),
        attributionScopeWarning: warning !== undefined,
      });
      return c.json({
        ok: true,
        botUserId: identity.botUserId,
        team: identity.teamId,
        warning,
      });
    });
  });

  r.post('/slack/test', async (c) => {
    const { tenantId } = c.get('tenant');
    return serializeSlackMutation(tenantId, async () => {
      const botToken = await deps.secrets.get(tenantId, surfaceBotTokenKey(SLACK));
      const appToken = await deps.secrets.get(tenantId, surfaceAppTokenKey(SLACK));
      if (botToken === null || appToken === null) {
        return c.json({ error: 'stored bot and app tokens are required' }, 400);
      }

      let identity: SlackConnectionIdentity;
      try {
        identity = await validateSlackConnection(fetchImpl, botToken, appToken);
      } catch (error) {
        // A network/transport failure is a caller-fixable condition (bad token host, offline), not a
        // server bug — report 4xx, never 500.
        return c.json(
          {
            ok: false,
            error:
              error instanceof SlackConnectionError ? error.message : 'Slack validation failed',
          },
          400,
        );
      }

      // Persist only the non-secret identities after both credentials and their shared app are verified.
      const existing = await getSurfaceConfig(deps.db, tenantId, SLACK);
      if (existing) {
        await upsertSurfaceConfig(deps.db, tenantId, {
          surface: SLACK,
          botUserId: identity.botUserId,
          botId: identity.botId,
          teamId: identity.teamId,
          appId: identity.appId,
        });
      }
      // Advisory only, so it rides on the 200 and never turns the connect into a 4xx: the token is
      // valid and the connection works, and a tenant that does not want attribution is a valid
      // configuration. `warning` is undefined unless a gap was PROVEN, and JSON.stringify drops the key —
      // absence must never be read as "scopes OK", because this probe cannot see users:read.email.
      const warning = await slackScopeWarning(fetchImpl, botToken, identity.botUserId);
      return c.json({
        ok: true,
        botUserId: identity.botUserId,
        team: identity.teamId,
        warning,
      });
    });
  });

  // Disconnect: the row IS the connection, so removing it removes the surface, and the secrets go with
  // it — a disconnected tenant must not leave a decryptable bot token behind.
  r.delete('/slack', async (c) => {
    const { tenantId } = c.get('tenant');
    return serializeSlackMutation(tenantId, async () => {
      // Disarm the inbound gate FIRST. A subscribed channel is the only thing that admits a message, so
      // leaving the rows enabled would re-arm every previously subscribed channel the instant the operator
      // reconnects the same workspace — no action, no hint. Soft (enabled=false): the row is our only
      // channel_id -> name mapping, and history would otherwise render a bare "C07…". Before the config
      // row goes, so a partial failure leaves the connection visible and the disconnect retryable.
      await disableInboundChannels(deps.db, tenantId, SLACK);
      const existing = await getSurfaceConfig(deps.db, tenantId, SLACK);
      if (existing) await deps.slackSockets?.stop(existing.id);
      // Then the secrets, and only THEN the config row. The steps above are idempotent, so a mid-way failure
      // leaves the connection visible and the whole DELETE re-runnable. Deleting the config row first would
      // leave a tenant that the UI shows as disconnected still holding a decryptable bot token in
      // tenant_secrets if either delete threw — the exact state this route exists to prevent.
      await deps.secrets.delete(tenantId, surfaceSigningSecretKey(SLACK));
      await deps.secrets.delete(tenantId, surfaceBotTokenKey(SLACK));
      await deps.secrets.delete(tenantId, surfaceAppTokenKey(SLACK));
      // The cached channel list is keyed on the deleted token, so it is already unreachable: the
      // route reads the token first and 400s without one. The orphaned entry expires on its own TTL.
      await disconnectSurfaceConfig(deps.db, tenantId, SLACK);
      return c.json({ ok: true });
    });
  });

  // The channels the operator can choose. Read from Slack, never from our DB: we can only
  // listen to a channel the bot can actually see, and the ID is what inbound events carry. Cached per
  // tenant for a few minutes — the call is rate-limited and walks up to 50 pages.
  r.get('/slack/available-channels', async (c) => {
    const { tenantId } = c.get('tenant');
    const token = await deps.secrets.get(tenantId, surfaceBotTokenKey(SLACK));
    if (token === null) return c.json({ error: 'no bot token stored' }, 400);

    // null is the MISS. A cached empty list is a HIT: a bot invited nowhere legitimately sees nothing,
    // and re-reading Slack for it on every poll is exactly the traffic this cache exists to remove.
    // A cache fault is a MISS, never a 500: the cache is an optimisation and must not be able to fail the
    // request it exists to speed up. Belt and braces with makeChannelsCache's own guards, so an injected
    // cache cannot break the route either.
    const cached = await deps.channels?.get(tenantId, token).catch(() => null);
    if (cached) return c.json(cached);

    let result: AvailableChannelsResult;
    try {
      result = await slackAvailableChannels(fetchImpl, token);
    } catch (err) {
      // A missing scope (or any Slack refusal) is operator-fixable app config, not a server bug: 400
      // with the reason — never a 500, and never an empty list that would read as "no channels".
      const message = err instanceof SlackApiError ? err.message : 'channel list request failed';
      return c.json({ error: message }, 400);
    }
    // Only a SUCCESS is cached, and a failed WRITE must not discard the read the operator already waited
    // for: caching happens OUTSIDE the Slack try, so a Valkey fault can never be reported as a Slack one.
    await deps.channels?.set(tenantId, token, result, CHANNELS_CACHE_TTL_SEC).catch(() => {});
    return c.json(result);
  });

  // The channels we currently listen to. `channel` is the Slack ID (what events carry); `name` is
  // display only.
  r.get('/slack/channels', async (c) => {
    const { tenantId } = c.get('tenant');
    const rows = await listSubscribedChannels(deps.db, tenantId, SLACK);
    return c.json({
      channels: rows.map((row) => ({
        channel: row.channel,
        name: row.channelName,
        enabled: row.enabled,
      })),
    });
  });

  r.put('/slack/channels/:channel', async (c) => {
    const { tenantId } = c.get('tenant');
    const channel = c.req.param('channel');
    // Reject anything that is not a Slack conversation id. Inbound events only ever carry IDs, so a row
    // holding a "#name" matches nothing and silently drops every message in that channel.
    if (!SLACK_CHANNEL_ID.test(channel)) {
      return c.json(
        {
          error:
            'channel must be a Slack channel ID (e.g. C07EWAS8132), not a name — pick it from the Inbound page',
        },
        400,
      );
    }
    let body: { enabled?: boolean; name?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    await subscribeChannel(deps.db, {
      tenantId,
      surface: SLACK,
      channel,
      // Refreshed whenever the picker supplies it, so a Slack rename self-heals; omitted → name kept.
      channelName: body.name,
      enabled: body.enabled ?? true,
    });
    return c.json({ ok: true });
  });

  return r;
}
