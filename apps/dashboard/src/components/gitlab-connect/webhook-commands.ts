import type { GitLabDiscovery } from '../../lib/connectors';
import type { HookScope } from './support';

export function gitLabWebhookInstallCommand(
  baseUrl: string,
  providerWebhookUrl: string,
  webhookName: string,
  hookScope: HookScope,
  discovery: GitLabDiscovery,
): string {
  const host = new URL(baseUrl).host;
  const hookName = webhookName;
  const common = {
    url: providerWebhookUrl,
    name: hookName,
    description: 'Authenticated change and deployment evidence for incident diagnosis',
    push_events: true,
    tag_push_events: true,
    merge_requests_events: true,
    enable_ssl_verification: true,
  };
  const tokenPrompt =
    "IFS= read -r -s -p 'Paste the GitLab webhook signing token: ' SRE_PLATFORM_GITLAB_SIGNING_TOKEN </dev/tty\n" +
    "printf '\\n' >/dev/tty";
  const bashScript = (body: string): string =>
    `bash <<'SRE_PLATFORM_GITLAB_SETUP'\nset -euo pipefail\nset +x\n${body}\nSRE_PLATFORM_GITLAB_SETUP`;
  const signedJson = (payload: string): string =>
    `jq --rawfile signing_token /dev/fd/3 '. + {signing_token: ($signing_token | rtrimstr("\\n"))}' 3<<<"$SRE_PLATFORM_GITLAB_SIGNING_TOKEN" <<'SRE_PLATFORM_GITLAB_WEBHOOK' |` +
    `\n${payload}\nSRE_PLATFORM_GITLAB_WEBHOOK`;
  if (hookScope === 'projects') {
    const payload = JSON.stringify(
      {
        ...common,
        pipeline_events: true,
        job_events: true,
        deployment_events: true,
        releases_events: true,
        resource_access_token_events: true,
      },
      null,
      2,
    );
    return bashScript(
      `${tokenPrompt}\nfor project_id in ${discovery.projects.map((project) => project.id).join(' ')}; do\n  hook_id="$(glab api --hostname ${host} --paginate "projects/\${project_id}/hooks" | jq -rs '[.[][] | select(.name == ${JSON.stringify(hookName)}) | .id][0] // empty')"\n  if [ -n "$hook_id" ]; then\n    method=PUT\n    endpoint="projects/\${project_id}/hooks/\${hook_id}"\n  else\n    method=POST\n    endpoint="projects/\${project_id}/hooks"\n  fi\n  ${signedJson(payload)}\n    glab api --hostname ${host} --method "$method" "$endpoint" --header 'content-type: application/json' --input - --silent\ndone\nunset SRE_PLATFORM_GITLAB_SIGNING_TOKEN`,
    );
  }
  const hookEndpoint = hookScope === 'system' ? 'hooks' : `groups/${discovery.group.id}/hooks`;
  const payload = JSON.stringify(
    hookScope === 'system'
      ? {
          ...common,
          repository_update_events: true,
          branch_filter_strategy: 'all_branches',
          push_events_branch_filter: '',
        }
      : {
          ...common,
          pipeline_events: true,
          job_events: true,
          deployment_events: true,
          releases_events: true,
          project_events: true,
          subgroup_events: true,
          resource_access_token_events: true,
        },
    null,
    2,
  );
  return bashScript(
    `${tokenPrompt}\nhook_id="$(glab api --hostname ${host} --paginate '${hookEndpoint}' | jq -rs '[.[][] | select(.name == ${JSON.stringify(hookName)}) | .id][0] // empty')"\nif [ -n "$hook_id" ]; then\n  method=PUT\n  endpoint="${hookEndpoint}/\${hook_id}"\nelse\n  method=POST\n  endpoint='${hookEndpoint}'\nfi\n${signedJson(payload)}\n  glab api --hostname ${host} --method "$method" "$endpoint" --header 'content-type: application/json' --input - --silent\nunset SRE_PLATFORM_GITLAB_SIGNING_TOKEN`,
  );
}
