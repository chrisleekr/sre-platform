import { type Db, type Tx } from '@sre/db';
import type { InvestigationTriggerReason } from '@sre/contracts';
import type { ConversationHub } from '@sre/hub';
import type { Redis } from 'ioredis';

/**
 * Coalescing resume producer, split into a tx half + a post-commit half so the resume job
 * shares the human reply's transaction and rolls back with it on failure — no orphaned reply. The
 * durable partial-unique index folds a second reply that lands while a resume is still queued onto the
 * pending one, so concurrent Slack replies coalesce cleanly instead of unique-violating. Mirrors
 * apps/api/src/surfaces/session.ts; the @sre/queue Queue satisfies it.
 */
export interface ResumeProducer {
  /** Insert the durable resume job on `tx`. Returns the new job id, or null when it coalesced onto an
   * already-pending resume for this incident. */
  insertResumeTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    humanMessageId: string,
  ): Promise<{ jobId: string | null }>;
  /** Post-commit dispatch for a job `insertResumeTx` created. Never call before the tx committed. */
  publishResume(jobId: string): Promise<void>;
  insertRecoveryTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    lifecycleVersion: number,
    signalFence: string,
  ): Promise<{ jobId: string | null }>;
  insertReassessmentTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    signalId: string,
    signalVersion: number,
    triggerReason?: InvestigationTriggerReason,
  ): Promise<{ jobId: string | null }>;
  publishJob(jobId: string): Promise<void>;
}

/** Durable classify producer. PostgreSQL owns idempotency; Valkey is dispatch and ordering cache only. */
export interface ClassifyProducer {
  insertClassify(input: { tenantId: string; type: string; payload: unknown }): Promise<{
    jobId: string;
    inserted: boolean;
    matchedBy: 'intake' | 'event' | null;
  }>;
  insertClassifyTx(
    tx: Tx,
    input: { tenantId: string; type: string; payload: unknown },
  ): Promise<{
    jobId: string;
    inserted: boolean;
    matchedBy: 'intake' | 'event' | null;
  }>;
  publishJob(jobId: string): Promise<void>;
}

export interface SlackInboundDeps {
  /** System connection for global identity and approval lookups after Socket routing. */
  adminDb: Db;
  /** RLS-scoped connection for the tenant-scoped binding lookup. */
  appDb: Db;
  hub: ConversationHub;
  /** Coalescing resume producer: a human reply's resume job shares its tx and coalesces. */
  queue: ResumeProducer;
  /** Durable producer for admitted root, edit, and mention classification work. */
  classifyQueue: ClassifyProducer;
  /** Shared Valkey handle for general Slack delivery state and caches. */
  redis: Redis;
  /** Fail-fast Valkey handle for advisory classification ordering state. */
  reservationRedis: Redis;
  /**
   * Resolve a surface author id (Slack user id) to an email for author auto-attribution. Injected
   * so tests mock it and count calls; omitted disables the users.info lookup (cache-only resolution). The
   * production wiring closes over the tenant's bot token + injected fetch. Returns null on any miss.
   */
  usersInfoEmail?: (tenantId: string, surfaceUserId: string) => Promise<string | null>;
  /** Best-effort sink for post-commit cache, dispatch, and fan-out failures. */
  onError?: (err: unknown, ctx: { configId: string; incidentId?: string }) => void;
}

/** The slice of a Slack Events API callback we consume: a human's free-text thread reply. */
export interface SlackEnvelope {
  type?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel?: string;
    thread_ts?: string;
    ts?: string;
    blocks?: { block_id?: string }[];
    attachments?: SlackAttachment[];
    event_ts?: string;
    edited?: { user?: string; ts?: string };
    message?: {
      type?: string;
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      channel?: string;
      thread_ts?: string;
      ts?: string;
      blocks?: { block_id?: string }[];
      attachments?: SlackAttachment[];
      edited?: { user?: string; ts?: string };
    };
    /** Files the human attached to this message. */
    files?: SlackFile[];
  };
}

export interface SlackAttachment {
  fallback?: string;
  pretext?: string;
  title?: string;
  text?: string;
  fields?: { title?: string; value?: string }[];
}

/** The slice of a Slack file object we record: metadata only, never the bytes. */
export interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  permalink?: string;
}

/** Extract the recordable files off an inbound event (needs an id + a private url); drops the rest. */

export interface SlackInteraction {
  type?: string;
  trigger_id?: string;
  user?: { id?: string; username?: string };
  actions?: { action_id?: string; action_ts?: string; value?: string }[];
}

export interface SlackConfig {
  tenantId: string;
  surface: string;
  /** Our own bot's Slack user id, used to identify and strip @mentions. Coalesced to '' when unset. */
  botUserId: string;
  /** Verified Slack bot identity retained with the routed app configuration. */
  botId?: string;
}

export type SlackProcessorOutcome =
  | 'classify_enqueued'
  | 'mention_enqueued'
  | 'resume_enqueued'
  | 'tag_command_handled'
  | 'interaction_processed'
  | 'edit_enqueued'
  | 'dropped_no_candidate'
  | 'dropped_unauthorized'
  | 'dropped_unsubscribed'
  | 'dropped_duplicate'
  | 'dropped_archived'
  | 'dropped_mention_twin'
  | 'suppressed_provider_control_notification'
  | 'suppressed_native_alert_opener'
  | 'dropped_untracked_edit'
  | 'dropped_untracked_thread';

/**
 * Serialize Slack replies with deletion on the incident row. An archived incident is an internal
 * tombstone, not a standing grant to spend tools and LLM tokens from an old Slack thread.
 */
