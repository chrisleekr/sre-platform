export const EVENT_LABELS = [
  'Push',
  'Tag push',
  'Merge request',
  'Pipeline',
  'Job',
  'Deployment',
  'Release',
  'Project',
  'Subgroup',
  'Access token expiry',
];
export type EventTransport = 'direct' | 'smee' | 'none';
export type HookScope = 'projects' | 'group' | 'system';

/**
 * Prefer the explicit strategy; legacy scope only applies before a strategy was selected.
 * @param settings - Saved connection settings, which may predate explicit delivery strategies.
 */
export function savedHookScope(
  settings?: Pick<GitLabSettings, 'eventStrategy' | 'hookScope'>,
): HookScope | undefined {
  if (settings?.eventStrategy === 'managed_projects') return 'projects';
  return settings?.eventStrategy ?? settings?.hookScope;
}

export function randomWebhookSigningToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}
import type { GitLabSettings } from '../../lib/connectors';
