import type { SurfaceSummary } from '../../lib/surfaces';
const CLASSIFICATION_ENQUEUE_OUTCOMES = new Set([
  'classify_enqueued',
  'mention_enqueued',
  'edit_enqueued',
]);

interface InboundOutcomePresentation {
  label: string;
  detail: string;
  tone: 'neutral' | 'warning' | 'critical';
}

export function inboundOutcomePresentation(
  latest: NonNullable<NonNullable<SurfaceSummary['runtime']>['inbound']>['latest'],
): InboundOutcomePresentation {
  if (!latest) {
    return { label: 'No activity', detail: 'No inbound event has been recorded.', tone: 'neutral' };
  }
  if (latest.jobStatus === 'dead') {
    return {
      label: 'Delivery failed',
      detail: `Stopped after ${latest.attemptCount} attempts${latest.errorCode ? `: ${latest.errorCode.replaceAll('_', ' ')}` : '.'}`,
      tone: 'critical',
    };
  }
  if (
    !latest.outcome &&
    !latest.classificationOutcome &&
    !latest.terminalDisposition &&
    (latest.state === 'queued' || latest.state === 'processing')
  ) {
    return {
      label: latest.state === 'queued' ? 'Message queued' : 'Processing message',
      detail: 'Accepted, but no processing outcome has been recorded yet.',
      tone: 'warning',
    };
  }
  const classificationPending =
    latest.outcome !== null &&
    CLASSIFICATION_ENQUEUE_OUTCOMES.has(latest.outcome) &&
    !latest.terminalDisposition &&
    (latest.classificationOutcome === null || latest.classificationOutcome === 'retry');
  if (classificationPending) {
    return {
      label: 'Classification queued',
      detail: 'Accepted and waiting for the incident classifier.',
      tone: 'warning',
    };
  }
  const outcome =
    latest.terminalDisposition ?? latest.classificationOutcome ?? latest.outcome ?? latest.state;
  const known: Record<string, InboundOutcomePresentation> = {
    provider_alert_opened: {
      label: 'Incident opened',
      detail: 'The provider alert started an investigation.',
      tone: 'neutral',
    },
    new_incident: {
      label: 'Incident opened',
      detail: 'The message started an investigation.',
      tone: 'neutral',
    },
    mention_new_incident: {
      label: 'Incident opened',
      detail: 'The responder request started an investigation.',
      tone: 'neutral',
    },
    belongs_to: {
      label: 'Added to an incident',
      detail: 'The message was correlated with an existing investigation.',
      tone: 'neutral',
    },
    mention_belongs_to: {
      label: 'Added to an incident',
      detail: 'The responder request was correlated with an existing investigation.',
      tone: 'neutral',
    },
    not_worthy: {
      label: 'Recorded, no investigation',
      detail: 'The classifier found no incident response was required.',
      tone: 'neutral',
    },
    dropped_untracked_edit: {
      label: 'Edit ignored',
      detail: 'The edited Slack message is not attached to a tracked incident.',
      tone: 'neutral',
    },
    edited_untracked: {
      label: 'Edit ignored',
      detail: 'The edited Slack message is not attached to a tracked incident.',
      tone: 'neutral',
    },
    resolution_unmatched: {
      label: 'Resolution not matched',
      detail: 'The resolution could not be linked to an active provider signal.',
      tone: 'warning',
    },
    resume_enqueued: {
      label: 'Responder request queued',
      detail: 'The thread message was accepted for the active investigation.',
      tone: 'neutral',
    },
    interaction_processed: {
      label: 'Interaction processed',
      detail: 'The Slack action was applied to its incident.',
      tone: 'neutral',
    },
    reopened: {
      label: 'Incident reopened',
      detail: 'New provider evidence reopened the investigation.',
      tone: 'warning',
    },
    dropped_no_candidate: {
      label: 'No incident action',
      detail: 'The event did not match an incident-opening signal, tracked thread, or interaction.',
      tone: 'neutral',
    },
    dropped_unauthorized: {
      label: 'Interaction rejected',
      detail: 'The Slack identity is not authorized to act on the incident.',
      tone: 'warning',
    },
    dropped_unsubscribed: {
      label: 'Channel not subscribed',
      detail: 'The event came from a channel that is not enabled for incident intake.',
      tone: 'warning',
    },
    dropped_duplicate: {
      label: 'Duplicate ignored',
      detail: 'This event was already recorded.',
      tone: 'neutral',
    },
    dropped_archived: {
      label: 'Deleted incident ignored',
      detail: 'The event belongs to an incident that is no longer available.',
      tone: 'neutral',
    },
    dropped_mention_twin: {
      label: 'Duplicate mention ignored',
      detail: 'The same responder mention was already accepted.',
      tone: 'neutral',
    },
    suppressed_provider_control_notification: {
      label: 'Control notification suppressed',
      detail: 'The adapter identified a non-actionable provider control notification.',
      tone: 'neutral',
    },
    superseded: {
      label: 'Classification superseded',
      detail: 'A newer adapter decision stopped classification before incident routing.',
      tone: 'neutral',
    },
    dropped_untracked_thread: {
      label: 'Untracked thread ignored',
      detail: 'The reply is not inside a thread attached to an incident.',
      tone: 'neutral',
    },
    dropped_unsupported_envelope: {
      label: 'Unsupported Slack event',
      detail: 'The Socket Mode envelope type is not supported for incident intake.',
      tone: 'warning',
    },
    processing_failed: {
      label: 'Retrying delivery',
      detail: `Attempt ${latest.attemptCount}${latest.errorCode ? `: ${latest.errorCode.replaceAll('_', ' ')}` : ''}`,
      tone: 'warning',
    },
  };
  return (
    known[outcome] ?? {
      label: 'Processed',
      detail: `Recorded outcome: ${outcome.replaceAll('_', ' ')}.`,
      tone: latest.state === 'retrying' ? 'warning' : 'neutral',
    }
  );
}
