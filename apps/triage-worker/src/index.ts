import { Redis } from 'ioredis';
import { reconcileGitLabHooks } from './gitlab-hook-management/reconcile';
import {
  makeDb,
  assertRuntimeRoleScoped,
  shouldEnforceRuntimeRole,
  adminUrl,
  appUrl,
  makeSecretStore,
  makeEmbedder,
  listTenants,
  recordConnectorPollFailure,
  listIdleTerminalIncidentCandidates,
  surfaceBotTokenKey,
  makePlatformSecretStore,
} from '@sre/db';
import { makeSlackFileFetcher, type FileFetchLike } from '@sre/surfaces';
import { makeDbAuditSink, makeDbConnectorProvider } from '@sre/agent-tools';
import { defaultRegistry, developmentRegistryOptions } from '@sre/connectors';
import {
  Queue,
  DEFAULT_STUCK_GRACE_MS,
  makeClassifyQueue,
  makeRunbookQueue,
  makeSnapshotCache,
  pruneTerminalJobs,
  type StuckJobInfo,
} from '@sre/queue';
import { ConversationHub } from '@sre/hub';
import { PlatformSettings, loadAutomaticInvestigationBudgetLimits } from '@sre/platform-settings';
import { makeClassifyHandler } from './classify-consumer';
import { makeSlackIntakeStateDeps } from './classify-consumer/intake-state';
import { makeRunbookHandler } from './runbook-consumer';
import { makePostmortemHandler } from './postmortem-consumer';
import { makeGradeHandler } from './grade-consumer';
import { loadJobDeadlineConfig, loadRunbookSeedConfig, terminalJobRetentionSec } from './config';
import { makeRunbookSeeder } from './runbook-seeder';
import { TriageWorker } from './worker';
import {
  makePollHandler,
  PollScheduler,
  makeRedisWindowGuard,
  runOncePerWindow,
  SNAPSHOT_TTL_SEC,
} from './poller';
import { makeRedisLock } from './lock';
import { makeSloRuntime } from './slo-runtime';
import { makeSlackAdapters } from './slack-adapters';
import { persistDeploys } from './persist-deploys';
import {
  archiveIdleTerminalIncidents,
  runAutoArchiveSweep,
  runConfiguredAutoArchiveSweep,
} from './auto-archive';
import { makeLlmRuntimeManager } from './llm-runtime';
import { makeSubjectSyncResolver } from './subject-sync';
import { makeSubjectSyncRecovery } from './subject-sync-recovery';
import { runSignalMaintenance } from './signal-maintenance';
import { makeSignalEvaluationHandler } from './signal-evaluation';
import { makeTopologyDiscoveryRuntime, runTopologyDiscoveryConsumer } from './topology-discovery';
import { makePlatformTools } from './platform-tools';

const adminDb = makeDb(adminUrl());
// A dedicated pool prevents routing-fence transactions from starving their callbacks.
const coordinationDb = makeDb(adminUrl());
const appDb = makeDb(appUrl());
// Refuse superuser/BYPASSRLS app roles because they void tenant RLS.
const enforceRuntimeRole = shouldEnforceRuntimeRole(process.env);
if (!enforceRuntimeRole)
  console.warn(
    '[triage-worker] RLS runtime-role enforcement DISABLED via ALLOW_SUPERUSER_APP_DB (dev only)',
  );
await assertRuntimeRoleScoped(appDb, { enforce: enforceRuntimeRole });
const valkeyUrl = process.env.VALKEY_URL ?? 'redis://localhost:6379';
const redis = new Redis(valkeyUrl, { maxRetriesPerRequest: null });
const settingsRedis = new Redis(valkeyUrl, {
  maxRetriesPerRequest: 1,
  commandTimeout: 2_000,
  autoResendUnfulfilledCommands: false,
  enableOfflineQueue: false,
});
const settings = new PlatformSettings(adminDb.db, settingsRedis, {
  env: process.env,
  onCacheError: (error) =>
    console.error(
      JSON.stringify({
        level: 'error',
        app: 'triage-worker',
        msg: 'platform settings cache degraded',
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
});
void settings.start();
const getFairnessWindowSec = () => settings.get('CLASSIFY_FAIRNESS_WINDOW_SEC');
const getIncidentAutoArchiveDays = () => settings.get('INCIDENT_AUTO_ARCHIVE_DAYS');
const getRecoveryMaxChecks = () => settings.get('RECOVERY_MAX_CHECKS');
const getEvidenceRowLimit = () => settings.get('EVIDENCE_ROW_LIMIT');
const getEvidenceBudgetChars = () => settings.get('EVIDENCE_BUDGET_CHARS');
const getAutomaticInvestigationBudget = () => loadAutomaticInvestigationBudgetLimits(settings);
const deadlines = loadJobDeadlineConfig();
// Synchronous on purpose: the requeued row is claimable by another replica from the moment of the
// fenced write, so nothing may be awaited between the log line and the exit.
const onStuck = (info: StuckJobInfo): void => {
  console.error(
    JSON.stringify({
      level: 'error',
      app: 'triage-worker',
      msg: 'job handler stuck past deadline; recycling process',
      ...info,
    }),
  );
  process.exit(1);
};
const queue = new Queue(adminDb.db, redis, {
  dispatchRedis: settingsRedis,
  maxProcessingMs: deadlines.triageMaxProcessingMs,
  onStuck,
});
// Poll jobs ride a SEPARATE stream + consumer group so connector polling scales out independently
// of triage. jobs live in Postgres (adminDb), same as the triage queue.
const pollQueue = new Queue(adminDb.db, redis, {
  stream: 'sre:jobs:poll',
  group: 'poll',
  dispatchRedis: settingsRedis,
  onStuck,
});
const topologyQueue = new Queue(adminDb.db, redis, {
  stream: 'sre:jobs:topology',
  group: 'topology',
  dispatchRedis: settingsRedis,
  onStuck,
});
// Classify jobs ride a dedicated stream + consumer group, isolated from triage so classify volume
// cannot head-of-line-block triage. The consumer is wired below.
const classifyQueue = makeClassifyQueue(adminDb.db, redis, {
  getFairnessWindowSec,
  dispatchRedis: settingsRedis,
  onStuck,
});
// Runbook-generation jobs (human-commanded) ride their own stream + consumer group so a
// runbook backlog cannot head-of-line-block triage. jobs live in Postgres (adminDb) like the others.
const runbookQueue = makeRunbookQueue(adminDb.db, redis, {
  dispatchRedis: settingsRedis,
  onStuck,
});
const cache = makeSnapshotCache(redis);
const hub = new ConversationHub(appDb.db, redis, settingsRedis);
const platformSecrets = makePlatformSecretStore(adminDb.db, process.env.SECRETS_MASTER_KEY!);
const llm = makeLlmRuntimeManager({
  db: appDb.db,
  settings,
  secrets: platformSecrets,
  env: process.env,
});

// Tool layer wiring: the loop resolves the tenant's connectors under RLS,
// decrypts credentials at point of use, and audits every run. `tools` holds only the platform tools
// that read the platform's own stores; each tenant's per-connector tools are bound per run in
// worker.runtime() from the resolved connectors. search_runbooks reads knowledge_chunks via
// the local embedder. All backed by the RLS-scoped app connection.
const registry = defaultRegistry(developmentRegistryOptions(process.env));
const secrets = makeSecretStore(appDb.db, process.env.SECRETS_MASTER_KEY!);
const connectorProvider = makeDbConnectorProvider({ db: appDb.db, registry, secrets });
// url + dim come from the env config, validated against EMBED_DIM inside makeEmbedder.
const embedder = makeEmbedder();
const auditSink = makeDbAuditSink({ db: appDb.db });
const tools = makePlatformTools({ db: appDb.db, embedder, cache });

// Proactive runbook seeder: seeds top-K past-incident runbooks into the incident-open
// brief above the configured similarity floor. K is a fixed constant (seed at most 3); the floor is
// env-tunable. Reads knowledge_chunks via the local embedder on the RLS-scoped app connection.
const RUNBOOK_SEED_K = 3;
const runbookSeeder = makeRunbookSeeder({
  db: appDb.db,
  embedder,
  scoreFloor: loadRunbookSeedConfig(process.env).scoreFloor,
  k: RUNBOOK_SEED_K,
});

// Slack file fetcher for screenshot interpretation: resolves the tenant's bot token at point
// of use (never persisted), host-pins to Slack, caps the size; the bytes are transient.
const slackFileFetcher = makeSlackFileFetcher({
  fetch: globalThis.fetch as unknown as FileFetchLike,
  getToken: (tenantId) => secrets.get(tenantId, surfaceBotTokenKey('slack')),
});

const worker = new TriageWorker({
  appDb: appDb.db,
  hub,
  llm,
  queue,
  runbookQueue,
  auditSink,
  connectorProvider,
  tools,
  lock: makeRedisLock(redis, deadlines.triageMaxProcessingMs + DEFAULT_STUCK_GRACE_MS + 60_000),
  clearResumeGate: (incidentId) => queue.clearResumeGate(incidentId),
  getRecoveryMaxChecks,
  getEvidenceRowLimit,
  getEvidenceBudgetChars,
  getAutomaticInvestigationBudget,
  resolveInvestigationSubject: makeSubjectSyncResolver({ db: appDb.db, cache }),
  runbookSeeder,
  fetchAttachment: (tenantId, urlPrivate) => slackFileFetcher.fetch(tenantId, urlPrivate),
});

// Classify consumer: relevance-judge inbound messages, drop noise, and route worthy ones
// through the incident funnel. `queue` here is the TRIAGE queue: routeToIncident enqueues the triage
// job onto it. A provider outage fails open to a degraded incident rather than dropping the
// message.
// Slack surface adapters (thread reader, breadcrumb poster, reminder poster, permalink resolver).
const { slackThreadReader, breadcrumbPoster, signalReminderPoster, resolvePermalink } =
  makeSlackAdapters(secrets);
const classifyHandler = makeClassifyHandler({
  llm,
  semanticDispositionEnabled: true,
  appDb: appDb.db,
  redis,
  reservationRedis: settingsRedis,
  queue,
  embedder,
  hub,
  threadReader: slackThreadReader,
  poster: breadcrumbPoster,
  resolvePermalink,
  ...makeSlackIntakeStateDeps(adminDb.db, coordinationDb.db),
});
const signalEvaluationHandler = makeSignalEvaluationHandler({ db: appDb.db, llm });
const classifyStreamHandler = (
  job: Parameters<typeof classifyHandler>[0],
  ctx: Parameters<typeof signalEvaluationHandler>[1],
) =>
  job.type === 'signal.disposition.evaluate'
    ? signalEvaluationHandler(job, ctx)
    : classifyHandler(job, ctx);

// Runbook-generation consumer: distils the human-triggered incident via the single
// StructuredGenerator, then writes a runbook / investigation note / nothing and posts to the hub. All
// reads and writes are RLS-scoped (appDb); it never fails the incident on a provider outage.
const runbookHandler = makeRunbookHandler({
  llm,
  hub,
  appDb: appDb.db,
  embedder,
});
// Postmortem generation and assessment grading share the runbook stream: all three are
// human-commanded, low-volume generations that must never head-of-line-block triage. One handler
// dispatches by job type (precedent: classifyStreamHandler).
const postmortemHandler = makePostmortemHandler({ llm, hub, appDb: appDb.db });
const gradeHandler = makeGradeHandler({ llm, appDb: appDb.db });
const generationStreamHandler = (
  job: Parameters<typeof runbookHandler>[0],
  ctx: Parameters<typeof runbookHandler>[1],
) => {
  if (job.type === 'postmortem.generate') return postmortemHandler(job, ctx);
  if (job.type === 'assessment.grade') return gradeHandler(job, ctx);
  return runbookHandler(job, ctx);
};

// Connector poller: the scheduler fans out poll jobs (guarded so one replica enqueues per
// window); the handler snapshots one connector per job and caches the result for the API panels.
const pollHandler = makePollHandler({
  connectorProvider,
  reconcileGitLabHooks: (tenantId, connectorId) =>
    reconcileGitLabHooks({ db: appDb.db, secrets }, tenantId, connectorId),
  cache,
  ttlSec: SNAPSHOT_TTL_SEC,
  // Persist polled deploys. RLS-scoped appDb.
  persistDeploys: (tenantId, snapshots, connectorType, evidence, generation) =>
    persistDeploys(appDb.db, tenantId, snapshots, connectorType, evidence, generation),
  onOutcome: async (outcome) => {
    const level = outcome.status === 'failure' ? 'error' : outcome.errorCount > 0 ? 'warn' : 'info';
    const line = JSON.stringify({
      level,
      app: 'triage-worker',
      msg: 'connector poll completed',
      ...outcome,
    });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (outcome.status === 'failure') {
      await recordConnectorPollFailure(
        appDb.db,
        outcome.tenantId,
        outcome.connectorType,
        outcome.failureCategory === 'persistence'
          ? 'persistence_failed'
          : (outcome.failureCategory ?? 'provider_failed'),
        outcome.errorCount,
        {
          durationMs: outcome.durationMs,
          rateLimitRemaining: outcome.rateLimitRemaining,
          rateLimitResetAt: outcome.rateLimitResetAt
            ? new Date(outcome.rateLimitResetAt)
            : undefined,
        },
        outcome.generation,
      );
    }
  },
});
const scheduler = new PollScheduler({
  guard: makeRedisWindowGuard(redis),
  dispatch: pollQueue,
  connectorProvider,
  listTenants: () => listTenants(adminDb.db),
});
const topology = makeTopologyDiscoveryRuntime({
  db: appDb.db,
  redis,
  dispatch: topologyQueue,
  connectorProvider,
  listTenants: () => listTenants(adminDb.db),
});

// Scheduled error-budget evaluation: a read model that persists burn events and opens nothing.
const slo = makeSloRuntime({ adminDb, appDb, redis, settingsRedis, connectorProvider, onStuck });

// Independent, idempotent stream-group creates — run them concurrently.
await Promise.all([
  queue.ensureGroup(),
  pollQueue.ensureGroup(),
  topologyQueue.ensureGroup(),
  classifyQueue.ensureGroup(),
  runbookQueue.ensureGroup(),
  slo.queue.ensureGroup(),
]);
scheduler.start();
topology.scheduler.start(300_000);
void runTopologyDiscoveryConsumer(topologyQueue, topology.handler);
slo.scheduler.start();
console.log(
  JSON.stringify({
    level: 'info',
    app: 'triage-worker',
    msg: 'started',
  }),
);

// Triage reconcile recovers lost XADD work; periodic poll jobs self-heal on their next enqueue.
// Guarded (SET NX per window, own 'triage:recon' prefix) so one replica reconciles per window; now
// that reconcile is stream-scoped it re-dispatches only triage jobs. Poll no longer reconciles.
// Invariant: queue.reconcile()'s olderThanMs (60s default) must stay above process()'s idleMs (30s).
// idleMs stays far below maxProcessingMs, which stays below the engine lock TTL so the lock cannot
// expire under a live run.
// A triage job actively retried by XAUTOCLAIM refreshes updated_at every ~idleMs; if the reconcile
// threshold dropped below that, reconcile would re-XADD a job that is still being retried and
// double-dispatch it. Keeping the driver cadence and reconcile threshold at 60s preserves the margin.
const TRIAGE_RECONCILE_MS = 60_000;
const triageReconcileGuard = makeRedisWindowGuard(redis, 'triage:recon');
const RECOVERY_DUE_DISPATCH_MS = 5_000;
const recoveryDueGuard = makeRedisWindowGuard(redis, 'recovery:due');
const recoverSubjectSync = makeSubjectSyncRecovery(redis, adminDb.db, appDb.db, queue);
// Classify reconcile driver: same lost-XADD recovery as triage, on the isolated classify
// stream. Stream-scoped reconcile recovers only classify jobs and preserves the idle margin.
const classifyReconcileGuard = makeRedisWindowGuard(redis, 'classify:recon');
// Runbook reconcile driver: same lost-XADD recovery as triage/classify, on the isolated
// runbook stream. Stream-scoped reconcile recovers only runbook jobs; 60s cadence keeps the
// same margin over process()'s idleMs.
const runbookReconcileGuard = makeRedisWindowGuard(redis, 'runbook:recon');
// One replica per window applies the current platform archive policy.
const AUTOARCHIVE_SWEEP_MS = 15 * 60_000;
const autoArchiveGuard = makeRedisWindowGuard(redis, 'incident:autoarchive');
// Terminal job history is global, so one daily guard covers every stream and replica.
const JOB_PRUNE_MS = 86_400_000;
const jobPruneGuard = makeRedisWindowGuard(redis, 'jobs:prune');
const signalMaintenanceGuard = makeRedisWindowGuard(redis, 'signals:maintenance');
const SIGNAL_MAINTENANCE_MS = 5 * 60_000;

// One process consumes every stream. A future dedicated poll-worker can consume 'sre:jobs:poll'
// with this same pollHandler and needs no rework. Smarter cadence/backoff lands later.
for (;;) {
  const triaged = await worker.tick();
  const polled = await pollQueue.process('poll-worker', async (job) => {
    // Drain discovery jobs queued before stream isolation without running them in the poll loop.
    if (job.type === 'topology.discover')
      await topologyQueue.enqueue({ tenantId: job.tenantId, type: job.type, payload: job.payload });
    else await pollHandler(job);
  });
  const classified = await classifyQueue.process('classify-worker', classifyStreamHandler);
  const generated = await runbookQueue.process('runbook-worker', generationStreamHandler);
  // Bounded per turn so a slow metrics backend cannot starve triage on this replica. No reconcile
  // driver: a lost evaluation is covered by the next window's fan-out.
  const evaluated = await slo.queue.process('slo-worker', slo.handler, { count: 2 });
  // Coarse, guarded triage reconcile so lost-XADD incidents are recovered exactly once per window.
  await runOncePerWindow(
    triageReconcileGuard,
    () => queue.reconcile(),
    TRIAGE_RECONCILE_MS,
    Date.now(),
  );
  await runOncePerWindow(
    recoveryDueGuard,
    async () => {
      const dispatched = await queue.dispatchDue();
      if (dispatched > 0) {
        console.log(
          JSON.stringify({
            level: 'info',
            app: 'triage-worker',
            event: 'recovery.due_dispatched',
            count: dispatched,
          }),
        );
      }
      return dispatched;
    },
    RECOVERY_DUE_DISPATCH_MS,
    Date.now(),
  );
  await runOncePerWindow(
    classifyReconcileGuard,
    () => classifyQueue.reconcile(),
    TRIAGE_RECONCILE_MS,
    Date.now(),
  );
  await runOncePerWindow(
    runbookReconcileGuard,
    () => runbookQueue.reconcile(),
    TRIAGE_RECONCILE_MS,
    Date.now(),
  );
  await runOncePerWindow(
    signalMaintenanceGuard,
    () =>
      runSignalMaintenance({
        adminDb: adminDb.db,
        appDb: appDb.db,
        post: signalReminderPoster.post.bind(signalReminderPoster),
      }),
    SIGNAL_MAINTENANCE_MS,
    Date.now(),
  );
  await recoverSubjectSync();
  // One replica sweeps terminal incidents per window; tenant failures do not block other tenants.
  await runOncePerWindow(
    autoArchiveGuard,
    async () => {
      const { archiveDays, archived } = await runConfiguredAutoArchiveSweep({
        getArchiveDays: getIncidentAutoArchiveDays,
        sweep: (idleBefore) =>
          runAutoArchiveSweep({
            listTenants: () => listTenants(adminDb.db),
            archiveIdle: (tenantId) =>
              archiveIdleTerminalIncidents(
                {
                  listIdle: (id, cutoff) =>
                    listIdleTerminalIncidentCandidates(appDb.db, id, cutoff),
                  archive: async (id, incidentId, input) =>
                    (await hub.setIncidentArchived(id, incidentId, input)).archive,
                },
                tenantId,
                idleBefore,
              ),
            onError: (err, ctx) =>
              console.error(
                JSON.stringify({
                  level: 'error',
                  app: 'triage-worker',
                  msg: 'auto-archive sweep failed',
                  tenantId: ctx.tenantId,
                  error: err instanceof Error ? err.message : String(err),
                }),
              ),
          }),
      });
      if (archived > 0) {
        console.log(
          JSON.stringify({
            level: 'info',
            app: 'triage-worker',
            msg: 'auto-archive sweep completed',
            archiveDays,
            archived,
          }),
        );
      }
      return archived;
    },
    AUTOARCHIVE_SWEEP_MS,
    Date.now(),
  );
  await runOncePerWindow(
    jobPruneGuard,
    async () =>
      pruneTerminalJobs(adminDb.db, terminalJobRetentionSec(await getFairnessWindowSec())),
    JOB_PRUNE_MS,
    Date.now(),
  );
  if (triaged === 0 && polled === 0 && classified === 0 && generated === 0 && evaluated === 0)
    await new Promise((r) => setTimeout(r, 1000));
}
