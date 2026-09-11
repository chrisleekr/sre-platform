import type { GitHubInstallationSummary } from '../../lib/connectors';

export const EVENTS = [
  'Push',
  'Pull request',
  'Workflow run',
  'Deployment',
  'Deployment status',
  'Repository',
];
export type Owner = 'personal' | 'organization';
export type SetupPath = 'dedicated' | 'existing';
export type DeliveryMode = 'smee' | 'direct';

export function permission(
  installation: GitHubInstallationSummary | undefined,
  name: string,
): string {
  return installation?.permissions[name] ?? 'not granted';
}
