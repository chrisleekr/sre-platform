import type { Incident } from './types';
import { formatAbsoluteTime } from './time';

/** Preview current citations, or disclose recent checks when none are cited. */
export function incidentEvidencePreview(
  incident: Incident,
  recoveryIsCurrent: boolean,
  recentIds: string[],
) {
  const citations = recoveryIsCurrent
    ? incident.recoveryEvidenceIds
    : incident.assessmentEvidenceIds;
  const cited = Boolean(citations?.length);
  return { cited, ids: [...new Set(cited ? citations : recentIds)].slice(0, 3) };
}

/** Current work is independent of an earlier completed assessment.
 * @param incident - Canonical lifecycle, last result and queued work facts.
 */
export function investigationWorkLabel(incident: Incident): string {
  const pending = incident.pendingAutomation;
  if (pending)
    return pending.status === 'processing'
      ? `${pending.type === 'recovery.verify' ? 'Recovery check' : 'Investigation'} recorded as processing`
      : pending.type === 'resume'
        ? 'Responder follow-up queued'
        : `${pending.type === 'recovery.verify' ? 'Recovery check' : 'Investigation'} queued`;
  if (incident.recoveryState === 'monitoring' && incident.recoveryNextCheckAt) {
    const at = Date.parse(incident.recoveryNextCheckAt);
    if (Number.isFinite(at))
      return at <= Date.now()
        ? 'Scheduled recovery check overdue; execution not confirmed'
        : `Next recovery check scheduled ${formatAbsoluteTime(incident.recoveryNextCheckAt)}`;
  }
  return 'No active automation recorded';
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
