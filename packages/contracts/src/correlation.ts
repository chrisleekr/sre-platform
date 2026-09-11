export const EPISODE_GROUPING_WINDOW_DEFAULT_SEC = 5 * 60;
export const EPISODE_GROUPING_WINDOW_MIN_SEC = 5 * 60;
export const EPISODE_GROUPING_WINDOW_MAX_SEC = 60 * 60;

export const INCIDENT_MAX_AGE_DEFAULT_SEC = 24 * 60 * 60;
export const INCIDENT_MAX_AGE_MIN_SEC = 60 * 60;
export const INCIDENT_MAX_AGE_MAX_SEC = 24 * 60 * 60;

export const INCIDENT_CORRELATION_METHODS = ['new_incident', 'stable_subject_window'] as const;
export type IncidentCorrelationMethod = (typeof INCIDENT_CORRELATION_METHODS)[number];

export const INCIDENT_CORRELATION_FEEDBACK_DECISIONS = ['group', 'separate'] as const;
export type IncidentCorrelationFeedbackDecision =
  (typeof INCIDENT_CORRELATION_FEEDBACK_DECISIONS)[number];

/** Human correction projected into future provider-neutral correlation decisions. */
export interface IncidentCorrelationFeedback {
  decision: IncidentCorrelationFeedbackDecision;
  sourceScopeKeys: string[];
  targetScopeKeys: string[];
  sharedScopeKeys: string[];
}

/** User-configurable safety bounds for automatically grouping alert episodes. */
export interface EpisodeGroupingPolicy {
  groupingWindowSec: number;
  maxIncidentAgeSec: number;
}

export const CAUSAL_DIRECTIONS = ['candidate_caused_this', 'this_caused_candidate'] as const;
export type CausalDirection = (typeof CAUSAL_DIRECTIONS)[number];

/** Evidence-backed causal decision over a server-authorized related-incident candidate. */
export interface CausalFinding {
  candidateRef: number;
  direction: CausalDirection;
  rationale: string;
  confidence: number;
  evidenceIds: string[];
}
