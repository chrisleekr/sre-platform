import { createHash } from 'node:crypto';

/**
 * Identify a provider revision only when its object, state and provider timestamp are known.
 * @param eventType - Normalized GitLab event family.
 * @param projectId - Provider project identity, scoped by the stored connector.
 * @param objectId - Provider object identity, not the delivery identifier.
 * @param state - Provider status or lifecycle action.
 * @param revisedAt - Provider revision timestamp, never the local observation time.
 */
export function gitLabRevisionKey(
  eventType: string,
  projectId: string | undefined,
  objectId: string | undefined,
  state: string | undefined,
  revisedAt: string | undefined,
): string | undefined {
  if (!projectId || !objectId || !state || !revisedAt || !Number.isFinite(Date.parse(revisedAt)))
    return undefined;
  const timestamp = revisedAt.match(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/,
  );
  if (!timestamp) return undefined;
  // Date normalizes offsets but truncates sub-millisecond provider precision.
  const instant = `${new Date(revisedAt).toISOString().slice(0, 19)}.${timestamp[1]?.replace(/0+$/, '') || '0'}Z`;
  return `revision:${createHash('sha256')
    .update(JSON.stringify([eventType, projectId, objectId, state, instant]))
    .digest('hex')}`;
}
