import type { IncidentSignal, RouteResult } from '@sre/alerts';
import type { InboundCandidate } from '@sre/connectors';
import type {
  AffectedEntityCandidate,
  InvestigationTriggerReason,
  SignalSource,
} from '@sre/contracts';
import type { Db, Embedder, IncidentSummary, SurfaceInboundRoutingFenceResult, Tx } from '@sre/db';
import type { HubMessage, NewMessage } from '@sre/hub';
import type { Queue } from '@sre/queue';
import type { ThreadMessage } from '@sre/surfaces';
import type { Redis } from 'ioredis';
import type { Classifier } from '../engine/classify';
import type { CorrelationVerdict, ResolutionCandidate } from '../engine/correlation';
import type { StructuredGenerator } from '../engine/types';
import type { LlmRuntimeManager } from '../llm-runtime';

export const CLASSIFY_FAIL_OPEN_ATTEMPTS = 5;
export const DEGRADED_SEVERITY = 'sev3';
export const INBOUND_DEDUP_TTL_SEC = 86_400;
export const CAP_N = Number(process.env.CLASSIFY_CANDIDATE_CAP ?? 25);
export const RETRIEVE_K = Number(process.env.CLASSIFY_RETRIEVE_K ?? 10);
export const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type AuthorizedResolutionCandidate = ResolutionCandidate & { lastEventKey: string };
export type SignalGroupTarget = Pick<
  AuthorizedResolutionCandidate,
  'incidentId' | 'channel' | 'externalMessageId'
>;
export type RouteFn = (signal: IncidentSignal) => Promise<RouteResult>;

export interface ThreadReader {
  readThread(tenantId: string, channel: string, rootTs: string): Promise<ThreadMessage[]>;
}

export interface HubLike {
  appendTxOnce?(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    msg: NewMessage,
  ): Promise<{ message: HubMessage; inserted: boolean }>;
  append(tenantId: string, incidentId: string, msg: NewMessage): Promise<{ id: string }>;
  appendOnce(
    tenantId: string,
    incidentId: string,
    msg: NewMessage,
  ): Promise<{ message: { id: string; incidentId: string }; inserted: boolean }>;
  observeSignalTx(
    tx: Tx,
    tenantId: string,
    observation: {
      incidentId: string;
      surface: string;
      channel: string;
      externalMessageId: string;
      state: 'firing' | 'unknown' | 'resolved';
      summary: string;
      contentHash: string;
      eventKey: string;
      eventAt: Date;
      eventVersion?: string;
      provider?: string;
      providerGroupKey?: string;
      monitorKey?: string;
      alertName?: string;
      materialHash?: string;
      signalSource?: SignalSource;
      affectedEntities?: AffectedEntityCandidate[];
    },
    content: string,
  ): Promise<{
    observation: {
      applied: boolean;
      allResolved: boolean;
      investigationTriggerReason: InvestigationTriggerReason;
      signal: { id: string; incidentId: string; version: number };
    };
    message: HubMessage | null;
  }>;
  publishAppended(message: HubMessage): Promise<void>;
}

/** Posts a cross-thread pointer when correlation moves a conversation. */
export interface BreadcrumbPoster {
  post(
    tenantId: string,
    thread: { channel: string; threadId: string },
    message: string,
  ): Promise<unknown>;
}

/** Resolves the canonical Slack thread permalink for a breadcrumb. */
export type PermalinkResolver = (
  tenantId: string,
  channel: string,
  threadTs: string,
) => Promise<string | null>;

export type ClassifyOutcome = {
  intakeId?: string;
  tenantId: string;
  channel: string;
  messageId: string;
  author: 'human' | 'bot';
  outcome:
    | CorrelationVerdict['decision']
    | 'retry'
    | 'fail_open'
    | 'mention_belongs_to'
    | 'mention_new_incident'
    | 'resolved_signal'
    | 'resolution_duplicate'
    | 'resolution_stale'
    | 'edited_signal'
    | 'edited_untracked'
    | 'resolution_unmatched'
    | 'provider_alert_opened'
    | 'ticket'
    | 'log'
    | 'superseded';
  attempts: number;
  reason?: 'provider_unavailable' | 'classifier_error';
};

/** Dependencies for Slack classification and incident correlation. */
export interface ClassifyHandlerDeps {
  llm?: LlmRuntimeManager;
  classify?: Classifier;
  appDb: Db;
  redis: Redis;
  /** Fail-fast Valkey handle for advisory reservation writes after durable routing completes. */
  reservationRedis: Redis;
  queue: Queue;
  embedder: Embedder;
  route?: RouteFn;
  hub?: HubLike;
  threadReader?: ThreadReader;
  generator?: StructuredGenerator;
  /** Enables the durable semantic disposition path; omitted by legacy-compatible tests. */
  semanticDispositionEnabled?: boolean;
  poster?: BreadcrumbPoster;
  resolvePermalink?: PermalinkResolver;
  /** Cost-saving read before model work; the routing fence remains the correctness boundary. */
  isIntakeSuperseded?: (
    tenantId: string,
    intakeId: string,
    eventAt: Date,
    eventVersion?: string,
  ) => Promise<boolean>;
  /** Durable predecessor lookup used when an edit reaches the worker before its root signal exists. */
  hasPendingClassification?: (
    tenantId: string,
    identity: { surface: string; channel: string; externalMessageId: string },
    excludeIntakeId?: string,
  ) => Promise<boolean>;
  /** Serializes all incident-writing effects against the adapter's stable-message decision. */
  withIntakeRoutingFence?: <T>(
    tenantId: string,
    intakeId: string,
    eventAt: Date,
    eventVersion: string | undefined,
    identity: { surface: string; channel: string; externalMessageId: string },
    fn: () => Promise<T>,
  ) => Promise<SurfaceInboundRoutingFenceResult<T>>;
  onOutcome?: (outcome: ClassifyOutcome) => void | Promise<void>;
}

export interface ResolutionCandidates {
  all: AuthorizedResolutionCandidate[];
  forModel: AuthorizedResolutionCandidate[];
  lookupFailed: boolean;
}

export interface OpenIncidentOptions {
  dedupKey?: string;
  signal?: IncidentSignal['signal'];
  signals?: IncidentSignal['signals'];
  investigationTrigger?: IncidentSignal['investigationTrigger'];
  onRoutedTx?: (
    tx: Tx,
    routed: {
      incidentId: string;
      bindingId: string;
      reused: boolean;
      signalId: string | null;
    },
  ) => Promise<string[]>;
}

export type CandidateList = IncidentSummary[];
export type CandidateSignal = InboundCandidate;
