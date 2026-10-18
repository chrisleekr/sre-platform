export const INVESTIGATION_EVIDENCE_KINDS = [
  'runtime_identity',
  'runtime_state',
  'runtime_configuration',
  'deployment_as_of',
  'source_repository',
  'source_revision',
  'source_location',
  'logs',
  'metrics',
  'topology',
  'provider_history',
] as const;

export type InvestigationEvidenceKind = (typeof INVESTIGATION_EVIDENCE_KINDS)[number];

export const INVESTIGATION_GAP_CATEGORIES = [
  'observable',
  'partial_evidence',
  'missing_capability',
  'historical_gap',
  'contradictory_evidence',
  'operator_decision',
] as const;

export type InvestigationGapCategory = (typeof INVESTIGATION_GAP_CATEGORIES)[number];

export const INVESTIGATION_RUN_OUTCOMES = [
  'conclusive',
  'inconclusive',
  'blocked_missing_capability',
  'budget_exhausted',
  'failed',
] as const;

export type InvestigationRunOutcome = (typeof INVESTIGATION_RUN_OUTCOMES)[number];

export const INCIDENT_FINDING_PROMOTIONS = [
  'trusted_assessment',
  'conversation_only',
  'not_promoted',
] as const;

export type IncidentFindingPromotion = (typeof INCIDENT_FINDING_PROMOTIONS)[number];

export const INCIDENT_FINDING_PROMOTION_REASONS = [
  'conclusive_assessment',
  'responder_reply',
  'terminal_incident',
  'investigation_inconclusive',
  'missing_capability',
  'stale_evidence',
  'state_changed',
  'investigation_failed',
  'budget_exhausted',
] as const;

export type IncidentFindingPromotionReason = (typeof INCIDENT_FINDING_PROMOTION_REASONS)[number];

/**
 * A provider web page for an entity named in a finding, such as a commit or an Argo CD application.
 * Built by the platform from provider API fields, never from model text, so a model cannot plant a
 * link in a responder channel.
 */
export interface FindingLink {
  /** What the page is for, so a surface never infers it from the label's shape. */
  kind: 'commit' | 'application';
  /** Exact token a surface may link in place, such as a short commit SHA or an application name. */
  label: string;
  /** Absolute https URL on the provider. */
  url: string;
}

/** A mention a surface can replace with a link; `start` and `end` cover its backticks when it is a whole code span. */
export interface LinkableMention {
  token: string;
  start: number;
  end: number;
}

// A lowercase SHA prefix of 7 to 40 characters on its own: not part of a longer word, not inside a
// link or URL path, and not a URL query or fragment value.
const SHA_MENTION = '(?<![\\w/|=?#&-])[0-9a-f]{7,40}(?![\\w/-])';

/**
 * Finds the mentions a surface can link, so the commits the platform picks are the ones Slack shows.
 * @param text - Text to search, before or after Slack escaping; neither changes backticks.
 * @param pattern - Global pattern for the token; defaults to a commit SHA prefix.
 */
export function linkableMentions(
  text: string,
  pattern = new RegExp(SHA_MENTION, 'g'),
): LinkableMention[] {
  // Slack does not format inside code, so a mention in a code span counts only when it is the
  // whole span, and then the span, backticks included, is what the link replaces. Inline code
  // never crosses a line, so a clipped line with an odd backtick cannot pair with the next one.
  const spans = [...text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map(
    (span) => [span.index, span.index + span[0].length] as const,
  );
  const mentions: LinkableMention[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const span = spans.find(([from, to]) => start >= from && end <= to);
    if (!span) mentions.push({ token: match[0], start, end });
    else if (span[0] === start - 1 && span[1] === end + 1)
      mentions.push({ token: match[0], start: start - 1, end: end + 1 });
  }
  return mentions;
}

/** Durable provenance for an evidence-bearing conclusion in the incident conversation. */
export interface IncidentFindingPayload {
  runId: string | null;
  outcome: InvestigationRunOutcome;
  promotion: IncidentFindingPromotion;
  promotionReason: IncidentFindingPromotionReason;
  evidenceIds: string[];
  currentState: string | null;
  impact: string | null;
  nextStep: string | null;
  /** Open checks named by the evidence reviewer for an unverified result; absent when none. */
  gaps?: string[];
  /** Leading hypothesis in one sentence. Trusted only when `promotion` is `trusted_assessment`. */
  likelyCause?: string;
  /** Provider pages for entities the finding names; absent when none. */
  links?: FindingLink[];
}

export const INCIDENT_FEEDBACK_TARGETS = ['finding', 'entity', 'correlation', 'noise'] as const;
export type IncidentFeedbackTarget = (typeof INCIDENT_FEEDBACK_TARGETS)[number];

export const INCIDENT_FEEDBACK_DECISIONS = [
  'confirm',
  'correct',
  'group',
  'separate',
  'noise',
  'not_noise',
] as const;
export type IncidentFeedbackDecision = (typeof INCIDENT_FEEDBACK_DECISIONS)[number];

/** Append-only responder verdict used by incident views and later accuracy/toil analytics. */
export interface IncidentFeedbackRecord {
  id: string;
  incidentId: string;
  targetType: IncidentFeedbackTarget;
  targetId: string;
  decision: IncidentFeedbackDecision;
  rationale: string;
  correction: Record<string, unknown> | null;
  createdByUserId: string;
  createdAt: string;
}

export const INVESTIGATION_OPERATIONS = [
  'investigate',
  'reassess',
  'resume',
  'verify-recovery',
] as const;

export type InvestigationOperation = (typeof INVESTIGATION_OPERATIONS)[number];

export const INVESTIGATION_TRIGGER_REASONS = [
  'new_episode',
  'state_transition',
  'material_change',
  'unchanged_renotification',
  'human_continuation',
  'recovery_verification',
  'manual_investigation',
] as const;

export type InvestigationTriggerReason = (typeof INVESTIGATION_TRIGGER_REASONS)[number];

export interface InvestigationSignalChange {
  signalId: string;
  signalVersion: number;
  triggerReason: InvestigationTriggerReason;
}

export interface InvestigationTrigger {
  reason: InvestigationTriggerReason;
  automatic: boolean;
  /** Singular compatibility projection. Null when the run spans no monitor or several monitors. */
  monitorKey: string | null;
  /** Every provider-neutral monitor scope charged by this automatic run. */
  monitorKeys?: string[];
}

export interface AutomaticInvestigationBudgetLimits {
  tenantRunLimit: number;
  monitorRunLimit: number;
  tenantConfiguredCostLimitUsd: number;
  monitorConfiguredCostLimitUsd: number;
  configuredCostReady: boolean;
}

export type InvestigationBudgetExhaustion =
  | 'incident_run_pending'
  | 'configured_cost_unavailable'
  | 'tenant_run_limit'
  | 'monitor_run_limit'
  | 'tenant_configured_cost_limit'
  | 'monitor_configured_cost_limit'
  | 'tenant_configured_cost_pending'
  | 'monitor_configured_cost_pending'
  | 'tenant_missing_usage'
  | 'monitor_missing_usage'
  | 'tenant_unpriced_usage'
  | 'monitor_unpriced_usage';

export interface InvestigationBudgetScopeSnapshot {
  runs: number;
  configuredCostUsd: number;
  pendingCostRuns: number;
  missingUsageRuns: number;
  unpricedRuns: number;
  runLimit: number;
  configuredCostLimitUsd: number;
}

export interface InvestigationMonitorBudgetSnapshot extends InvestigationBudgetScopeSnapshot {
  monitorKey: string;
}

export interface InvestigationBudgetSnapshot {
  windowHours: 24;
  tenant: InvestigationBudgetScopeSnapshot;
  monitors: InvestigationMonitorBudgetSnapshot[];
  exhaustedBy: InvestigationBudgetExhaustion[];
}

/**
 * One material question left by an assessment. `observable` means the platform should attempt a
 * bounded automatic check before accepting the assessment. Every other category explains why the
 * question cannot be closed by another ordinary evidence read.
 */
export interface InvestigationGap {
  question: string;
  category: InvestigationGapCategory;
  evidenceKind: InvestigationEvidenceKind | null;
  attemptedEvidenceIds: string[];
}

/** A recovery question separates current resolution blockers from later prevention work. */
export interface RecoveryQuestion extends InvestigationGap {
  resolutionRelevance: 'blocking' | 'follow_up';
  nextAction: string;
}

/**
 * Prefix of the server-set origin id on a dashboard Retry investigation message. The worker keys on
 * it, never on the message text, so a responder typing the same words still goes through intent
 * classification.
 */
export const INVESTIGATION_RETRY_ORIGIN_PREFIX = 'dashboard-investigation-retry:';
