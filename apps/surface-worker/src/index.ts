// Outbound surface poster. A long-lived headless consumer of the hub's surface
// fan-out stream (sre:surface). A Valkey Streams consumer group wakes workers quickly; Postgres
// surface_deliveries is the durable outbox and CAS claim, and a per-binding lock serializes
// the working-post projection. Every post threads under the
// incident's binding — the conversation the alert arrived in — so nothing here opens threads.
// Postgres owns both the conversation and delivery state, so the outbox scan recovers a missed stream entry.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  makeDb,
  adminUrl,
  appUrl,
  makeSecretStore,
  masterKey,
  incidentTenant,
  getBindingById,
  getSurfaceStatusPostByBinding,
  advanceSurfaceStatusPostByBinding,
  getWorkingPost,
  setWorkingPost,
  clearWorkingPost,
  surfaceBotTokenKey,
  getUserEmailById,
  listMessageDeliveryTargets,
  hasAmbiguousLifecyclePostCreation,
  claimSurfaceDelivery,
  finishSurfaceDelivery,
  scheduleSurfaceDeliveryRetry,
  blockQueuedSurfaceDelivery,
  listQueuedSurfaceMessagesSystem,
  markStaleSurfaceDeliveriesUncertainSystem,
} from '@sre/db';
import { SURFACE_STREAM } from '@sre/hub';
import { SurfaceRegistry, makeSlackPoster, type Surface } from '@sre/surfaces';
import { fanoutHubMessage, type DeliveryTarget, type FanoutDeps } from './fanout';
import { resolveAuthorLabel } from './author-label';
import { ensureSurfaceGroup, surfaceStreamTick } from './consumer';
import { makeRedisSurfaceLock } from './lock';

const adminDb = makeDb(adminUrl());
const appDb = makeDb(appUrl());
const redis = new Redis(process.env.VALKEY_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
const secrets = makeSecretStore(appDb.db, masterKey());

const registry = new SurfaceRegistry();
registry.register(makeSlackPoster(globalThis.fetch));

const deps: FanoutDeps = {
  registry,
  lock: makeRedisSurfaceLock(redis),
  resolveTenant: (incidentId) => incidentTenant(adminDb.db, incidentId),
  listDeliveryTargets: async (tenantId, messageId) =>
    (await listMessageDeliveryTargets(appDb.db, tenantId, messageId)) as DeliveryTarget[],
  claimDelivery: (tenantId, surface, bindingId, messageId) =>
    claimSurfaceDelivery(appDb.db, tenantId, surface, bindingId, messageId),
  finishDelivery: (tenantId, surface, bindingId, messageId, result) =>
    finishSurfaceDelivery(appDb.db, tenantId, surface, bindingId, messageId, result),
  scheduleDeliveryRetry: (
    tenantId,
    surface,
    bindingId,
    messageId,
    expectedState,
    retryAt,
    reasonCode,
  ) =>
    scheduleSurfaceDeliveryRetry(
      adminDb.db,
      tenantId,
      surface,
      bindingId,
      messageId,
      expectedState,
      retryAt,
      reasonCode,
    ),
  blockDelivery: (tenantId, surface, bindingId, messageId, reasonCode) =>
    blockQueuedSurfaceDelivery(appDb.db, tenantId, surface, bindingId, messageId, reasonCode),
  getToken: (tenantId, surface) => secrets.get(tenantId, surfaceBotTokenKey(surface)),
  // Best-effort Slack author attribution: resolve the reply author's email on the control-plane db,
  // reduced to its local-part only — the address never leaves the control plane, and neither email nor
  // label is ever logged. Never throws: any failure degrades to null (unattributed), never drops the reply.
  resolveAuthorLabel: (tenantId, authorUserId) =>
    resolveAuthorLabel((t, u) => getUserEmailById(adminDb.db, t, u), tenantId, authorUserId),
  getBinding: async (tenantId, surface, bindingId) => {
    const binding = await getBindingById(appDb.db, tenantId, surface, bindingId);
    return binding ? { channel: binding.channel, threadId: binding.threadId } : null;
  },
  getStatusPost: (tenantId, surface, bindingId) =>
    getSurfaceStatusPostByBinding(appDb.db, tenantId, surface, bindingId),
  hasAmbiguousStatusPostCreation: (tenantId, surface, bindingId, currentMessageId) =>
    hasAmbiguousLifecyclePostCreation(appDb.db, tenantId, surface, bindingId, currentMessageId),
  advanceStatusPost: (
    tenantId,
    surface,
    bindingId,
    incidentId,
    assignmentVersion,
    messageId,
    version,
  ) =>
    advanceSurfaceStatusPostByBinding(
      appDb.db,
      tenantId,
      surface,
      bindingId,
      incidentId,
      assignmentVersion,
      messageId,
      version,
    ),
  getWorkingPost: (tenantId, bindingId) => getWorkingPost(appDb.db, tenantId, bindingId),
  setWorkingPost: (tenantId, bindingId, messageId) =>
    setWorkingPost(appDb.db, tenantId, bindingId, messageId),
  clearWorkingPost: (tenantId, bindingId) => clearWorkingPost(appDb.db, tenantId, bindingId),
  // Dashboard deep-link for the takeaway line; unset → the adapter omits the link.
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL,
  onError: (err, ctx) =>
    console.error(
      JSON.stringify({
        level: 'error',
        app: 'surface-worker',
        msg: 'fanout failed',
        incidentId: ctx.incidentId,
        surface: ctx.surface,
        error: err instanceof Error ? err.message : String(err),
      }),
    ),
};

const GROUP = 'surface';
// Unique per replica so consumers COMPETE for entries; a shared name would split one consumer's
// pending list. A crashed consumer's pending entries are reclaimed by XAUTOCLAIM.
const CONSUMER = `surface-${randomUUID().slice(0, 8)}`;

await ensureSurfaceGroup(redis, SURFACE_STREAM, GROUP);
console.log(
  JSON.stringify({
    level: 'info',
    app: 'surface-worker',
    msg: 'started',
    consumer: CONSUMER,
    surfaces: ['slack'],
  }),
);

// Graceful drain (edge 3): a tick fully processes + acks its batch before the loop re-checks `stopping`,
// so SIGTERM never kills an in-flight entry in the post→ack gap.
let stopping = false;
let lastStaleReconcileAt = 0;
const stop = (): void => {
  stopping = true;
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// oxlint-disable-next-line no-unmodified-loop-condition -- `stopping` is mutated by the SIGTERM/SIGINT handler, which static analysis can't track.
while (!stopping) {
  try {
    const handled = await surfaceStreamTick(
      redis,
      { stream: SURFACE_STREAM, group: GROUP, consumer: CONSUMER },
      (m) => fanoutHubMessage(deps, m),
    );
    const now = Date.now();
    if (now - lastStaleReconcileAt >= 60_000) {
      await markStaleSurfaceDeliveriesUncertainSystem(adminDb.db, new Date(now - 120_000));
      lastStaleReconcileAt = now;
    }
    // Postgres is the outbox authority. This scan recovers a message committed before Redis XADD succeeded.
    const queued = await listQueuedSurfaceMessagesSystem(adminDb.db, 20);
    const recoveries = new Map<
      string,
      { message: (typeof queued)[number]['message']; tenantId: string; targets: DeliveryTarget[] }
    >();
    for (const item of queued) {
      const existing = recoveries.get(item.message.id);
      if (existing)
        existing.targets.push({
          surface: item.surface as Surface,
          bindingId: item.bindingId,
          bindingAssignmentVersion: item.bindingAssignmentVersion,
        });
      else
        recoveries.set(item.message.id, {
          message: item.message,
          tenantId: item.tenantId,
          targets: [
            {
              surface: item.surface as Surface,
              bindingId: item.bindingId,
              bindingAssignmentVersion: item.bindingAssignmentVersion,
            },
          ],
        });
    }
    let recoveryProgress = false;
    for (const recovery of recoveries.values()) {
      recoveryProgress =
        (await fanoutHubMessage(deps, recovery.message, {
          tenantId: recovery.tenantId,
          targets: recovery.targets,
        })) || recoveryProgress;
    }
    if (handled === 0 && !recoveryProgress) await new Promise((r) => setTimeout(r, 1000));
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        app: 'surface-worker',
        msg: 'delivery loop failed; retrying',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// allSettled so one failing close can't skip the others or exit on an unhandled rejection.
await redis.quit().catch(() => {});
await Promise.allSettled([adminDb.close(), appDb.close()]);
console.log(JSON.stringify({ level: 'info', app: 'surface-worker', msg: 'stopped' }));
