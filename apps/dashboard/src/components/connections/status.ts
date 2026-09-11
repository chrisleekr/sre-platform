import type { ConnectorSummary } from '../../lib/connectors';
import type { SurfaceSummary } from '../../lib/surfaces';
import { evidenceTime, showsEventSync, textSetting } from '../connectorPresentation';

export interface ConnectionEvidence {
  label: string;
  detail: string;
  attention: boolean;
}

/** Verification is historical evidence, not a claim of current provider health. */
export function accessEvidence(c: ConnectorSummary): ConnectionEvidence {
  const verification = c.verification;
  if (c.capabilities?.configuration === 'builtin')
    return {
      label: c.enabled ? 'Built in' : 'Disabled',
      detail: 'Managed by the platform, no external credentials required.',
      attention: false,
    };
  if (c.credentialConfigured === false)
    return {
      label: 'Credential missing',
      detail: 'Configure access to this tool.',
      attention: true,
    };
  if (verification?.failureCategory)
    return {
      label: 'Verification failed',
      detail: verification.failureCategory.replaceAll('_', ' '),
      attention: true,
    };
  if (verification && !verification.lastSuccessAt)
    return {
      label: 'Not verified',
      detail: 'No successful access check recorded.',
      attention: true,
    };
  if (!c.enabled)
    return { label: 'Disabled', detail: 'This connection is not enabled.', attention: false };
  if (verification?.lastSuccessAt)
    return {
      label: 'Verified',
      detail: `Last success: ${evidenceTime(verification.lastSuccessAt)}`,
      attention: false,
    };
  return { label: 'Not verified', detail: 'No successful access check recorded.', attention: true };
}

export function activityEvidence(c: ConnectorSummary): ConnectionEvidence {
  const failedProject = c.polling?.projects?.some((p) => p.status === 'unhealthy');
  if (c.polling?.failureCategory || failedProject)
    return {
      label: 'Polling failed',
      detail: c.polling?.failureCategory?.replaceAll('_', ' ') ?? 'A project needs attention.',
      attention: true,
    };
  if (showsEventSync(c)) {
    if (textSetting(c.settings, 'eventTransport') === 'none')
      return {
        label: 'Events not configured',
        detail: 'On-demand investigation is independent of event delivery.',
        attention: false,
      };
    if (c.events?.failureCategory)
      return {
        label: 'Event delivery failed',
        detail: c.events.failureCategory.replaceAll('_', ' '),
        attention: true,
      };
    return c.events?.lastSuccessAt
      ? {
          label: 'Event received',
          detail: `Last verified: ${evidenceTime(c.events.lastSuccessAt)}`,
          attention: false,
        }
      : {
          label: 'Awaiting first event',
          detail: 'Delivery has not been confirmed yet.',
          attention: true,
        };
  }
  if (c.capabilities?.polling === 'snapshots' || c.polling) {
    return c.polling?.lastSuccessAt
      ? {
          label: 'Snapshot received',
          detail: `Last success: ${evidenceTime(c.polling.lastSuccessAt)}`,
          attention: false,
        }
      : {
          label: 'Awaiting first poll',
          detail: 'No successful snapshot recorded.',
          attention: true,
        };
  }
  return { label: 'On demand', detail: 'Reads run during investigations.', attention: false };
}

export function slackEvidence(surface: SurfaceSummary): {
  access: ConnectionEvidence;
  activity: ConnectionEvidence;
} {
  const state = surface.runtime?.socket?.state;
  const access: ConnectionEvidence =
    !surface.hasAppToken || !surface.hasBotToken
      ? { label: 'Credential missing', detail: 'Complete Slack setup.', attention: true }
      : {
          label:
            state === 'connected'
              ? 'Connected'
              : state
                ? state[0]!.toUpperCase() + state.slice(1)
                : 'Configured',
          detail: state ? 'Slack Socket Mode' : 'Runtime connection not yet confirmed.',
          attention: state !== 'connected',
        };
  const inbound = surface.runtime?.inbound;
  const activity: ConnectionEvidence = inbound?.failedLast24Hours
    ? {
        label: 'Messages need attention',
        detail: `${inbound.failedLast24Hours} failed or retrying in the last 24 hours`,
        attention: true,
      }
    : {
        label: inbound?.latest ? 'Message received' : 'No messages yet',
        detail: inbound?.latest
          ? evidenceTime(inbound.latest.acceptedAt)
          : 'Choose channels to receive messages.',
        attention: false,
      };
  return { access, activity };
}
