import type { IncidentDetail } from '@sre/db';

export interface NextAutomation {
  description: string;
  scheduledAt: string | null;
}

type OperatorIncidentState = Pick<
  IncidentDetail,
  | 'attentionReason'
  | 'investigationStatus'
  | 'latestInvestigationRun'
  | 'nextStep'
  | 'pendingAutomation'
  | 'recoveryNextCheckAt'
  | 'recoveryNextStep'
  | 'recoveryState'
  | 'requiresHumanAttention'
>;

function nextAutomation(incident: OperatorIncidentState): NextAutomation | null {
  if (incident.pendingAutomation) {
    const descriptions: Record<string, string> = {
      triage: 'Start the queued investigation',
      'signal.reassess': 'Reassess changed provider signals',
      resume: 'Answer the responder follow-up',
      'recovery.verify': 'Verify recovery evidence',
    };
    return {
      description: descriptions[incident.pendingAutomation.type] ?? 'Continue queued automation',
      scheduledAt:
        incident.pendingAutomation.status === 'queued'
          ? incident.pendingAutomation.scheduledAt
          : null,
    };
  }
  if (incident.recoveryState === 'monitoring' && incident.recoveryNextCheckAt) {
    return {
      description: 'Recheck recovery evidence',
      scheduledAt: incident.recoveryNextCheckAt.toISOString(),
    };
  }
  if (incident.recoveryState === 'verifying') {
    return { description: 'Verify recovery evidence', scheduledAt: null };
  }
  if (incident.investigationStatus === 'queued') {
    return { description: 'Start the queued investigation', scheduledAt: null };
  }
  if (incident.investigationStatus === 'gathering') {
    return { description: 'Continue gathering evidence', scheduledAt: null };
  }
  return null;
}

function requiredDecision(incident: OperatorIncidentState): string {
  switch (incident.attentionReason) {
    case 'approval_pending':
      return 'Approve or deny the pending proposed action.';
    case 'investigation_degraded':
    case 'investigation_failed':
      return 'Investigate manually or retry after the investigation blocker is cleared.';
    case 'investigation_inconclusive':
      return (
        incident.latestInvestigationRun?.nextStep ??
        'Choose the next diagnostic check or provide missing context.'
      );
    case 'investigation_blocked':
      return (
        incident.latestInvestigationRun?.nextStep ??
        'Provide the missing connector capability or investigate manually.'
      );
    case 'budget_exhausted':
      return 'Continue manually now, or wait for the rolling automatic budget to recover.';
    case 'recovery_not_verified':
      return incident.recoveryNextStep ?? 'Review the remaining recovery uncertainty.';
    case 'resolution_required':
      return 'Resolve the incident if the verified recovery matches the provider state.';
    case 'manual_review':
      return 'Confirm the assessment and resolve, mitigate, or continue the investigation.';
    case 'signal_tracking_unavailable':
      return 'Restore provider signal tracking or correct the recorded signal state.';
    case 'mitigation_active':
      return 'Confirm mitigation effectiveness, then resolve or reopen the incident.';
    case 'severity_requires_human':
      return 'Review the high-severity incident and decide the next response action.';
    default:
      return 'Review the incident and decide the next response action.';
  }
}

/** Derives the responder decision and automation handoff from canonical incident state. */
export function incidentOperatorState(incident: OperatorIncidentState, owners: string[]) {
  const automation = nextAutomation(incident);
  return {
    attention: incident.requiresHumanAttention
      ? {
          decision: requiredDecision(incident),
          owner: owners.length > 0 ? owners.join(', ') : null,
          nextAutomation: automation,
        }
      : null,
    automation,
  };
}
