import { scrubSecrets } from '@sre/contracts';

const fields: Record<string, Record<string, string[]>> = {
  prometheus: { query: ['query'], query_range: ['query'], label_values: ['name'] },
  kubernetes: {
    get_resource: ['namespace', 'resource', 'name'],
    list_resources: ['namespace', 'resource'],
    get_pod_logs: ['namespace', 'name', 'container'],
    list_events: ['namespace', 'type'],
    top_pods: ['namespace'],
  },
  argocd: {
    get_application: ['appNamespace', 'name'],
    get_resource_tree: ['appNamespace', 'name'],
    get_managed_resources: ['appNamespace', 'name'],
    get_application_events: ['appNamespace', 'name'],
    get_application_logs: ['appNamespace', 'name', 'namespace', 'podName', 'container'],
  },
  datadog: { query_metrics: ['query'], search: ['domain', 'query'] },
  github: {
    resolve_repositories: ['service'],
    search_repositories: ['query'],
    list_commits: ['repo'],
    get_commit: ['repo', 'ref'],
    compare_commits: ['repo', 'base', 'head'],
    search_code: ['repo', 'query'],
    get_content: ['repo', 'path'],
    list_pull_requests: ['repo'],
    get_pull_request: ['repo', 'number'],
    list_workflow_runs: ['repo'],
    get_workflow_run_jobs: ['repo'],
    get_job_logs: ['repo'],
  },
  gitlab: {
    resolve_projects: ['service'],
    search_projects: ['query'],
    list_commits: ['project'],
    get_commit: ['project', 'ref'],
    compare_commits: ['project', 'from', 'to'],
    search_code: ['project', 'search'],
    get_file: ['project', 'file_path'],
    list_merge_requests: ['project'],
    list_pipelines: ['project'],
    get_pipeline_jobs: ['project'],
    get_job_trace: ['project'],
    list_deployments: ['project'],
  },
};

/** Summarize only known scalar tool fields, never arbitrary request objects.
 * @param tool - Audited legacy or instance-qualified tool name.
 * @param input - Persisted tool input, treated as untrusted even after prior scrubbing.
 */
export function evidenceSummary(tool: string, input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const match =
    /^(prometheus|kubernetes|argocd|datadog|github|gitlab)_(?:[A-Za-z0-9_-]{22}_)?([a-z][a-z0-9_]*)$/.exec(
      tool,
    );
  if (!match) return null;
  const allowed = fields[match[1]!]?.[match[2]!];
  if (!allowed) return null;
  const request = input as Record<string, unknown>;
  const parts = allowed.flatMap((key) => {
    const value = request[key];
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
      ? [`${key}: ${scrubSecrets(String(value)).replace(/\s+/g, ' ').trim()}`]
      : [];
  });
  if (!parts.length) return null;
  const text = [...parts.join(' · ')];
  return text.length > 200 ? `${text.slice(0, 199).join('')}…` : text.join('');
}
