import { identifier, object, string } from './mapping';

const PROJECT_EVENTS = new Set([
  'project_create',
  'project_destroy',
  'project_rename',
  'project_transfer',
  'project_update',
]);
const REPOSITORY_EVENTS = new Set(['push', 'tag_push', 'merge_request', 'repository_update']);

function scopedPath(value: unknown, group: string): value is string {
  if (typeof value !== 'string') return false;
  return (
    value.toLowerCase().startsWith(`${group.toLowerCase()}/`) &&
    value
      .split('/')
      .every((segment) => /^[\w.-]+$/.test(segment) && segment !== '.' && segment !== '..')
  );
}

/**
 * Filter instance-wide events before any durable evidence or delivery-health update.
 * @param payload - Authenticated GitLab system-hook body.
 * @param group - Configured group path, including parent namespaces.
 * @param baseUrl - Configured GitLab origin and optional installation path.
 */
export function scopedSystemEvent(
  payload: Record<string, unknown>,
  group: string,
  baseUrl: string,
): { payload: Record<string, unknown>; eventType: string; removed: boolean } | null {
  const eventName = string(payload.event_name) ?? string(payload.object_kind);
  if (!eventName) return null;
  const lifecycle = PROJECT_EVENTS.has(eventName);
  if (!lifecycle && !REPOSITORY_EVENTS.has(eventName)) return null;
  const project = object(payload.project);
  const path = lifecycle ? payload.path_with_namespace : project.path_with_namespace;
  const oldPath = payload.old_path_with_namespace;
  const movedOut =
    eventName === 'project_transfer' && !scopedPath(path, group) && scopedPath(oldPath, group);
  if (!scopedPath(path, group) && !movedOut) return null;
  const fullPath = movedOut ? String(oldPath) : String(path);
  const id = identifier(payload.project_id) ?? identifier(project.id);
  if (!id) return null;
  if (!lifecycle) return { payload, eventType: eventName, removed: false };

  // Transfers out retain only the former in-scope identity, not the new private namespace.
  return {
    eventType: 'project',
    removed: movedOut || eventName === 'project_destroy',
    payload: {
      event_name: eventName,
      event_time: payload.updated_at ?? payload.created_at,
      project: {
        id,
        name: movedOut ? fullPath.split('/').at(-1) : string(payload.name),
        path_with_namespace: fullPath,
        web_url: `${baseUrl.replace(/\/+$/, '')}/${fullPath}`,
        visibility: movedOut ? undefined : string(payload.project_visibility),
      },
    },
  };
}
