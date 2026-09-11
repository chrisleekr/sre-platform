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
