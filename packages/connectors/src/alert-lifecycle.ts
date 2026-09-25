/** Provider-owned evidence. Receipt authentication and connector generation are fenced by callers. */
export interface AlertLifecycleObservation {
  provider: 'alertmanager' | 'statuscake' | 'datadog' | 'grafana';
  status: 'firing' | 'resolved';
  fingerprint: string;
  monitorIdentity: string;
  startsAt: Date | null;
  /** Opaque provider cycle identity when a recovery can precede its trigger. */
  episodeKey?: string;
  /** A repeat firing notice. startsAt is when it repeated, so it never opens or dates a cycle. */
  repeatedTrigger?: boolean;
  endsAt: Date | null;
  alertName: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  generatorUrl: string | null;
}

export type AlertLifecycleResult =
  | { status: 'verified'; observations: AlertLifecycleObservation[] }
  | { status: 'unverified'; reason: string }
  /** A well-formed provider event this platform deliberately does not act on. */
  | { status: 'ignored'; reason: string };

/** An explicit provider identity and episode, never inferred from a URL or notification title. */
export interface AlertLifecycleQuery {
  monitorId: string;
  scope?: string;
  /** Operator-declared native association; authenticated delivery must confirm this cycle. */
  cycleKey?: string;
  family?: string;
  startsAt?: Date;
  /** Legacy reconciliation must identify the outage covering this timestamp. */
  observedAt: Date;
}

/** Which provider monitor a notification subject names. Selection only: it grants no lifecycle
 * authority, so a match must still be confirmed by an exact `readEpisode`. */
export type AlertLifecycleSubjectMatch =
  | { status: 'matched'; monitorId: string; family: string }
  | {
      status: 'unmatched';
      reason:
        | 'no_matching_monitor'
        | 'ambiguous_monitor'
        | 'unsupported_subject'
        | 'inventory_unavailable';
    };

export interface AlertLifecycle {
  normalizeEvent?(payload: unknown): AlertLifecycleResult | Promise<AlertLifecycleResult>;
  readEpisode?(query: AlertLifecycleQuery): Promise<AlertLifecycleResult>;
  /** Resolves a presentation group key to exactly one provider monitor, or reports why it cannot. */
  monitorForSubject?(groupKey: string): Promise<AlertLifecycleSubjectMatch>;
}
