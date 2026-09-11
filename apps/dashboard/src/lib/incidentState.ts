import type { Incident } from './types';
import { investigationRunOutcomeLabel } from './investigationRuns';

/** Current work is independent of an earlier completed assessment.
 * @param incident - Canonical lifecycle, last result and queued work facts.
 */
export function investigationWorkLabel(incident: Incident): string {
  const pending = incident.pendingAutomation;
  if (pending && ['resume', 'triage', 'signal.reassess'].includes(pending.type))
    return pending.status === 'processing'
      ? 'Investigation in progress'
      : pending.type === 'resume'
        ? 'Responder follow-up queued'
        : 'Investigation queued';
  if (incident.investigationStatus === 'gathering') return 'Gathering evidence';
  if (incident.investigationStatus === 'queued') return 'Queued';
  if (incident.latestInvestigationRun?.outcome === 'failed') return 'Latest follow-up failed';
  if (incident.latestInvestigationRun && incident.latestInvestigationRun.outcome !== 'conclusive')
    return `Latest follow-up: ${investigationRunOutcomeLabel(incident.latestInvestigationRun.outcome)}`;
  return incident.investigationStatus === 'assessed' ? 'Assessment ready' : 'Needs human help';
}

/** Investigation progress is separate from the incident's operational lifecycle. */
export function assessmentLabel(
  incident: Pick<Incident, 'investigationStatus'>,
): 'queued' | 'gathering evidence' | 'assessment available' | 'needs human' {
  switch (incident.investigationStatus) {
    case 'degraded':
      return 'needs human';
    case 'gathering':
      return 'gathering evidence';
    case 'assessed':
      return 'assessment available';
    case 'queued':
      return 'queued';
  }
}
