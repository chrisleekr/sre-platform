const PROVIDER_LABELS: Array<[prefix: string, label: string]> = [
  ['query_metrics', 'Metrics'],
  ['query_logs', 'Logs'],
  ['query_deploys', 'Deployments'],
  ['prometheus_', 'Prometheus'],
  ['kubernetes_', 'Kubernetes'],
  ['grafana_', 'Grafana'],
  ['datadog_', 'Datadog'],
  ['github_', 'GitHub'],
  ['gitlab_', 'GitLab'],
  ['argocd_', 'Argo CD'],
  ['statuscake_', 'StatusCake'],
  ['search_incident_evidence', 'Incident history'],
  ['search_runbooks', 'Runbooks'],
  ['platform', 'SRE Platform'],
  ['respond', 'SRE Platform'],
];

const ACTION_LABELS: Array<[suffix: string, label: string]> = [
  ['query_range', 'metric range'],
  ['query', 'metric query'],
  ['alerts', 'active alerts'],
  ['rules', 'alert rules'],
  ['get_pod_logs', 'pod logs'],
  ['list_events', 'events'],
  ['list_resources', 'resources'],
  ['get_resource', 'resource detail'],
  ['list_pipelines', 'pipelines'],
  ['search', 'search'],
];

export function toolProviderLabel(tool: string): string {
  return PROVIDER_LABELS.find(([prefix]) => tool.startsWith(prefix))?.[1] ?? 'Investigator';
}

export function toolDisplayLabel(tool: string): string {
  const provider = toolProviderLabel(tool);
  const action = ACTION_LABELS.find(([suffix]) => tool.endsWith(suffix))?.[1];
  return action ? `${provider} · ${action}` : provider;
}

export function summarizeToolProviders(tools: string[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const label = toolProviderLabel(tool);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${label} ${count}`).join(' · ');
}
