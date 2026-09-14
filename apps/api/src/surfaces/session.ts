import { scrubSecrets } from '@sre/agent-tools';
import {
  MAX_CONTENT_CHARS,
  WS_CLOSE_POLICY,
  WS_CLOSE_TOKEN_EXPIRED,
  type IngestRefusalCode,
} from '@sre/contracts';
import { eq } from 'drizzle-orm';
import {
  getIncident,
  getUserTenantSessionState,
  incidents,
  tenants,
  withTenant,
  type Db,
  type Executor,
  type Tx,
} from '@sre/db';
import type { ConversationHub, HubMessage } from '@sre/hub';
import type { TicketStore } from './ticket';
import type { SurfaceAdapter } from './types';
import type { SessionRegistry } from '../auth/revoke';

// Re-export the shared wire contract so existing importers of `./session` keep working.
export { MAX_CONTENT_CHARS, type IngestRefusalCode } from '@sre/contracts';

// Bound the WS-open replay to the most recent N messages so a long-running incident's transcript
// can't blow up the initial payload; older turns page in via history({ before }).
const HISTORY_REPLAY_LIMIT = 200;

// setTimeout keeps its delay in a signed 32-bit int, so a delay above 2^31-1 ms overflows and Node
// fires on the NEXT TICK. A token with a far-future expiry would then close a perfectly healthy
// socket immediately, which is the opposite of the guard's purpose, so long waits are re-armed in
// hops of at most this size.
const MAX_TIMER_MS = 2_147_483_647;

async function hasDurableSessionAccess(
  db: Executor,
  userId: string,
  tenantId: string,
  providerId: string,
  tokenIssuedAt: number,
  applicationSessionId?: string,
): Promise<boolean> {
  const state = await getUserTenantSessionState(
    db,
    userId,
    tenantId,
    providerId,
    applicationSessionId,
  );
  return Boolean(
    state &&
    state.providerEligible &&
    state.sessionEligible &&
    state.userStatus === 'active' &&
    state.tenantStatus === 'active' &&
    state.membershipStatus === 'active' &&
    (!state.notBefore || tokenIssuedAt >= state.notBefore.getTime()),
  );
}

/**
 * A post the surface refused on policy grounds, as opposed to an infrastructure failure. Thrown
 * before anything is persisted (or inside the write tx, which then rolls back), so a refusal never leaves
 * a message or a resume job behind. Transports map it to a client-visible error; a bare Error stays a 500.
 */
export class IngestRefusedError extends Error {
  constructor(
    readonly code: IngestRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'IngestRefusedError';
  }
}

/** Transport sink: a WebSocket in production, a collector in tests. */
export interface SessionSink {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/**
 * Coalescing resume producer split into a tx half + a post-commit half; the @sre/queue
 * Queue satisfies it. `insertResumeTx` inserts the durable resume job on the CALLER's transaction, so it
 * shares the human reply's tx and rolls back with it on failure — no orphaned reply. `publishResume`
 * dispatches the job onto the stream, and MUST run only after that tx committed.
 */
export interface ResumeProducer {
  /** Insert the durable resume job on `tx`. Returns the new job id, or null when the durable coalescing
   * index folded it onto an already-pending resume for this incident. */
  insertResumeTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    humanMessageId: string,
  ): Promise<{ jobId: string | null }>;
  /** Post-commit dispatch for a job `insertResumeTx` created. Never call before the tx committed. */
  publishResume(jobId: string): Promise<void>;
}

export interface SessionDeps {
  /** RLS-scoped connection for the incident ownership check. */
  appDb: Db;
  hub: ConversationHub;
  tickets: TicketStore;
  /** Durable queue producer: a human reply enqueues a `resume` job. */
  queue: ResumeProducer;
  /** One replica-local registry used for immediate user and tenant revocation. */
  sessionRegistry: Pick<SessionRegistry, 'register'>;
}

export interface IncidentSession {
  adapter: SurfaceAdapter;
  close(): Promise<void>;
}

/**
 * Open a tenant-scoped dashboard session on an incident's canonical conversation.
 * Authenticates the token, authorizes the tenant against the incident,
 * replays history, then projects live hub messages to the sink. Returns null (after
 * closing the sink) when auth or authorization fails.
 */
export async function openIncidentSession(
  deps: SessionDeps,
  params: { incidentId: string; ticket: string | undefined; sink: SessionSink },
): Promise<IncidentSession | null> {
  const { incidentId, ticket, sink } = params;

  const ctx = await deps.tickets.redeem(ticket ?? '');
  if (!ctx) {
    sink.close(WS_CLOSE_POLICY, 'invalid ticket');
    return null;
  }
  const { tenantId, userId, providerId, tokenIssuedAt, tokenExpiresAt, applicationSessionId } = ctx;

  // Session-lifetime state, declared before the first await so the expiry timer below can never fire
  // into a temporal dead zone while an early lookup is still in flight.
  let unsubscribe: (() => Promise<void>) | null = null;
  let sessionClosed = false;
  let credentialClosed = false;
  let finishReplay!: () => void;
  const replayReady = new Promise<void>((resolve) => {
    finishReplay = resolve;
  });
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let deregister: (() => void) | undefined;
  const clearExpiry = (): void => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
  };
  // Shared by closeSession and the post-commit ingest paths, so both emit the same structured shape.
  const warn = (msg: string, err: unknown): void =>
    console.warn(
      JSON.stringify({
        level: 'warn',
        pkg: 'surfaces',
        msg,
        incidentId,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  const closeSession = (reason: string, code = WS_CLOSE_POLICY): void => {
    if (sessionClosed) return;
    sessionClosed = true;
    clearExpiry();
    finishReplay();
    deregister?.();
    deregister = undefined;
    sink.close(code, reason);
    // The hub unsubscribe disconnects a duplicated Valkey connection, so a rejection both leaks that
    // connection and would surface as an unhandled rejection. Nothing here can retry it; log and move on.
    if (unsubscribe)
      void unsubscribe().catch((err) => warn('unsubscribe failed on session close', err));
  };
  // Every arm reassigns the same handle, so the clear paths below always hold the live timer rather
  // than a stale one left behind by an intermediate hop.
  const armExpiry = (deadline: number): void => {
    const remaining = deadline - Date.now();
    expiryTimer =
      remaining > MAX_TIMER_MS
        ? setTimeout(() => armExpiry(deadline), MAX_TIMER_MS)
        : setTimeout(() => {
            expiryTimer = undefined;
            closeSession(WS_CLOSE_TOKEN_EXPIRED);
          }, remaining);
  };
  try {
    const unregister = deps.sessionRegistry.register(
      userId,
      tenantId,
      (code, reason) => {
        credentialClosed = true;
        closeSession(reason, code);
      },
      applicationSessionId,
    );
    deregister = unregister;
    if (sessionClosed) {
      deregister();
      deregister = undefined;
      return null;
    }

    // Registration precedes every await. A revocation published before registration is caught by
    // the durable check; one published afterwards invokes the registered close callback.
    if (tokenExpiresAt <= Date.now()) {
      closeSession(WS_CLOSE_TOKEN_EXPIRED);
      return null;
    }
    armExpiry(tokenExpiresAt);
    if (
      !(await hasDurableSessionAccess(
        deps.appDb,
        userId,
        tenantId,
        providerId,
        tokenIssuedAt,
        applicationSessionId,
      ))
    ) {
      closeSession('signed out');
      return null;
    }
    if (sessionClosed) return null;

    // Tenant-scoping: the incident must be visible to this tenant under RLS. A miss is
    // indistinguishable from "not found" by design — no cross-tenant existence leak.
    const incident = await getIncident(deps.appDb, tenantId, incidentId);
    if (!incident || incident.archivedAt) {
      closeSession('forbidden');
      return null;
    }
    if (sessionClosed) return null;

    const adapter: SurfaceAdapter = {
      surface: 'dashboard',
      project(msg) {
        sink.send(JSON.stringify({ ...msg, replay: false }));
      },
      async ingest({ content, author, clientMessageId }) {
        if (credentialClosed)
          throw new IngestRefusedError(
            'session_closed',
            'this session has ended; reconnect to post',
          );
        // The credential bounds every write, not just the socket: a frame that raced the expiry close
        // must not append under an expired token. Gated on the deadline rather than on sessionClosed,
        // which the archive/forbidden closes also set and whose refusal reason the write tx below owns.
        if (tokenExpiresAt <= Date.now())
          throw new IngestRefusedError(
            'session_closed',
            'this session has ended; reconnect to post',
          );
        const resolvedAuthor = author ?? 'human';
        // Content bound: refuse before opening the tx — an over-length post costs nothing to reject.
        if (content.length > MAX_CONTENT_CHARS)
          throw new IngestRefusedError(
            'content_too_long',
            `message is ${content.length} characters; the limit is ${MAX_CONTENT_CHARS}`,
          );
        // Atomicity: the incident_messages insert and the resume-job insert share ONE tenant tx, so a
        // failed resume rolls back the human reply — no orphaned message. `jobs` is non-RLS and
        // app_user holds INSERT, so this app RLS tx writes both. Guard on 'human' so a projected agent/system
        // message can never trigger a resume. Coalescing bounds pending resumes to one per incident;
        // the worker rebuilds the full transcript from the hub and runs engine.resume, so one resume covers
        // every queued reply.
        const { msg, resumeJobId } = await withTenant(deps.appDb, tenantId, async (tx: Tx) => {
          await tx
            .select({ id: tenants.id })
            .from(tenants)
            .where(eq(tenants.id, tenantId))
            .limit(1)
            .for('share');
          if (
            !(await hasDurableSessionAccess(
              tx,
              userId,
              tenantId,
              providerId,
              tokenIssuedAt,
              applicationSessionId,
            ))
          ) {
            credentialClosed = true;
            closeSession('signed out');
            throw new IngestRefusedError(
              'session_closed',
              'this session has ended; reconnect to post',
            );
          }
          const current = await tx
            .select({ archivedAt: incidents.archivedAt })
            .from(incidents)
            .where(eq(incidents.id, incidentId))
            .limit(1)
            .for('update');
          if (current[0]?.archivedAt) {
            throw new IngestRefusedError(
              'incident_archived',
              'this incident was deleted and cannot accept new messages',
            );
          }
          // Attribution is human-only, mirroring the resume guard below: only a real dashboard
          // reply carries the origin surface + the authed platform user from the ticket. A projected
          // agent/system message stays unattributed (null/null), never mislabeled as a dashboard human.
          const isHuman = resolvedAuthor === 'human';
          // Scrub at ingest, mirroring the two Slack ingest points: a human who pastes a
          // credential must not have it persisted raw in incident_messages nor egressed to the LLM on resume.
          // This is the single write boundary, so everything downstream reads the scrubbed row. Human-only:
          // an agent/system message projected through this path was already scrubbed at its own source
          // (worker.ts), and re-running the pass over it would be redundant work on an already-clean string.
          const appended = await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
            author: resolvedAuthor,
            content: isHuman ? scrubSecrets(content) : content,
            originSurface: isHuman ? 'dashboard' : undefined,
            authorUserId: isHuman ? userId : null,
            originMessageId:
              isHuman && clientMessageId ? `dashboard:${clientMessageId}` : undefined,
          });
          const jobId =
            resolvedAuthor === 'human' && appended.inserted
              ? (await deps.queue.insertResumeTx(tx, tenantId, incidentId, appended.message.id))
                  .jobId
              : null;
          return { msg: appended.message, resumeJobId: jobId };
        });
        // Post-commit side effects only (Redis is not transactional; a publish/xadd for a rolled-back row
        // is exactly the bug closes). Best-effort: the reply + resume job are already durable, so a
        // publish/xadd failure must NOT reject ingest — a client retry would insert a duplicate message
        // (incident_messages has no idempotency key). Live delivery falls back to history replay; the
        // queue reconciler re-XADDs a null-stream_id resume job.
        const postCommit = (op: string) =>
          `${op} failed post-commit; row is durable, recovered by replay/reconcile`;
        await deps.hub
          .publishAppended(msg)
          .catch((err) => warn(postCommit('publishAppended'), err));
        if (resumeJobId)
          await deps.queue
            .publishResume(resumeJobId)
            .catch((err) => warn(postCommit('publishResume'), err));
        return msg;
      },
    };

    // Subscribe before replaying history so nothing is lost in the gap; dedup by id.
    const seen = new Set<string>();
    const deliverVisible = (msg: HubMessage, replay = false) => {
      if (msg.kind === 'archive') {
        closeSession('forbidden');
        return;
      }
      if (sessionClosed) return;
      if (seen.has(msg.id)) return;
      seen.add(msg.id);
      sink.send(JSON.stringify({ ...msg, replay }));
    };
    // Pub/Sub is only a wake-up hint. Every live projection revalidates the durable incident row, in
    // message order, so a missed archive publication cannot expose later conversation rows.
    let liveQueue = Promise.resolve();
    const enqueueLive = (msg: HubMessage) => {
      liveQueue = liveQueue
        .then(async () => {
          await replayReady;
          if (sessionClosed) return;
          if (
            !(await hasDurableSessionAccess(
              deps.appDb,
              userId,
              tenantId,
              providerId,
              tokenIssuedAt,
              applicationSessionId,
            ))
          ) {
            credentialClosed = true;
            closeSession('signed out');
            return;
          }
          const visible = await getIncident(deps.appDb, tenantId, incidentId);
          if (!visible || visible.archivedAt) {
            closeSession('forbidden');
            return;
          }
          deliverVisible(msg);
        })
        .catch(() => closeSession('forbidden'));
    };
    unsubscribe = await deps.hub.subscribe(incidentId, enqueueLive);
    if (sessionClosed) {
      clearExpiry();
      finishReplay();
      await unsubscribe();
      return null;
    }
    const current = await getIncident(deps.appDb, tenantId, incidentId);
    if (!current || current.archivedAt) {
      sessionClosed = true;
      clearExpiry();
      finishReplay();
      deregister?.();
      deregister = undefined;
      await unsubscribe();
      sink.close(WS_CLOSE_POLICY, 'forbidden');
      return null;
    }
    const history = await deps.hub.history(tenantId, incidentId, { limit: HISTORY_REPLAY_LIMIT });
    const visibleAfterHistory = await getIncident(deps.appDb, tenantId, incidentId);
    if (
      !(await hasDurableSessionAccess(
        deps.appDb,
        userId,
        tenantId,
        providerId,
        tokenIssuedAt,
        applicationSessionId,
      )) ||
      !visibleAfterHistory ||
      visibleAfterHistory.archivedAt ||
      history.some((message) => message.kind === 'archive')
    ) {
      closeSession('forbidden');
      return null;
    }
    for (const msg of history) deliverVisible(msg, true);
    finishReplay();

    // The deadline can land inside any await above. A session already closed must never be returned as
    // live; closeSession has already released the subscription, so do not unsubscribe again here.
    if (sessionClosed) return null;

    return {
      adapter,
      async close() {
        if (sessionClosed) return;
        sessionClosed = true;
        clearExpiry();
        finishReplay();
        deregister?.();
        deregister = undefined;
        await unsubscribe!();
        await liveQueue;
      },
    };
  } catch (err) {
    // ws.ts onOpen has no catch, so a rethrow alone would leave an authenticated socket open with no
    // deadline and no subscription. closeSession clears the timer, resolves replayReady so a queued
    // live message cannot retain deps forever, closes the sink and releases the subscription detached,
    // and no-ops when the expiry timer already closed this session. The reason is deliberately not
    // WS_CLOSE_TOKEN_EXPIRED: the dashboard silently re-tickets on that exact pairing, and an
    // infrastructure failure must surface rather than loop.
    closeSession('internal error');
    throw err;
  }
}
