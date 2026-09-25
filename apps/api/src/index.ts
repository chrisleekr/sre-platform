import { Hono } from 'hono';
import { resolveTxt } from 'node:dns/promises';
import { getConnInfo, websocket } from 'hono/bun';
import { allowLocalAutoLogin } from './local-development-auth';
import { Redis } from 'ioredis';
import {
  makeDb,
  makeSecretStore,
  makePlatformSecretStore,
  assertRuntimeRoleScoped,
  backfillSlackSurfaceIdentitySystem,
  getSurfaceConfigByTeamAndAppId,
  listSlackSurfaceConfigsSystem,
  shouldEnforceRuntimeRole,
  surfaceAppTokenKey,
  surfaceBotTokenKey,
} from '@sre/db';
import {
  makeSlackFileFetcher,
  slackChatGetPermalink,
  slackChatPostAlertRoot,
  slackUsersInfoEmail,
  SlackApiError,
  type FileFetchLike,
  type FetchLike,
} from '@sre/surfaces';
import {
  Queue,
  makeSnapshotCache,
  makeClassifyQueue,
  makeRunbookQueue,
  makeFoundingQueue,
} from '@sre/queue';
import { ConversationHub } from '@sre/hub';
import { llmRuntimeFingerprint, PlatformSettings } from '@sre/platform-settings';
import { defaultRegistry, developmentRegistryOptions } from '@sre/connectors';
import { loadConfig } from './config';
import { onStuck } from './stuck-recycler';
import { armLocalLogin, LOCAL_AUDIENCE } from './local-auth';
import { makeRevokePublisher, SessionRegistry } from './auth/revoke';
import { makeApp, type AppDeps } from './app';
import { makeChannelsCache } from './slack-channels-cache';
import { MAX_FRAME_BYTES } from './surfaces/ws-ingest';
import {
  handleSlackEvent,
  handleSlackInteraction,
  type SlackEnvelope,
  type SlackInboundDeps,
  type SlackInteraction,
} from './surfaces/slack-inbound';
import { makeSlackSocketManager } from './surfaces/slack-socket';
import { makeSlackInboundPipeline, startSlackInboundWorker } from './surfaces/slack-intake';
import { validateSlackConnection } from './slack-connection';
import { makeSlackStartupComposition } from './slack-startup';
import { wsRoutes } from './surfaces/ws';
import { ticketRoutes, TicketStore } from './surfaces/ticket';
import { makeLogger, safeErrorMetadata } from './logger';
import { makeGitHubSmeeManager } from './github-smee';
import { makeGitLabSmeeManager } from './gitlab-smee';
import { makeAlertmanagerSmeeManager } from './alertmanager-smee';
import { restoreAlertmanagerSmeeRelays, restoreSmeeRelays } from './smee-restore';
import {
  makeFoundingDispatchHandler,
  makeFoundingJobHandler,
  makeTenantPurgeJobHandler,
  startFoundingWorker,
} from './onboarding/founding-worker';
import { forwardedSourceAddress, makePublicRateLimiter } from './onboarding/rate-limit';
import { makeDomainVerificationJobHandler } from './onboarding/domain-worker';
import {
  makeDomainLifecycleCheck,
  makeFoundingDomainLifecycleCheck,
} from './onboarding/domain-notifications';
import { makeNotificationRuntime } from './notification-runtime';
import { makeIdentityRuntime } from './identity-runtime';

const config = loadConfig();
const localOrigin = config.localDevelopmentLoginOrigin;
const log = makeLogger({ app: 'api' });
const appDb = makeDb(config.appUrl);
// A superuser connection would bypass tenant RLS.
const enforceRuntimeRole = shouldEnforceRuntimeRole(process.env);
if (!enforceRuntimeRole)
  log.error('RLS runtime-role enforcement DISABLED via ALLOW_SUPERUSER_APP_DB (dev only)');
await assertRuntimeRoleScoped(appDb, { enforce: enforceRuntimeRole });
const adminDb = makeDb(config.adminUrl);
const redis = new Redis(config.valkeyUrl, { maxRetriesPerRequest: null });
const settingsRedis = new Redis(config.valkeyUrl, {
  maxRetriesPerRequest: 1,
  commandTimeout: 2_000,
  autoResendUnfulfilledCommands: false,
  enableOfflineQueue: false,
});
const publicRateLimiter = makePublicRateLimiter(settingsRedis);
const publicSourceAddress: NonNullable<AppDeps['publicSourceAddress']> = (c) =>
  forwardedSourceAddress(
    getConnInfo(c).remote.address,
    c.req.header('x-forwarded-for'),
    config.trustedProxyHops,
  );
const settings = new PlatformSettings(adminDb.db, settingsRedis, {
  env: process.env,
  onCacheError: (error) =>
    log.error('platform settings cache degraded', {
      error: error instanceof Error ? error.message : String(error),
    }),
});
void settings.start();
const secrets = makeSecretStore(appDb.db, config.masterKey);
const platformSecrets = makePlatformSecretStore(adminDb.db, config.masterKey);
const notifier = makeNotificationRuntime({
  db: appDb.db,
  appUrl: config.dashboardBaseUrl,
  log,
  settings,
  secrets: platformSecrets,
});
const githubSmee =
  process.env.NODE_ENV === 'production'
    ? undefined
    : makeGitHubSmeeManager({ port: config.port, log });
const gitlabSmee =
  process.env.NODE_ENV === 'production'
    ? undefined
    : makeGitLabSmeeManager({ port: config.port, log });
const alertmanagerSmee =
  process.env.NODE_ENV === 'production'
    ? undefined
    : makeAlertmanagerSmeeManager({ port: config.port, log });
const queue = new Queue(adminDb.db, redis, { dispatchRedis: settingsRedis });
const lifecyclePollQueue = new Queue(adminDb.db, redis, {
  stream: 'sre:jobs:poll',
  group: 'poll',
  dispatchRedis: settingsRedis,
});
// Classification and runbook jobs use dedicated streams.
const classifyQueue = makeClassifyQueue(adminDb.db, redis, { dispatchRedis: settingsRedis });
const runbookQueue = makeRunbookQueue(adminDb.db, redis, { dispatchRedis: settingsRedis });
const consumerQueueOptions = { dispatchRedis: settingsRedis, onStuck };
const foundingQueue = makeFoundingQueue(adminDb.db, redis, consumerQueueOptions);
const slackInboundQueue = new Queue(adminDb.db, redis, {
  stream: 'sre:slack-inbound',
  group: 'slack-inbound-workers',
  deadStream: 'sre:slack-inbound:dead',
  ...consumerQueueOptions,
});
const cache = makeSnapshotCache(redis);
const registry = defaultRegistry(developmentRegistryOptions(process.env));
const hub = new ConversationHub(appDb.db, redis, settingsRedis);
const tickets = new TicketStore(redis, 30, config.masterKey);
// The boot-time gate keeps local signing keys out of production.
const localLogin = config.localLogin
  ? await armLocalLogin(config.localLogin, {
      audience: LOCAL_AUDIENCE,
      log: (message) => log.error(message),
    })
  : undefined;
const sessionRegistry = new SessionRegistry();
await sessionRegistry.start(redis.duplicate({ maxRetriesPerRequest: null }));
const revoke = makeRevokePublisher(redis);
const { auth, oidc, browserSessions } = makeIdentityRuntime({
  appDb: appDb.db,
  adminDb: adminDb.db,
  revoke,
  local: localLogin,
  secrets: platformSecrets,
  settings,
  dashboardUrl: config.dashboardBaseUrl,
  production: !['development', 'dev', 'test'].includes(process.env.NODE_ENV ?? ''),
});
// Slack file proxy for the incident attachment routes: resolves the tenant's
// bot token at point of use (never persisted), host-pins to Slack, and caps the size.
const slackFileFetcher = makeSlackFileFetcher({
  fetch: globalThis.fetch as unknown as FileFetchLike,
  getToken: (tenantId) => secrets.get(tenantId, surfaceBotTokenKey('slack')),
});
const slackInboundDeps: SlackInboundDeps = {
  adminDb: adminDb.db,
  appDb: appDb.db,
  hub,
  queue,
  classifyQueue,
  redis,
  reservationRedis: settingsRedis,
  usersInfoEmail: async (tenantId, surfaceUserId) => {
    const token = await secrets.get(tenantId, surfaceBotTokenKey('slack'));
    if (!token) return null;
    return slackUsersInfoEmail(globalThis.fetch as unknown as FetchLike, token, surfaceUserId);
  },
  onError: (err, ctx) =>
    log.error('surface inbound post-commit operation failed', {
      surface: 'slack',
      configId: ctx.configId,
      incidentId: ctx.incidentId,
      error: err instanceof Error ? err.message : String(err),
    }),
};

const slackInbound = makeSlackInboundPipeline({
  db: adminDb.db,
  queue: slackInboundQueue,
  processEvent: (route, body, context) =>
    handleSlackEvent(
      slackInboundDeps,
      route.configId,
      {
        tenantId: route.tenantId,
        surface: 'slack',
        botUserId: route.botUserId ?? '',
        botId: route.botId,
      },
      body as SlackEnvelope,
      context,
    ),
  processInteraction: (route, body) =>
    handleSlackInteraction(
      slackInboundDeps,
      route.configId,
      {
        tenantId: route.tenantId,
        surface: 'slack',
        botUserId: route.botUserId ?? '',
        botId: route.botId,
      },
      body as SlackInteraction,
    ),
  onError: (error, context) =>
    log.error('Slack inbound queue degraded', {
      ...context,
      ...safeErrorMetadata(error),
    }),
});
const slackInboundWorker = await startSlackInboundWorker(slackInboundQueue, slackInbound.handler, {
  onError: (error) =>
    log.error('Slack inbound worker degraded', {
      ...safeErrorMetadata(error),
    }),
});
const provisionFoundingJob = makeFoundingJobHandler(adminDb.db);
const checkDomainLifecycle = makeDomainLifecycleCheck(adminDb.db, notifier, resolveTxt);
const verifyDomainJob = makeDomainVerificationJobHandler({ check: checkDomainLifecycle });
const purgeTenantJob = makeTenantPurgeJobHandler(adminDb.db);
const foundingWorker = await startFoundingWorker(
  foundingQueue,
  makeFoundingDispatchHandler(provisionFoundingJob, verifyDomainJob, purgeTenantJob),
  {
    db: adminDb.db,
    onError: (error) =>
      log.error('workspace founding worker degraded', {
        ...safeErrorMetadata(error),
      }),
  },
);

const slackComposition = makeSlackStartupComposition({
  listConfigs: () => listSlackSurfaceConfigsSystem(adminDb.db),
  getBotToken: (tenantId) => secrets.get(tenantId, surfaceBotTokenKey('slack')),
  getAppToken: (tenantId) => secrets.get(tenantId, surfaceAppTokenKey('slack')),
  validateIdentity: (botToken, appToken) =>
    validateSlackConnection(globalThis.fetch as unknown as FetchLike, botToken, appToken),
  persistIdentity: (configId, identity) =>
    backfillSlackSurfaceIdentitySystem(adminDb.db, configId, identity),
  findRoute: (teamId, appId) => getSurfaceConfigByTeamAndAppId(adminDb.db, teamId, appId),
  processEvent: (configId, slackConfig, body) =>
    slackInbound.acceptEvent({ configId, appId: '', ...slackConfig }, body),
  processInteraction: (configId, slackConfig, body) =>
    slackInbound.acceptInteraction({ configId, appId: '', ...slackConfig }, body),
  log,
});

const slackSockets = makeSlackSocketManager({
  ...slackComposition,
  recordDrop: slackInbound.recordDrop,
  onEvent: (event) => log.info('Slack Socket Mode delivery', { ...event }),
  onError: (error) =>
    log.error('Slack Socket Mode delivery failed', {
      ...safeErrorMetadata(error),
    }),
});

const root = new Hono();
root.route(
  '/',
  makeApp({
    auth,
    readinessDb: appDb.db,
    appDb: appDb.db,
    secrets,
    registry,
    cache,
    runbookQueue,
    declarationQueue: queue,
    signalRoute: {
      appDb: appDb.db,
      redis,
      queue,
    },
    signalEvaluationQueue: classifyQueue,
    signalRuntimeFingerprint: async () =>
      llmRuntimeFingerprint((await settings.llmRuntime()).config),
    // the approval-decide route needs a system connection (by-PK approval lookup), the
    // hub, and the TRIAGE resume queue (`queue`, stream sre:jobs) — never the runbook queue above.
    adminDb: adminDb.db,
    hub,
    resumeQueue: queue,
    resolveSlackPermalink: async (tenantId, channel, threadId) => {
      const token = await secrets.get(tenantId, surfaceBotTokenKey('slack'));
      if (!token) return null;
      return slackChatGetPermalink(
        globalThis.fetch as unknown as FetchLike,
        token,
        channel,
        threadId,
      );
    },
    fetchAttachment: (tenantId, urlPrivate) => slackFileFetcher.fetch(tenantId, urlPrivate),
    corsOrigins: config.corsOrigins,
    // conversations.list is rate-limited and the dashboard asked for it on every mount.
    slackChannelsCache: makeChannelsCache(redis),
    slackSockets,
    githubSmee,
    gitlabSmee,
    alertmanagerSmee,
    alertmanager: {
      route: {
        appDb: appDb.db,
        redis,
        queue,
        appendOpenerTx: async (tx, tenantId, incidentId, opener, observed) => {
          const opened = await hub.appendTxOnce(tx, tenantId, incidentId, {
            ...opener,
            ...(observed
              ? {
                  kind: 'signal' as const,
                  signalId: observed.id,
                  signalState: observed.state,
                  signalEventType: observed.eventType,
                }
              : {}),
          });
          const lifecycle = await hub.appendTxOnce(tx, tenantId, incidentId, {
            author: 'system',
            kind: 'lifecycle',
            content: 'Incident open: alert accepted for investigation.',
            lifecycleFrom: null,
            lifecycleTo: 'open',
            lifecycleVersion: 0,
            transitionKey: `incident-open:${incidentId}:0`,
          });
          return {
            incidentId,
            afterCommit: async () => {
              await hub.publishAppended(opened.message);
              await hub.publishAppended(lifecycle.message);
            },
          };
        },
      },
      hub,
      dashboardBaseUrl: config.dashboardBaseUrl,
      enqueueLifecycle: (tenantId, payload) =>
        lifecyclePollQueue.enqueue({ tenantId, type: 'poll', payload }),
      postAlertRoot: async (tenantId, channel, text, intakeId) => {
        const token = await secrets.get(tenantId, surfaceBotTokenKey('slack'));
        if (!token)
          throw new SlackApiError(
            'rejected',
            'not_connected',
            'Slack is not connected; Alertmanager cannot create an incident thread',
          );
        const fetchImpl = globalThis.fetch as unknown as FetchLike;
        return slackChatPostAlertRoot(fetchImpl, token, channel, text, intakeId);
      },
    },
    log,
    settings,
    platformSecrets,
    notifier,
    notificationAppUrl: config.dashboardBaseUrl,
    foundingQueue,
    publicRateLimiter,
    publicSourceAddress,
    oidc,
    browserSessions,
    backchannelLogout: auth.verifiers.byId
      ? {
          db: adminDb.db,
          resolveProvider: (providerId) => auth.verifiers.byId!(providerId),
          limiter: publicRateLimiter,
          sourceAddress: publicSourceAddress,
          revoke,
        }
      : undefined,
    scim: {
      db: adminDb.db,
      limiter: publicRateLimiter,
      sourceAddress: publicSourceAddress,
      revoke,
      log,
    },
    checkFoundingDomain: makeFoundingDomainLifecycleCheck(adminDb.db, notifier, resolveTxt),
    checkWorkspaceDomain: (domainId) => checkDomainLifecycle(domainId),
    registrationMode: () => settings.get('REGISTRATION_MODE'),
    publicSite: config.publicSite,
    localAuth: localLogin
      ? {
          local: localLogin,
          db: adminDb.db,
          invalidateProviderVerifiers: auth.verifiers.invalidate,
          maxTokenLifetimeSec: () => settings.get('MAX_TOKEN_LIFETIME_SEC'),
          allowAutomaticSession: localOrigin
            ? (c) => allowLocalAutoLogin(c, localOrigin, getConnInfo(c).remote.address)
            : undefined,
        }
      : undefined,
  }),
);
root.route('/ws', ticketRoutes({ auth, tickets }));
root.route('/ws', wsRoutes({ appDb: appDb.db, hub, tickets, queue, sessionRegistry }));

void slackSockets.startAll().catch((error) =>
  log.error('Slack Socket Mode startup failed', {
    stage: 'connection_inventory',
    ...safeErrorMetadata(error),
  }),
);

if (githubSmee) {
  setTimeout(() => {
    void restoreSmeeRelays({
      provider: 'github',
      db: adminDb.db,
      secrets,
      manager: githubSmee,
      legacySource: process.env.GITHUB_SMEE_URL,
      log,
    }).catch((error) =>
      log.error('GitHub Smee relay inventory failed', {
        operation: 'relay_restore',
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );
  }, 0);
}

if (gitlabSmee) {
  setTimeout(() => {
    void restoreSmeeRelays({
      provider: 'gitlab',
      db: adminDb.db,
      secrets,
      manager: gitlabSmee,
      legacySource: process.env.GITLAB_SMEE_URL,
      log,
    }).catch((error) =>
      log.error('GitLab Smee relay inventory failed', {
        operation: 'relay_restore',
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );
  }, 0);
}

if (alertmanagerSmee) {
  setTimeout(() => {
    void restoreAlertmanagerSmeeRelays({
      db: adminDb.db,
      secrets,
      manager: alertmanagerSmee,
      log,
    }).catch((error) =>
      log.error('Alertmanager Smee relay inventory failed', {
        operation: 'relay_restore',
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );
  }, 0);
}

const stopSockets = (): void => {
  void Promise.all([
    slackSockets.stopAll(),
    slackInboundWorker.stop(),
    foundingWorker.stop(),
    githubSmee?.stopAll(),
    gitlabSmee?.stopAll(),
    alertmanagerSmee?.stopAll(),
    sessionRegistry.close(),
  ]).finally(() => process.exit(0));
};
process.once('SIGTERM', stopSockets);
process.once('SIGINT', stopSockets);

log.info('api starting', { port: config.port });
export default {
  hostname: localOrigin ? '127.0.0.1' : undefined,
  port: config.port,
  fetch: root.fetch,
  websocket: { ...websocket, maxPayloadLength: MAX_FRAME_BYTES },
};
