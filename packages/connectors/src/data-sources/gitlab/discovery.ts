import { dnsLookup, type HostLookup } from '../../ssrf';
import { discoveryFetch, GitLabDiscoveryError } from './discovery-failure';
import { idStr, obj, str } from '../../values';
import {
  MAX_CATALOG_PAGES,
  apiBase,
  apiFetch,
  buildApiUrl,
  getPaginatedArray,
  type FetchLike,
} from './client';

export function mapCommit(raw: unknown): Record<string, unknown> {
  const c = obj(raw);
  return {
    sha: str(c.short_id),
    title: str(c.title),
    author: str(c.author_name),
    at: str(c.created_at),
    url: str(c.web_url),
  };
}

export function mapPipeline(raw: unknown): Record<string, unknown> {
  const p = obj(raw);
  const sha = str(p.sha);
  return {
    id: p.id,
    status: str(p.status),
    ref: str(p.ref),
    sha: sha ? sha.slice(0, 8) : undefined,
    source: str(p.source),
    at: str(p.updated_at),
    url: str(p.web_url),
  };
}

export function mapDeployment(raw: unknown, projectId: string): Record<string, unknown> {
  const deployment = obj(raw);
  const environment = obj(deployment.environment);
  const user = obj(deployment.user);
  const deployable = obj(deployment.deployable);
  const pipeline = obj(deployable.pipeline);
  const createdAt = str(deployment.created_at);
  const updatedAt = str(deployment.updated_at) ?? createdAt;
  return {
    providerId: idStr(deployment.id),
    projectId,
    repo: projectId,
    ref: str(deployment.ref),
    environment: str(environment.name),
    actor: str(user.username) ?? str(user.name),
    sha: str(deployment.sha),
    status: str(deployment.status),
    url: str(deployment.web_url) ?? str(pipeline.web_url) ?? str(deployable.web_url),
    deployedAt: updatedAt,
    providerCreatedAt: createdAt,
    providerUpdatedAt: updatedAt,
  };
}

export interface GitLabProjectSummary {
  id: number;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  defaultBranch?: string;
  visibility?: string;
  archived: boolean;
  lastActivityAt?: string;
}

export interface GitLabGroupSummary {
  id: number;
  name: string;
  fullPath: string;
  webUrl: string;
}

export interface GitLabDiscovery {
  group: GitLabGroupSummary;
  projects: GitLabProjectSummary[];
  instance?: { version: string; enterprise: boolean };
}

/**
 * Check that the configured immutable group still owns its saved namespace path.
 * @param settings - Saved GitLab instance, group ID and group path.
 * @param token - Read-only credential authorized for the configured group.
 * @param fetchImpl - HTTP transport with bounded response and timeout handling.
 * @param lookup - Resolver enforcing the connector destination policy.
 */
export async function matchesGitLabGroupScope(
  settings: Record<string, unknown>,
  token: string,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
): Promise<boolean> {
  const id = idStr(settings.groupId);
  if (!/^[1-9]\d*$/.test(id) || !str(settings.groupPath)) return false;
  const base = await apiBase(settings, lookup);
  const response = await apiFetch(fetchImpl, `${base}/groups/${id}`, token);
  const group = obj(response.json);
  return idStr(group.id) === id && group.full_path === settings.groupPath;
}

function mapProject(raw: unknown): GitLabProjectSummary | null {
  const project = obj(raw);
  const id = project.id;
  const name = str(project.name);
  const pathWithNamespace = str(project.path_with_namespace);
  const webUrl = str(project.web_url);
  if (typeof id !== 'number' || !name || !pathWithNamespace || !webUrl) return null;
  const defaultBranch = str(project.default_branch);
  const visibility = str(project.visibility);
  const lastActivityAt = str(project.last_activity_at);
  return {
    id,
    name,
    pathWithNamespace,
    webUrl,
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(visibility ? { visibility } : {}),
    archived: project.archived === true,
    ...(lastActivityAt ? { lastActivityAt } : {}),
  };
}

/**
 * Lists every project visible to the configured GitLab token.
 *
 * @param settings - GitLab instance settings.
 * @param token - Access token used for read-only API calls.
 * @param fetchImpl - HTTP transport used for GitLab API requests.
 * @param lookup - DNS resolver used by SSRF validation.
 */
export async function discoverGitLabProjects(
  settings: Record<string, unknown>,
  token: string,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
): Promise<GitLabProjectSummary[]> {
  const base = await discoveryBase(settings, lookup);
  fetchImpl = discoveryFetch(fetchImpl);
  const url = buildApiUrl(base, 'projects', {
    membership: 'true',
    simple: 'true',
    order_by: 'last_activity_at',
    sort: 'desc',
    per_page: 100,
  });
  const projects = await getPaginatedArray(fetchImpl, url, token, base);
  return projects.flatMap((raw) => {
    const project = mapProject(raw);
    return project ? [project] : [];
  });
}

/**
 * Discovers one group and every directly owned project in its subgroup hierarchy.
 *
 * @param settings - GitLab instance and group settings.
 * @param token - Access token used for read-only API calls.
 * @param fetchImpl - HTTP transport used for GitLab API requests.
 * @param lookup - DNS resolver used by SSRF validation.
 */
export async function discoverGitLabGroup(
  settings: Record<string, unknown>,
  token: string,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
): Promise<GitLabDiscovery> {
  const group = settings.groupId ?? settings.groupPath;
  if (!(
    (typeof group === 'number' && Number.isSafeInteger(group) && group > 0) ||
    (typeof group === 'string' && group.trim().length > 0)
  ))
    throw new Error('gitlab connector: a group is required');
  const base = await discoveryBase(settings, lookup);
  fetchImpl = discoveryFetch(fetchImpl);
  const encodedGroup = typeof group === 'number' ? String(group) : encodeURIComponent(group.trim());
  const [groupResponse, versionResponse] = await Promise.all([
    apiFetch(
      fetchImpl,
      buildApiUrl(base, `groups/${encodedGroup}`, { with_projects: 'false', per_page: 1 }),
      token,
    ),
    apiFetch(fetchImpl, `${base}/version`, token).catch(() => null),
  ]);
  const rawGroup = obj(groupResponse.json);
  const id = rawGroup.id;
  const name = str(rawGroup.name);
  const fullPath = str(rawGroup.full_path);
  const webUrl = str(rawGroup.web_url);
  if (typeof id !== 'number' || !name || !fullPath || !webUrl)
    throw new Error('gitlab connector: invalid group response');
  const projectsUrl = buildApiUrl(base, `groups/${id}/projects`, {
    include_subgroups: 'true',
    with_shared: 'false',
    simple: 'true',
    order_by: 'last_activity_at',
    sort: 'desc',
    per_page: 100,
  });
  const projects = await getPaginatedArray(fetchImpl, projectsUrl, token, base, MAX_CATALOG_PAGES);
  const rawVersion = obj(versionResponse?.json);
  const version = str(rawVersion.version);
  const enterprise = rawVersion.enterprise;
  return {
    group: { id, name, fullPath, webUrl },
    ...(version && typeof enterprise === 'boolean' ? { instance: { version, enterprise } } : {}),
    projects: projects.flatMap((raw) => {
      const project = mapProject(raw);
      return project ? [project] : [];
    }),
  };
}

async function discoveryBase(
  settings: Record<string, unknown>,
  lookup: HostLookup,
): Promise<string> {
  try {
    return await apiBase(settings, lookup);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    throw new GitLabDiscoveryError(
      typeof code === 'string' ? 'network' : 'unsafe_url',
      'connection',
    );
  }
}
