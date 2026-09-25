import {
  type Db,
  type IncidentStatus,
  type IncidentCorrelationDecision,
  type InvestigationStatus,
  type SignalEventType,
  type SignalObservation,
  type SignalState,
  type Surface,
  type Tx,
} from '@sre/db';
import type { InvestigationTrigger, ResolutionPolicy } from '@sre/contracts';
import type { Queue } from '@sre/queue';
import type { Redis } from 'ioredis';
import {
  SurfaceThreadConflictError,
  openIncidentWorkspace,
  type OpenIncidentWorkspaceInput,
} from './open-incident-workspace';

/**
 * Result of routing a signal: `deduped` (a re-alert inside the dedup window), or a created/reused
 * incident + enqueued triage job.
 */
export interface RouteResult {
  deduped: boolean;
  incidentId?: string;
  /**
   * Absent when the signal was deduped, and when it folded into an incident already under investigation
   * (`reused`): there is exactly one triage job per investigation.
   */
  jobId?: string;
  /**
   * Whether the signal folded into an incident that already existed instead of opening one. Set only when
   * the signal reached the write path (`deduped: false`), like `incidentId`/`jobId`. A caller holding
   * `reused: true` is looking at a live incident whose thread is already being answered in, so its own
   * message is a contribution to that conversation, not a new investigation.
   */
  reused?: boolean;
}

/**
 * The external conversation a routed signal arrived in. Slack adapters require it; dashboard-originated
 * observations use the same workspace opener without a remote binding.
 */
export interface ConversationOrigin {
  surface: Surface;
  /** The channel the message arrived in (a Slack channel id). */
  channel: string;
  /** The root message of its thread (a Slack thread_ts / message ts). */
  threadId: string;
}

/**
 * A normalized incident signal. `source` and `severity` are free text (the incident columns are text,
 * so a synthetic source needs no connector-enum membership); `context` is forwarded opaquely to the
 * triage engine in the job payload.
 */
export interface IncidentSignal {
  resolutionPolicy?: ResolutionPolicy;
  tenantId: string;
  source: string;
  fingerprint: string;
  service: string;
  severity: string;
  purpose?: 'incident' | 'health_check';
  /** The conversation this signal arrived in; the incident is bound to it in the same transaction. */
  origin: ConversationOrigin;
  /** Short human-readable incident title (e.g. the relevance classifier's title). Threaded onto the
   * triage job payload so the worker can build the incident-open runbook-seed query. */
  title?: string;
  /** Opaque context handed to the triage engine (e.g. the full alert). */
  context?: unknown;
  /** Durable reason and budget scope for the investigation opened by this signal. */
  investigationTrigger?: InvestigationTrigger;
  /** Resolves an active operational workspace under the incident-creation transaction. */
  resolveIncidentRouteTx?: OpenIncidentWorkspaceInput['resolveIncidentRouteTx'];
  /**
   * The accepted surface message that opened this incident. It is written into the canonical
   * conversation in the same transaction as the incident, binding, and triage job, so the dashboard
   * can always replay what triggered the investigation. Omitted only for callers that already seed the
   * conversation through another atomic path.
   */
  opener?: {
    author: 'human' | 'system';
    content: string;
    originSurface: Surface | 'dashboard';
    originMessageId: string;
    authorUserId?: string | null;
  };
  /** Initial operational lifecycle; defaults to open. */
  status?: IncidentStatus;
  /** Initial agent work state; a classifier outage starts degraded while lifecycle remains open. */
  investigationStatus?: InvestigationStatus;
  /** Durable state of the external alert instance that caused this route. */
  signal?: Omit<SignalObservation, 'incidentId'>;
  /** Distinct provider observations carried by one grouped delivery. */
  signals?: Omit<SignalObservation, 'incidentId'>[];
  /** Dedup / re-alert suppression window in seconds; falls back to the router default. */
  dedupTtlSec?: number;
  /**
   * Source-specific durable finalization that must commit with incident creation. A direct provider
   * intake uses this to attach its pre-posted Slack root, cohort membership, and recurrence evidence.
   */
  onRoutedTx?: (
    tx: Tx,
    routed: {
      incidentId: string;
      bindingId: string;
      reused: boolean;
      signalId: string | null;
      correlationDecision?: IncidentCorrelationDecision;
    },
  ) => Promise<void>;
  /**
   * The redelivery-suppression key, defaulting to the fingerprint. A source whose fingerprint is NOT
   * per-message MUST set this to its own message id: the fingerprint is the INCIDENT identity, and the
   * mention path derives it from the thread (thread is the incident), so keying suppression on it lets one
   * key swallow every distinct message in the thread for the whole TTL.
   */
  dedupKey?: string;
}

export interface RouteDeps {
  appDb: Db;
  redis: Redis;
  queue: Queue;
  /** Transactional conversation writer, required whenever the signal carries an opener. */
  appendOpenerTx?: (
    tx: Tx,
    tenantId: string,
    incidentId: string,
    opener: NonNullable<IncidentSignal['opener']>,
    observed?: { id: string; state: SignalState; eventType: SignalEventType },
  ) => Promise<{ incidentId: string; afterCommit?: () => Promise<void> }>;
}

/** Reports that an inbound conversation already belongs to another incident. */
export class ThreadAlreadyBoundError extends Error {
  constructor(readonly incidentId: string) {
    super('surface thread is already bound to another incident');
    this.name = 'ThreadAlreadyBoundError';
  }
}

/** Dedup window for a signal that does not set its own. */
const DEFAULT_DEDUP_TTL_SEC = 300;

/**
 * Routes an accepted signal to a new or existing incident workspace.
 *
 * @param deps - Deduplication and incident workspace dependencies.
 * @param signal - Normalized signal and originating conversation identity.
 */
export async function routeToIncident(
  deps: RouteDeps,
  signal: IncidentSignal,
): Promise<RouteResult> {
  const ttl = signal.dedupTtlSec ?? DEFAULT_DEDUP_TTL_SEC;
  // Suppression is per-MESSAGE, incident identity is per-fingerprint. They coincide only when the caller's
  // fingerprint is itself per-message, so the fingerprint is the default, not the rule.
  // `||`, not `??`: an empty dedupKey is never a meaningful value, and it would collapse the key to
  // `dedup:{tenant}:` — ONE suppression key per tenant, silently eating every signal for the whole TTL.
  // Unreachable today, but this field is public and that failure is the class, only tenant-wide.
  const key = `dedup:${signal.tenantId}:${signal.dedupKey || signal.fingerprint}`;
  let reserved = false;
  let dedupUnavailable = false;
  let set: string | null = null;
  try {
    set = await deps.redis.set(key, '1', 'EX', ttl, 'NX');
    reserved = set !== null;
  } catch (error) {
    dedupUnavailable = true;
    console.warn(
      JSON.stringify({
        level: 'warn',
        pkg: '@sre/alerts',
        event: 'route.dedup_unavailable',
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  }
  if (!dedupUnavailable && set === null) return { deduped: true };

  try {
    const opened = await openIncidentWorkspace(
      { appDb: deps.appDb, queue: deps.queue, appendOpenerTx: deps.appendOpenerTx },
      {
        resolutionPolicy: signal.resolutionPolicy,
        tenantId: signal.tenantId,
        fingerprint: signal.fingerprint,
        source: signal.source,
        service: signal.service,
        severity: signal.severity,
        purpose: signal.purpose,
        title: signal.title,
        context: signal.context,
        investigationTrigger: signal.investigationTrigger,
        resolveIncidentRouteTx: signal.resolveIncidentRouteTx,
        status: signal.status,
        investigationStatus: signal.investigationStatus,
        binding: signal.origin,
        signal: signal.signal,
        signals: signal.signals,
        opener: signal.opener,
        onOpenedTx: signal.onRoutedTx
          ? (tx, routed) => {
              if (!routed.bindingId) throw new Error('routed conversation has no surface binding');
              return signal.onRoutedTx!(tx, { ...routed, bindingId: routed.bindingId });
            }
          : undefined,
      },
    );
    return {
      deduped: false,
      incidentId: opened.incidentId,
      jobId: opened.jobId ?? undefined,
      reused: opened.outcome === 'existing',
    };
  } catch (err) {
    // Release the reservation so the next signal retries instead of being suppressed for the full TTL
    // (up to 6h for a slow burn — a dropped page). createIncident is idempotent (upsert on
    // tenant+fingerprint) and the worker's queued->gathering progress CAS de-dupes, so re-firing is safe.
    // Guarded: when the failure IS Valkey the del throws too, and an unguarded throw here would replace
    // the original cause with the del error — that string is what lands in jobs.last_error. The key's own
    // EX bounds any reservation the failed release leaks.
    if (reserved) await deps.redis.del(key).catch(() => {});
    if (err instanceof SurfaceThreadConflictError)
      throw new ThreadAlreadyBoundError(err.incidentId);
    throw err;
  }
}
