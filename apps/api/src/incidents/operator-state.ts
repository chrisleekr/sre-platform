import { investigationFailureSummary } from '@sre/contracts';
import type { IncidentDetail } from '@sre/db';

export interface NextAutomation {
  description: string;
  scheduledAt: string | null;
}

type OperatorIncidentState = Pick<
  IncidentDetail,
  | 'operatorDecision'
  | 'attentionReason'
  | 'latestInvestigationRun'
  | 'nextStep'
  | 'pendingAutomation'
  | 'recoveryNextCheckAt'
  | 'recoveryNextStep'
  | 'recoveryState'
  | 'requiresHumanAttention'
>;

function nextAutomation(incident: OperatorIncidentState): NextAutomation | null {
  // Only a durable job row or a scheduled recovery check is automation. Investigation and recovery
  // statuses can outlive a failed or reaped job, so they do not imply work.
  if (incident.pendingAutomation) {
    const queued = incident.pendingAutomation.status === 'queued';
    const descriptions: Record<string, [queued: string, processing: string]> = {
      triage: [
        'Start the queued investigation',
        'Complete the investigation recorded as processing',
      ],
      'signal.reassess': [
        'Reassess changed provider signals',
        'Complete the signal reassessment recorded as processing',
      ],
      resume: [
        'Answer the responder follow-up',
        'Complete the responder follow-up recorded as processing',
      ],
      'recovery.verify': [
        'Verify recovery evidence',
        'Complete the recovery check recorded as processing',
      ],
    };
    const [queuedDescription, processingDescription] = descriptions[
      incident.pendingAutomation.type
    ] ?? ['Continue queued automation', 'Complete automation recorded as processing'];
    return {
      description: queued ? queuedDescription : processingDescription,
      // available_at of a processing job is when it became runnable, not a future schedule.
      scheduledAt: queued ? incident.pendingAutomation.scheduledAt : null,
    };
  }
  if (incident.recoveryState === 'monitoring' && incident.recoveryNextCheckAt) {
    return {
      description: 'Recheck recovery evidence',
      scheduledAt: incident.recoveryNextCheckAt.toISOString(),
    };
  }
  return null;
}

/** Active incident signals beside the advisory Slack recovery reports linked to them. */
export interface ProviderRecoveryContext {
  signals: Array<{ id: string; state: string }>;
  reportedSignalIds: string[];
}

function providerReportedRecovery(recovery: ProviderRecoveryContext | undefined): boolean {
  const active = recovery?.signals.filter((signal) => signal.state !== 'resolved') ?? [];
  const reported = new Set(recovery?.reportedSignalIds);
  return active.length > 0 && active.every((signal) => reported.has(signal.id));
}

function requiredDecision(
  incident: OperatorIncidentState,
  recovery: ProviderRecoveryContext | undefined,
): string {
  if (incident.attentionReason === 'approval_pending')
    return 'Approve or deny the pending proposed action.';
  // Slack text cannot clear a signal, so a reported recovery still needs an operator decision.
  if (providerReportedRecovery(recovery))
    return 'Provider reported recovery in Slack. Confirm resolution.';
  switch (incident.attentionReason) {
    case 'investigation_degraded':
    case 'investigation_failed':
      return investigationFailureSummary(incident.latestInvestigationRun?.summary) ===
        'AI provider rate limit reached.'
        ? 'AI provider rate limit reached. Check the provider account limit, then retry when ready or investigate manually.'
        : 'Investigate manually or retry after the investigation blocker is cleared.';
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
    case 'operator_decision':
      return (
        incident.operatorDecision ?? 'Review the incident and decide the next response action.'
      );
    case 'automation_missing':
      return 'No automation is recorded. Continue the investigation or choose the next response action.';
    case 'severity_requires_human':
      return 'Review the high-severity incident and decide the next response action.';
    default:
      return 'Review the incident and decide the next response action.';
  }
}

/**
 * Derives the responder decision and automation handoff from canonical incident state.
 * @param incident - Canonical incident attention and automation state.
 * @param owners - Owning service teams.
 * @param recovery - Incident signals and the advisory Slack recovery reports linked to them.
 */
export function incidentOperatorState(
  incident: OperatorIncidentState,
  owners: string[],
  recovery?: ProviderRecoveryContext,
) {
  const automation = nextAutomation(incident);
  return {
    attention: incident.requiresHumanAttention
      ? {
          decision: requiredDecision(incident, recovery),
          owner: owners.length > 0 ? owners.join(', ') : null,
          nextAutomation: automation,
        }
      : null,
    automation,
  };
}
