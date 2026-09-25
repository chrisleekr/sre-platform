const RATE_LIMIT_SUMMARY = 'AI provider rate limit reached.';

/** Returns a safe failure description without exposing provider error payloads.
 * @param summary - Persisted failure summary, never a source of arbitrary display text.
 */
export function investigationFailureSummary(summary: string | null | undefined): string {
  return summary === RATE_LIMIT_SUMMARY ? RATE_LIMIT_SUMMARY : 'Investigation failed.';
}

/** Keeps a completed run's result separate from the incident's trusted assessment.
 * @param run - Completed investigation result whose summary may be displayed.
 */
export function investigationResultSummary(run: {
  outcome: string;
  summary?: string | null;
}): string | null {
  return run.outcome === 'failed'
    ? investigationFailureSummary(run.summary)
    : run.summary?.trim() || null;
}

export type IncidentAttentionReason =
  | 'approval_pending'
  | 'investigation_degraded'
  | 'recovery_not_verified'
  | 'resolution_required'
  | 'manual_review'
  | 'signal_tracking_unavailable'
  | 'mitigation_active'
  | 'investigation_inconclusive'
  | 'investigation_blocked'
  | 'budget_exhausted'
  | 'investigation_failed'
  | 'severity_requires_human'
  | 'operator_decision'
  | 'automation_missing';
