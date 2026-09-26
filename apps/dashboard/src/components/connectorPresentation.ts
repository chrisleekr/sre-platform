import type { ConnectorSummary } from '../lib/connectors';

const TLS_SUMMARY_TYPES = new Set(['kubernetes', 'prometheus', 'argocd', 'grafana']);

export const CONNECTOR_CATALOG = [
  {
    type: 'kubernetes',
    name: 'Kubernetes',
    description: 'Live pods, events, logs, nodes, and workload state for runtime diagnosis.',
  },
  {
    type: 'argocd',
    name: 'Argo CD',
    description: 'Application sync, health, revision, and deployment history from GitOps.',
  },
  {
    type: 'github',
    name: 'GitHub App',
    description:
      'Installation-wide repositories, commits, diffs, pull requests, workflows, and signed change events.',
  },
  {
    type: 'gitlab',
    name: 'GitLab',
    description:
      'Group-wide projects, commits, merge requests, pipelines, deployments, and authenticated change events.',
  },
  {
    type: 'datadog',
    name: 'Datadog',
    description: 'Logs, traces, metrics, monitors, and error tracking for on-demand diagnosis.',
  },
  {
    type: 'grafana',
    name: 'Grafana',
    description: 'Unified alerts, dashboards, annotations, and Grafana-managed evidence.',
  },
  {
    type: 'prometheus',
    name: 'Prometheus & Alertmanager',
    description:
      'Prometheus metrics for investigation plus exact Alertmanager firing and recovery events.',
  },
  {
    type: 'statuscake',
    name: 'StatusCake',
    description: 'On-demand uptime tests, history, alerts, maintenance, and contact evidence.',
  },
] as const;

export type ManagedConnectorType = (typeof CONNECTOR_CATALOG)[number]['type'];

export function isManagedConnector(type: string): type is ManagedConnectorType {
  return CONNECTOR_CATALOG.some((connector) => connector.type === type);
}

export function disconnectLabel(connector: ConnectorSummary): string {
  if (connector.type === 'argocd') return 'ArgoCD';
  if (connector.type === 'github') return 'GitHub';
  if (connector.type === 'gitlab') return 'GitLab';
  if (connector.type === 'kubernetes') return 'Kubernetes';
  if (connector.type === 'prometheus') return 'Prometheus & Alertmanager';
  if (connector.type === 'statuscake') return 'StatusCake';
  return connector.name;
}

export function disconnectMessage(type: ManagedConnectorType): string {
  if (type === 'kubernetes')
    return 'Disconnecting removes the dashboard configuration and stored token, and stops polling. It does not remove provider-side RBAC. To remove that access too, cancel now, open Manage, and copy the uninstall command from Access.';
  if (type === 'gitlab')
    return 'Stop GitLab code access and event sync, then permanently remove the stored access token, webhook verifier, and local relay channel? The provider-side token and group webhook remain until you revoke or delete them in GitLab.';
  if (type === 'github')
    return 'Stop GitHub event sync and permanently remove the stored private key and webhook secret? The GitHub App remains installed until you remove it in GitHub.';
  if (type === 'argocd')
    return 'Disconnecting removes the dashboard configuration and every stored project token, and stops polling. It cannot revoke provider-side tokens. To remove each AppProject role too, cancel now, open Manage, and copy its uninstall command before disconnecting.';
  if (type === 'datadog' || type === 'grafana')
    return 'Remove this connection and its encrypted credential? Provider-side keys are not revoked automatically.';
  if (type === 'statuscake')
    return 'Remove this connection and its encrypted API token? Contact groups the platform created in StatusCake stay there. To remove them first, cancel now, open Manage, and turn uptime alerts Off.';
  if (type === 'prometheus')
    return 'Remove Prometheus investigation access, Alertmanager event delivery, and their encrypted credentials? The provider-side receiver remains until you remove it from Alertmanager.';
  return 'Permanently remove this connector configuration and stored credential? Provider-side tokens and certificates are not revoked automatically.';
}

export function textSetting(settings: Record<string, unknown>, key: string): string | null {
  const value = settings[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function idSetting(settings: Record<string, unknown>, key: string): string | null {
  const value = settings[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function endpointHost(settings: Record<string, unknown>, key: string): string | null {
  const value = textSetting(settings, key);
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

export function argoCdProjects(settings: Record<string, unknown>): Array<{
  project: string;
  credentialConfigured: boolean;
}> {
  if (!Array.isArray(settings.projects)) return [];
  return settings.projects.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const project = (value as Record<string, unknown>).project;
    return typeof project === 'string' && project
      ? [
          {
            project,
            credentialConfigured: (value as Record<string, unknown>).credentialConfigured === true,
          },
        ]
      : [];
  });
}

/** Only connector-owned identifiers are projected; opaque settings are never enumerated. */
export function safeConnectorSummary(type: string, settings: Record<string, unknown>): string[] {
  const values: Array<string | null> = [];
  switch (type) {
    case 'kubernetes':
      values.push(
        textSetting(settings, 'name'),
        textSetting(settings, 'namespace'),
        endpointHost(settings, 'apiUrl'),
      );
      break;
    case 'datadog':
      values.push(textSetting(settings, 'site'));
      break;
    case 'github':
      values.push(
        textSetting(settings, 'accountLogin'),
        textSetting(settings, 'appSlug'),
        idSetting(settings, 'appId'),
      );
      break;
    case 'gitlab':
      values.push(textSetting(settings, 'groupPath') ?? idSetting(settings, 'projectId'));
      if (!textSetting(settings, 'groupPath')) values.push(textSetting(settings, 'service'));
      values.push(endpointHost(settings, 'baseUrl'));
      break;
    case 'argocd': {
      const projects = argoCdProjects(settings);
      values.push(endpointHost(settings, 'baseUrl'));
      if (projects.length > 0)
        values.push(`${projects.length} project${projects.length === 1 ? '' : 's'}`);
      break;
    }
    case 'prometheus':
    case 'grafana':
      values.push(endpointHost(settings, 'baseUrl'));
      break;
  }
  if (TLS_SUMMARY_TYPES.has(type)) {
    if (textSetting(settings, 'caCert') || settings.caConfigured === true)
      values.push('CA configured');
    if (settings.insecureSkipTLSVerify === true) values.push('TLS verification disabled');
  }
  const safe = values.filter((value): value is string => value !== null);
  return safe.length > 0 ? safe : ['Settings configured'];
}

export function connectorState(connector: ConnectorSummary): { label: string; className: string } {
  if (!connector.verification) {
    return connector.enabled
      ? { label: 'Enabled', className: 'bg-success-muted text-success' }
      : { label: 'Disabled', className: 'bg-surface-strong text-ink-muted' };
  }
  if (!connector.credentialConfigured)
    return { label: 'Credential missing', className: 'bg-critical-muted text-critical' };
  if (connector.verification.failureCategory)
    return { label: 'Verification failed', className: 'bg-critical-muted text-critical' };
  if (
    connector.enabled &&
    (connector.polling?.failureCategory ||
      connector.polling?.projects?.some((p) => p.status === 'unhealthy'))
  )
    return { label: 'Polling failed', className: 'bg-critical-muted text-critical' };
  if (connector.enabled && connector.events?.failureCategory)
    return {
      label: connector.type === 'prometheus' ? 'Alert delivery failing' : 'Event sync failing',
      className: 'bg-critical-muted text-critical',
    };
  if (
    connector.type === 'prometheus' &&
    connector.verification.lastSuccessAt &&
    connector.enabled
  ) {
    if (textSetting(connector.settings, 'eventTransport') === 'none')
      return { label: 'Partially configured', className: 'bg-warning-muted text-warning' };
    if (!connector.events?.lastSuccessAt)
      return { label: 'Awaiting alert event', className: 'bg-warning-muted text-warning' };
  }
  if (connector.verification.lastSuccessAt && connector.enabled)
    return { label: 'Verified', className: 'bg-success-muted text-success' };
  if (connector.verification.lastAttemptAt)
    return { label: 'Verification failed', className: 'bg-critical-muted text-critical' };
  return { label: 'Not verified', className: 'bg-warning-muted text-warning' };
}

export function showsEventSync(connector: ConnectorSummary): boolean {
  const events =
    connector.capabilities?.events ??
    (connector.type === 'github' || connector.type === 'gitlab' || connector.type === 'prometheus'
      ? 'authenticated'
      : 'none');
  if (events !== 'authenticated') return false;
  return connector.type !== 'gitlab' || Boolean(textSetting(connector.settings, 'groupPath'));
}

/**
 * The saved event transport. Datadog, Grafana and StatusCake rows saved before delivery existed
 * have none stored, and the server treats a missing value as off.
 */
export function eventTransport(connector: ConnectorSummary): string | null {
  return (
    textSetting(connector.settings, 'eventTransport') ??
    (['datadog', 'grafana', 'statuscake'].includes(connector.type) ? 'none' : null)
  );
}

export function evidenceTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}
