export const INBOUND_SURFACE_IDS = ['slack'] as const;
export type InboundSurface = (typeof INBOUND_SURFACE_IDS)[number];

/**
 * Inbound connector port. An inbound connector normalizes a surface's raw event
 * (Slack message, etc.) into a candidate the relevance classifier and triage job
 * consume. Distinct from IDataSourceConnector, which pulls alert/metric data out.
 */

export interface InboundCandidate {
  /**
   * Discriminant for the classify-queue union. Absent (or `'root'`) marks a root/push channel message
   * the relevance-classifier path. A `MentionCandidate` tags `'mention'` for the human pull path.
   */
  kind?: 'root';
  /** Durable surface receipt that accepted this event, used to record its latest classify outcome. */
  intakeId?: string;
  /** Surface-native message id (Slack `ts`). Immutable; part of the idempotency key. */
  externalId: string;
  /** Surface channel id the message arrived on. */
  channel: string;
  /** `bot` if any automated poster (including alerting bots), else `human`. */
  author: 'human' | 'bot';
  /** Authenticated Slack producer identity used to bind a separate resolution to the same bot/user. */
  producerId?: string;
  /** Trimmed message text. */
  text: string;
  /** Opaque original event, forwarded unchanged to the classifier and triage job. */
  raw: unknown;
  /** Monitoring state observed in this message. `updated` is represented by isEdit, not as a state. */
  signalState: 'firing' | 'unknown' | 'resolved';
  /** Adapter-recognized provider notification shape used by policy fences, never as source authorization. */
  alertKind?: 'firing';
  /** Stable identity of this observation; an edit includes its edit timestamp. */
  eventKey: string;
  /** Exact provider ordering value. Decimal microseconds since epoch for Slack. */
  eventVersion?: string;
  eventAt: string;
  contentHash: string;
  isEdit: boolean;
  /** Provider observations carried by one surface message. Grouped notifications keep each condition
   * distinct so lifecycle does not collapse several alerts into one synthetic signal. */
  observations?: InboundObservation[];
}

export const INBOUND_SUPPRESSION_REASONS = ['provider_control_notification'] as const;
export type InboundSuppressionReason = (typeof INBOUND_SUPPRESSION_REASONS)[number];

/** Provider-neutral result of normalizing and admitting one inbound event. */
export type InboundEvaluation =
  | { disposition: 'admit'; candidate: InboundCandidate }
  | {
      disposition: 'suppress';
      reason: InboundSuppressionReason;
      /** Stable surface identity retained so pending work and prior false admissions can be retired. */
      candidate: InboundCandidate;
    };

export interface InboundObservation {
  externalMessageId: string;
  state: 'firing' | 'unknown' | 'resolved';
  summary: string;
  contentHash: string;
  eventKey: string;
  /** Exact provider ordering value inherited from the containing surface event. */
  eventVersion?: string;
  eventAt: string;
  provider?: string;
  /** Stable provider-owned group identity shared by firing and resolved notifications. */
  providerGroupKey?: string;
  /** Provider-neutral scope used to recognize a continuing notification without native episode ids. */
  monitorKey?: string;
  alertName?: string;
  /** Hash of investigation-relevant fields after volatile observation values are normalized. */
  materialHash?: string;
}

/**
 * A human @-mention of the bot: the PULL path. Unlike a root push candidate this BYPASSES the
 * worthy classifier (a human is the gate). The incident is keyed on `channel:rootTs`; the consumer
 * reads the whole thread and seeds the incident from it. `rootTs` is the thread root (`thread_ts` for
 * a reply, else the message's own `ts`); `ts` is this message's own id, used for delivery idempotency.
 */
export interface MentionCandidate {
  kind: 'mention';
  /** Durable surface receipt that accepted this event, used to record its latest classify outcome. */
  intakeId?: string;
  /** Stable provider event identity used by the durable classify queue. */
  eventKey: string;
  channel: string;
  rootTs: string;
  ts: string;
  user: string;
  text: string;
  raw: unknown;
}

/** The classify stream carries either a root push candidate or a human mention. */
export type ClassifyCandidate = InboundCandidate | MentionCandidate;

export interface InboundContext {
  /**
   * Our own bot's user id (Slack `U…`). Matches `event.user` on posts we make via the Web API
   * (chat.postMessage attributes the message to the bot user). It distinguishes a same-app root alert
   * as automated; platform replies are excluded structurally by their `thread_ts`.
   */
  botUserId: string;
}

export interface IInboundConnector<TSurface extends string = string> {
  /** Surface key, e.g. 'slack'. */
  readonly surface: TSurface;
  /** Normalize and admit an inner surface event, or return null when the adapter does not own it. */
  evaluate(event: unknown, ctx: InboundContext): InboundEvaluation | null;
}
