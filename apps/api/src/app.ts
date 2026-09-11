import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { sql } from 'drizzle-orm';
import { setUserNotBefore, type Db, type PlatformSecretStore, type SecretStore } from '@sre/db';
import { assertSafeHttpsUrl, ConnectorRegistry } from '@sre/connectors';
import type { Queue, SnapshotCache } from '@sre/queue';
import type { ConversationHub } from '@sre/hub';
import { makeSlackDisplayResolver } from '@sre/surfaces';
import { surfaceBotTokenKey } from '@sre/db';
import {
  loadAutomaticInvestigationBudgetLimits,
  type PlatformSettings,
} from '@sre/platform-settings';
import { makeDbConnectorProvider } from '@sre/agent-tools';
import { requireUser, type AuthDeps, type AuthVariables } from './auth';
import { localAuthRoutes, type LocalAuthDeps } from './local-auth';
import { connectorRoutes } from './connectors';
import { surfaceRoutes } from './surface-config';
import type { ChannelsCache } from './slack-channels-cache';
import type { SlackSocketManager } from './surfaces/slack-socket';
import { incidentRoutes } from './incidents';
import { attachmentRoutes, type AttachmentFetcher } from './surfaces/attachments';
import { snapshotRoutes } from './snapshots';
import { changeRoutes } from './changes';
import { topologyRoutes } from './topology';
import { platformSettingsRoutes } from './platform-settings';
import type { Logger } from './logger';
import { githubWebhookRoutes } from './github-webhook';
import { gitLabWebhookRoutes } from './gitlab-webhook';
import { mcpRoutes } from './mcp';
import type { GitHubSmeeManager } from './github-smee';
import type { GitLabSmeeManager } from './gitlab-smee';
import type { AlertmanagerSmeeManager } from './alertmanager-smee';
import { alertmanagerWebhookRoutes, type AlertmanagerWebhookDeps } from './alertmanager-webhook';
import type { RouteDeps } from '@sre/alerts';
import { signalRoutes } from './signals';
import { reliabilityRoutes } from './reliability';
import { sloRoutes } from './slos';
import { incidentTagRoutes } from './incident-tags';
import { authDiscoveryRoutes } from './onboarding/auth-discover';
import type { FoundingQueuePort, PublicRateLimiter } from './onboarding/contracts';
import { foundingRoutes } from './onboarding/foundings';
import { meRoutes } from './onboarding/me';
import { memberRoutes } from './onboarding/members';
import { tenantSettingsRoutes } from './onboarding/tenant-settings';
import { browserSessionRoutes } from './onboarding/browser-session-routes';
import type { makeBrowserSessionRuntime } from './onboarding/browser-session-runtime';
import type { RegistrationMode } from '@sre/db';
import { oidcRoutes } from './onboarding/oidc-routes';
import type { makeOidcRuntime } from './onboarding/oidc-runtime';
import type { Notifier } from '@sre/notifications';
import { notificationRoutes } from './notifications';
import { adminRoutes } from './admin';
import { publicConfigRoutes } from './public-config';
import { backchannelLogoutRoutes, type BackchannelLogoutDeps } from './auth/backchannel-logout';
import { scimRoutes, type ScimRoutesDeps } from './scim/routes';

export interface AppDeps {
  auth: AuthDeps;
  /** connection used for the /readyz database ping. */
  readinessDb: Db;
  /** app-role connection for tenant-scoped queries (subject to RLS). */
  appDb: Db;
  secrets: SecretStore;
  /**
   * Resolves connector implementations for the test-connection route. Optional at the composition
   * root, like the queues and `fetchAttachment`: the production API always provides it (index.ts); suites
   * exercising unrelated routes omit it and fall back to an empty registry (their routes never reach
   * `/:type/test`, so an unregistered type there is never exercised).
   */
  registry?: ConnectorRegistry;
  /** Valkey-backed connector snapshot cache read by the infra/deployments panels. */
  cache: SnapshotCache;
  /** Dedicated runbook-generation queue for the generate-runbook command. */
  runbookQueue?: Queue;
  /** Triage-stream queue used when a dashboard observation declares an incident. */
  declarationQueue?: Queue;
  /** Shared incident funnel used by explicit signal-ticket promotion. */
  signalRoute?: RouteDeps;
  /** Classify-stream producer used for metered signal-disposition corpus evaluations. */
  signalEvaluationQueue?: Pick<Queue, 'insertJobTx' | 'publishJob'>;
  /** Secret-free identity of the currently selected classifier runtime. */
  signalRuntimeFingerprint?: () => Promise<string>;
  /**
   * The approval-decide route collaborators, forwarded to incidentRoutes: a system
   * (RLS-bypassing) connection for the by-PK approval lookup, the conversation hub, and a resume-capable
   * queue on the triage stream (not `runbookQueue`). Optional at the composition root; suites that
   * do not exercise the decide route omit them and the route returns 503.
   */
  adminDb?: Db;
  hub?: ConversationHub;
  resumeQueue?: Queue;
  /** Slack Web API permalink resolver for incident-thread deep links. */
  resolveSlackPermalink?: (
    tenantId: string,
    channel: string,
    threadId: string,
  ) => Promise<string | null>;
  /**
   * Proxy fetch for the incident attachment routes: host-pinned + size-capped
   * Slack file fetcher. Optional at the composition root — the production API wires it; suites that do
   * not exercise attachment downloads omit it and the download route returns 503.
   */
  fetchAttachment?: AttachmentFetcher;
  /**
   * Browser origins allowed to call the API cross-origin (the dashboard dev server runs on a
   * different port). Omitted by same-origin test suites, which call the app directly. When set,
   * CORS is registered first so preflight OPTIONS are answered before per-router auth (a preflight
   * carries no token and would otherwise 401).
   */
  corsOrigins?: string[];
  /**
   * Per-tenant Slack available-channels cache. Optional at the composition root: production wires
   * it from the ioredis client; suites that do not exercise the picker omit it and the route reads Slack
   * on every request (correct, just slower).
   */
  slackChannelsCache?: ChannelsCache;
  slackSockets?: Pick<SlackSocketManager, 'replace' | 'stop' | 'status'>;
  /** Structured application logger. Optional only for isolated route tests. */
  log?: Logger;
  /** Local GitHub event relay lifecycle. Omitted in production and unrelated route tests. */
  githubSmee?: Pick<GitHubSmeeManager, 'replace' | 'stop'>;
  /** Local GitLab event relay lifecycle. Omitted in production and unrelated route tests. */
  gitlabSmee?: Pick<GitLabSmeeManager, 'replace' | 'stop'>;
  alertmanagerSmee?: Pick<AlertmanagerSmeeManager, 'replace' | 'stop'>;
  /** Direct Alertmanager intake runtime. Omitted only by route-isolated tests. */
  alertmanager?: Pick<
    AlertmanagerWebhookDeps,
    'route' | 'hub' | 'postAlertRoot' | 'dashboardBaseUrl'
  >;
  /** System-scoped store for the opt-in platform operator settings routes. */
  settings: Pick<PlatformSettings, 'list' | 'set'> &
    Partial<Pick<PlatformSettings, 'get' | 'llmRuntime' | 'smtp'>>;
  platformSecrets?: PlatformSecretStore;
  browserSessions?: ReturnType<typeof makeBrowserSessionRuntime>;
  /**
   * Armed dev-only password login. Absent — always, in production — means the sign-in route is
   * never registered, so it 404s and its tenant auto-provisioning is unreachable.
   */
  localAuth?: LocalAuthDeps;
  /** Durable queue used for workspace founding before a tenant id exists. */
  foundingQueue?: FoundingQueuePort;
  /** Replica-safe guard for public discovery and founding requests. */
  publicRateLimiter?: PublicRateLimiter;
  /** Reads the platform-wide workspace registration policy. */
  registrationMode?: () => Promise<RegistrationMode>;
  /** Resolves the public caller identity from transport metadata. */
  publicSourceAddress?: (c: Context) => string;
  /** Server-owned OIDC network and token-verification operations. */
  oidc?: ReturnType<typeof makeOidcRuntime>;
  /** Public provider-authenticated OIDC logout endpoint. */
  backchannelLogout?: BackchannelLogoutDeps;
  /** Public provider-authenticated SCIM 2.0 provisioning surface. */
  scim?: ScimRoutesDeps;
  /** Manual DNS proof check scoped to the authenticated founding owner. */
  checkFoundingDomain?: (
    foundingId: string,
    founderUserId: string,
  ) => Promise<{ status: 'pending' | 'verified' | 'expired' | 'conflict' } | null>;
  /** Manual DNS proof check scoped by the workspace settings route. */
  checkWorkspaceDomain?: (
    domainId: string,
  ) => Promise<{ status: 'pending' | 'verified' | 'expired' | 'conflict' }>;
  /** Optional public links and consent version rendered by unauthenticated dashboard screens. */
  publicSite?: {
    supportUrl: string | null;
    termsUrl: string | null;
    termsVersion: string | null;
  };
  /** Durable organisation-lifecycle notifier and the public URL used in its inbox links. */
  notifier?: Notifier;
  notificationAppUrl?: string;
}

export function makeApp(deps: AppDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const log = deps.log;
  if (log) {
    app.use('*', async (c, next) => {
      const startedAt = performance.now();
      const request = { method: c.req.method, path: c.req.path };
      try {
        await next();
        const fields = {
          ...request,
          status: c.res.status,
          durationMs: Math.round(performance.now() - startedAt),
        };
        if (c.res.status >= 500) log.error('http request completed', fields);
        else log.info('http request completed', fields);
      } catch (error) {
        log.error('http request failed', {
          ...request,
          status: 500,
          durationMs: Math.round(performance.now() - startedAt),
          errorType: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      }
    });
  }

  if (deps.corsOrigins?.length) {
    app.use(
      '*',
      cors({
        origin: deps.corsOrigins,
        credentials: true,
        allowHeaders: [
          'authorization',
          'content-type',
          'x-impersonation-session',
          'x-onboarding-founding-id',
          'x-sre-session',
          'x-sre-session-id',
          'x-sre-local-development',
        ],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      }),
    );
  }

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  if (deps.backchannelLogout) app.route('/', backchannelLogoutRoutes(deps.backchannelLogout));
  if (deps.scim) app.route('/', scimRoutes(deps.scim));
  if (deps.browserSessions && deps.publicRateLimiter && deps.publicSourceAddress) {
    app.route(
      '/',
      browserSessionRoutes(
        deps.browserSessions,
        deps.publicRateLimiter,
        deps.publicSourceAddress,
        deps.log,
      ),
    );
  }

  app.get('/readyz', async (c) => {
    try {
      await deps.readinessDb.execute(sql`select 1`);
      return c.json({ status: 'ready' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });

  // Public: the login screen asks which sign-in paths exist. Derived from the SAME object that gates
  // the route below, so the dashboard cannot advertise a path the API does not serve.
  app.get('/auth/capabilities', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({
      localPasswordLogin: Boolean(deps.localAuth?.local.passwordEnabled),
      localDevelopmentLogin: Boolean(deps.localAuth?.allowAutomaticSession),
    });
  });

  app.route(
    '/',
    publicConfigRoutes({
      db: deps.appDb,
      settings: deps.settings,
      registrationMode: deps.registrationMode,
      publicSite: deps.publicSite,
      log: deps.log,
    }),
  );

  if (deps.localAuth) app.route('/auth/local', localAuthRoutes(deps.localAuth));
  if (deps.oidc) {
    app.route(
      '/',
      oidcRoutes({
        db: deps.auth.adminDb,
      }),
    );
  }

  app.route(
    '/',
    authDiscoveryRoutes({
      db: deps.appDb,
      limiter: deps.publicRateLimiter,
      sourceAddress: deps.publicSourceAddress,
    }),
  );

  if (deps.adminDb && deps.settings.get) {
    app.route(
      '/admin',
      adminRoutes({
        auth: deps.auth,
        appDb: deps.appDb,
        controlDb: deps.adminDb,
        clientSecrets: deps.platformSecrets,
        queue: deps.foundingQueue,
        notifier: deps.notifier,
        settings: deps.settings as Pick<PlatformSettings, 'get' | 'set'>,
      }),
    );
  }
  app.route(
    '/',
    foundingRoutes({
      auth: deps.auth,
      setupEditor: deps.browserSessions?.setupEditor,
      clientSecrets: deps.platformSecrets,
      db: deps.auth.adminDb,
      queue: deps.foundingQueue,
      limiter: deps.publicRateLimiter,
      registrationMode: deps.registrationMode ?? (async () => 'approval_required'),
      termsVersion: deps.publicSite?.termsVersion ?? null,
      notifier: deps.notifier,
      sourceAddress: deps.publicSourceAddress,
      oidc: deps.oidc
        ? {
            discover: deps.oidc.discover,
            checkDomain: deps.checkFoundingDomain,
          }
        : undefined,
    }),
  );
  app.route(
    '/',
    meRoutes({
      auth: deps.auth,
      db: deps.auth.adminDb,
      limiter: deps.publicRateLimiter,
      sourceAddress: deps.publicSourceAddress,
    }),
  );
  app.route('/', memberRoutes({ auth: deps.auth, db: deps.auth.adminDb, notifier: deps.notifier }));
  app.route(
    '/',
    tenantSettingsRoutes({
      auth: deps.auth,
      clientSecrets: deps.platformSecrets,
      db: deps.auth.adminDb,
      queue: deps.foundingQueue,
      discover: deps.oidc?.discover,
      checkDomain: deps.checkWorkspaceDomain,
    }),
  );
  app.route(
    '/',
    notificationRoutes({
      auth: deps.auth,
      db: deps.appDb,
      appUrl: deps.notificationAppUrl ?? 'http://localhost:45173',
    }),
  );

  // Public ingress authenticated by the GitHub App webhook HMAC, not a dashboard bearer token.
  if (deps.adminDb)
    app.route(
      '/webhooks/github',
      githubWebhookRoutes({
        adminDb: deps.adminDb,
        appDb: deps.appDb,
        secrets: deps.secrets,
        log: deps.log,
      }),
    );

  if (deps.adminDb && deps.alertmanager)
    app.route(
      '/webhooks/alertmanager',
      alertmanagerWebhookRoutes({
        adminDb: deps.adminDb,
        appDb: deps.appDb,
        secrets: deps.secrets,
        ...deps.alertmanager,
        log: deps.log,
      }),
    );

  if (deps.adminDb)
    app.route(
      '/webhooks/gitlab',
      gitLabWebhookRoutes({
        adminDb: deps.adminDb,
        appDb: deps.appDb,
        secrets: deps.secrets,
        log: deps.log,
      }),
    );

  const registry = deps.registry ?? new ConnectorRegistry();
  const connectorProvider = makeDbConnectorProvider({
    db: deps.appDb,
    registry,
    secrets: deps.secrets,
  });
  app.route('/', mcpRoutes({ auth: deps.auth, db: deps.appDb, registry, secrets: deps.secrets }));

  app.post('/me/sign-out-everywhere', requireUser(deps.auth), async (c) => {
    const { userId, issuedAt } = c.get('user');
    await setUserNotBefore(deps.auth.db, userId, issuedAt);
    await deps.auth.revoke.publish({ userId });
    return c.json({ ok: true });
  });

  app.route(
    '/connectors',
    connectorRoutes({
      auth: deps.auth,
      db: deps.appDb,
      cache: deps.cache,
      secrets: deps.secrets,
      registry,
      log: deps.log,
      githubSmee: deps.githubSmee,
      gitlabSmee: deps.gitlabSmee,
      alertmanagerSmee: deps.alertmanagerSmee,
    }),
  );

  app.route(
    '/surfaces',
    surfaceRoutes({
      auth: deps.auth,
      db: deps.appDb,
      adminDb: deps.adminDb,
      secrets: deps.secrets,
      channels: deps.slackChannelsCache,
      slackSockets: deps.slackSockets,
      log: deps.log,
    }),
  );

  app.route(
    '/incidents',
    incidentRoutes({
      auth: deps.auth,
      db: deps.appDb,
      cache: deps.cache,
      runbookQueue: deps.runbookQueue,
      declarationQueue: deps.declarationQueue,
      adminDb: deps.adminDb,
      hub: deps.hub,
      log: deps.log,
      resumeQueue: deps.resumeQueue,
      resolveSlackPermalink: deps.resolveSlackPermalink,
      resolveSlackDisplay: makeSlackDisplayResolver({
        getToken: (tenantId) => deps.secrets.get(tenantId, surfaceBotTokenKey('slack')),
      }),
      resolveConnectors: (tenantId) => connectorProvider(tenantId)(),
      getAutomaticInvestigationBudget:
        deps.settings.get && deps.settings.llmRuntime
          ? () =>
              loadAutomaticInvestigationBudgetLimits(
                deps.settings as Pick<PlatformSettings, 'get' | 'llmRuntime'>,
              )
          : undefined,
    }),
  );

  app.route(
    '/incidents',
    attachmentRoutes({ auth: deps.auth, db: deps.appDb, fetchAttachment: deps.fetchAttachment }),
  );
  app.route('/incidents', incidentTagRoutes({ auth: deps.auth, db: deps.appDb }));

  app.route('/topology', topologyRoutes({ auth: deps.auth, db: deps.appDb, cache: deps.cache }));

  app.route('/changes', changeRoutes({ auth: deps.auth, db: deps.appDb }));

  if (deps.signalRoute && deps.signalEvaluationQueue && deps.signalRuntimeFingerprint)
    app.route(
      '/signals',
      signalRoutes({
        auth: deps.auth,
        db: deps.appDb,
        route: deps.signalRoute,
        evaluationQueue: deps.signalEvaluationQueue,
        runtimeFingerprint: deps.signalRuntimeFingerprint,
      }),
    );
  app.route('/reliability', reliabilityRoutes({ auth: deps.auth, db: deps.appDb }));
  app.route('/slos', sloRoutes({ auth: deps.auth, db: deps.appDb }));

  app.route(
    '/platform-settings',
    platformSettingsRoutes({
      auth: deps.auth,
      operatorDb: deps.appDb,
      controlDb: deps.adminDb,
      settings: deps.settings,
      platformSecrets: deps.platformSecrets,
      validateCustomProviderUrl: async (url) => {
        await assertSafeHttpsUrl(url, undefined, { allowPrivate: true });
      },
    }),
  );

  // GET /infrastructure and GET /deployments live at the root, mounted from one router. /deployments
  // reads the durable deployments table under RLS, so it needs the app-role connection.
  app.route('/', snapshotRoutes({ auth: deps.auth, cache: deps.cache, db: deps.appDb }));

  return app;
}
