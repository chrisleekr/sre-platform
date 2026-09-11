import {
  incidentMessages,
  type IncidentStatus,
  type RecoveryMessagePayload,
  type IncidentFindingPayload,
  type SignalEventType,
  type SignalState,
} from '@sre/db';

export type Author = 'agent' | 'human' | 'system';
export type MessageKind =
  | 'text'
  | 'tool_step'
  | 'finding'
  | 'approval'
  // `status` and `silent` stay in the durable dashboard audit. Author-aware projection decides which
  // replies and findings are useful enough to mirror to headless surfaces.
  | 'status'
  | 'lifecycle'
  | 'signal'
  | 'relationship'
  // A generated postmortem draft is ready. System-authored, mirrored so the incident thread gets the
  // deep link; the surface adapter attaches the URL, the worker never learns the dashboard origin.
  | 'postmortem'
  | 'archive'
  | 'reply'
  | 'clarification_request'
  | 'degraded_reask'
  | 'silent';

/**
 * Decision options a surface renders as buttons for an `'approval'` message. `id` is the
 * `approvals` row PK, the callback key on a tap. Carried transiently on the hub message (the approvals
 * table is the durable source of truth), so it rides the fan-out stream but is not stored on the log row.
 */
export interface ApprovalPayload {
  id: string;
  options: { id: string; label: string }[];
}

export interface NewMessage {
  author: Author;
  kind?: MessageKind;
  content: string;
  /** Concise takeaway a surface may render in place of the full content. Nullable. */
  summary?: string;
  /** Structured recovery facts for native surface tables. */
  recovery?: RecoveryMessagePayload;
  /** Structured finding provenance and promotion decision. */
  finding?: IncidentFindingPayload;
  /** The surface a human reply was typed on ('slack' or 'dashboard'); omitted for agent/system. */
  originSurface?: string;
  /** The platform user this message is attributed to (surface-author resolution). The hub trusts
   * the caller and stores whatever it passes, like `author`; null/omitted when unresolved. */
  authorUserId?: string | null;
  /** For a `kind:'approval'` message: the decision options surfaces render as buttons. */
  approval?: ApprovalPayload;
  /** The durable `approvals` row this message renders (kind='approval' only); persisted so a reload
   * can re-attach `approval` by joining approvals. Null/omitted for every other kind. */
  approvalId?: string | null;
  /**
   * The durable source event for this line (`slack:<channel>:<ts>`, `recovery:<job-id>`, etc.). A unique
   * on (tenant_id, origin_message_id) collapses a redelivered append onto the existing row, so an
   * at-least-once consumer can re-run safely. Omit it for uncoupled agent/system lines.
   */
  originMessageId?: string;
  lifecycleFrom?: IncidentStatus | null;
  lifecycleTo?: IncidentStatus;
  lifecycleVersion?: number;
  transitionKey?: string;
  signalId?: string;
  signalState?: SignalState;
  signalEventType?: SignalEventType;
}

/**
 * Keyset cursor into the canonical conversation: the total-order tuple `(created_at, id)` of a message
 * a caller already holds. `history({ before })` returns rows strictly older than this. created_at is the
 * ISO string from a prior HubMessage; the query parses it back to a Date (the column is timestamptz).
 */
export interface HubCursor {
  createdAt: string;
  id: string;
}

export interface HubMessage {
  id: string;
  incidentId: string;
  author: string;
  kind: string;
  content: string;
  /** Concise takeaway persisted alongside content; null when the author supplied none. */
  summary?: string | null;
  /** Structured recovery facts for native surface tables; null for ordinary messages. */
  recovery?: RecoveryMessagePayload | null;
  /** Structured finding provenance and promotion decision; null for ordinary messages. */
  finding?: IncidentFindingPayload | null;
  /** Origin surface for cross-surface echo-suppression ('slack'/'dashboard'); null for agent/system. */
  originSurface?: string | null;
  /** Platform user the message is attributed to (surface-author resolution); null when unresolved. */
  authorUserId?: string | null;
  /** Transient render-time attribution label (email local-part) for a human reply, stamped by fanout at
   * dispatch and consumed by the Slack render; NOT persisted (like `approval`), so toHubMessage never
   * reads/writes it and a reload does not carry it. Null/omitted when unresolved. */
  authorLabel?: string | null;
  /** Present on a `kind:'approval'` message so posters render buttons. Rides the stream on live append,
   * and is durably re-attached by history() joining the approvals row on reload. */
  approval?: ApprovalPayload;
  /** The linked approvals row id for a kind='approval' message; null for every other kind. */
  approvalId?: string | null;
  /** Durable source event id used for idempotency and dashboard audit grouping. */
  originMessageId?: string | null;
  lifecycleFrom?: string | null;
  lifecycleTo?: string | null;
  lifecycleVersion?: number | null;
  transitionKey?: string | null;
  signalId?: string | null;
  signalState?: string | null;
  signalEventType?: string | null;
  createdAt: string;
}

/**
 * Returns the Valkey stream channel for an incident.
 *
 * @param incidentId - Incident whose stream is addressed.
 */
export function channel(incidentId: string): string {
  return `hub:${incidentId}`;
}

/**
 * Maps a persisted message to the hub contract. Approval details are joined separately.
 *
 * @param r - Persisted incident message row.
 */
export function toHubMessage(r: typeof incidentMessages.$inferSelect): HubMessage {
  return {
    id: r.id,
    incidentId: r.incidentId,
    author: r.author,
    kind: r.kind,
    content: r.content,
    summary: r.summary,
    recovery: r.recovery,
    finding: r.finding,
    originSurface: r.originSurface,
    authorUserId: r.authorUserId,
    approvalId: r.approvalId,
    originMessageId: r.originMessageId,
    lifecycleFrom: r.lifecycleFrom,
    lifecycleTo: r.lifecycleTo,
    lifecycleVersion: r.lifecycleVersion,
    transitionKey: r.transitionKey,
    signalId: r.signalId,
    signalState: r.signalState,
    signalEventType: r.signalEventType,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Message kinds eligible for the durable headless-surface fan-out stream. Authorship policy further
 * narrows these kinds so engine narration and tool activity remain dashboard-only.
 */
export const SURFACE_STREAM = 'sre:surface';
export const SURFACE_MIRRORED_KINDS: ReadonlySet<string> = new Set([
  'text',
  'tool_step',
  'reply',
  'clarification_request',
  'degraded_reask',
  'finding',
  'silent',
  'approval',
  'lifecycle',
  'relationship',
  'postmortem',
]);
export const SURFACE_STREAM_MAXLEN = 10_000;

/**
 * Keeps progress narration in the dashboard while mirroring conclusions and human turns.
 *
 * @param message - Hub message authorship and kind used by the projection policy.
 */
export function shouldMirrorToSurfaces(
  message: Pick<HubMessage, 'author' | 'kind' | 'finding'>,
): boolean {
  if (!SURFACE_MIRRORED_KINDS.has(message.kind)) return false;
  if (
    message.finding &&
    (['stale_evidence', 'state_changed'].includes(message.finding.promotionReason) ||
      (message.finding.promotionReason === 'investigation_inconclusive' &&
        !message.finding.nextStep))
  )
    return false;
  if (message.author === 'agent' && ['text', 'tool_step', 'silent'].includes(message.kind))
    return false;
  if (message.author === 'system' && message.kind === 'text') return false;
  return true;
}
