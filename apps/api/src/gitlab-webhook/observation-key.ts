import { createHash } from 'node:crypto';
import { gitLabRevisionKey } from '@sre/connectors';
import { eventAction, identifier, object, projectId, string } from './mapping';

/**
 * Keep transport receipts distinct while identifying equivalent provider observations.
 * @param eventType - Normalized event family after authentication and scope checks.
 * @param payload - Original authenticated body, before system-hook projection.
 * @param eventUuid - Optional GitLab correlation identifier, not sufficient on its own.
 */
export function gitLabWebhookObservationKey(
  eventType: string,
  payload: Record<string, unknown>,
  eventUuid: string | undefined,
): string | undefined {
  const attributes = object(payload.object_attributes);
  const id =
    eventType === 'pipeline' || eventType === 'merge_request'
      ? identifier(attributes.id)
      : eventType === 'job'
        ? identifier(payload.build_id)
        : eventType === 'deployment'
          ? identifier(payload.deployment_id)
          : eventType === 'project'
            ? projectId(payload)
            : undefined;
  const revisedAt =
    eventType === 'pipeline' || eventType === 'merge_request'
      ? string(attributes.updated_at)
      : eventType === 'job'
        ? (string(payload.build_finished_at) ?? string(payload.build_started_at))
        : eventType === 'deployment'
          ? string(payload.status_changed_at)
          : eventType === 'project'
            ? string(payload.updated_at)
            : undefined;
  const revision = gitLabRevisionKey(
    eventType,
    projectId(payload),
    id,
    eventAction(eventType, payload),
    revisedAt,
  );
  if (revision) return revision;
  // Recursive hooks share this UUID. Requiring the same body avoids collapsing different changes.
  if (
    !eventUuid ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventUuid)
  )
    return undefined;
  return `event:${createHash('sha256')
    .update(JSON.stringify([eventType, eventUuid.toLowerCase(), payload]))
    .digest('hex')}`;
}
