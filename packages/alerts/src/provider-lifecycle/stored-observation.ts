import type { StoredAlertmanagerObservation } from '@sre/db';
import type { NormalizedAlert } from './normalize';

/**
 * Captures the sanitized provider observation that survives external-post and process retries.
 *
 * @param groupKey - Alertmanager group identity from the delivery envelope.
 * @param externalUrl - Sanitized Alertmanager source URL.
 * @param alert - Validated provider episode observation.
 * @param lifecycleVersion - Connector generation that authenticated the observation.
 */
export function storedAlertmanagerObservation(
  groupKey: string,
  externalUrl: string | null,
  alert: Omit<NormalizedAlert, 'startsAt'>,
  lifecycleVersion?: number,
): StoredAlertmanagerObservation {
  return {
    provider: alert.provider,
    lifecycleVersion,
    status: alert.status,
    groupKey,
    alertName: alert.alertName,
    monitorIdentity: alert.monitorIdentity,
    labels: alert.labels,
    annotations: alert.annotations,
    endsAt: alert.endsAt?.toISOString() ?? null,
    generatorUrl: alert.generatorUrl,
    externalUrl,
  };
}

/**
 * Restores the durable provider observation used after a Slack-post or routing retry.
 *
 * @param input - Intake identity, immutable destination, and latest accepted observation.
 */
export function restoreStoredAlertmanagerEpisode(input: {
  providerFingerprint: string;
  startsAt: Date | null;
  materialHash: string;
  channel: string;
  observation: StoredAlertmanagerObservation;
}): {
  alert: NormalizedAlert;
  groupKey: string;
  materialHash: string;
  channel: string;
} {
  if (!input.startsAt) throw new Error('provider cycle is waiting for its trigger timestamp');
  const endsAt = input.observation.endsAt ? new Date(input.observation.endsAt) : null;
  if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt < input.startsAt))
    throw new Error('stored Alertmanager end time is invalid');
  return {
    alert: {
      provider: input.observation.provider,
      status: input.observation.status,
      fingerprint: input.providerFingerprint,
      monitorIdentity: input.observation.monitorIdentity ?? null,
      startsAt: input.startsAt,
      endsAt,
      alertName: input.observation.alertName,
      labels: input.observation.labels,
      annotations: input.observation.annotations,
      generatorUrl: input.observation.generatorUrl,
    },
    groupKey: input.observation.groupKey,
    materialHash: input.materialHash,
    channel: input.channel,
  };
}
