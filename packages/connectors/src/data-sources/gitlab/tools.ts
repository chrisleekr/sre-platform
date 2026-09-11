import * as z from 'zod';
import type { ConnectorConfig } from '../../registry';
import type { HostLookup } from '../../ssrf';
import type { ConnectorTool } from '../../types';
import { str } from '../../values';
import { connectorToken } from './auth';
import {
  DEFAULT_PER_PAGE,
  apiBase,
  apiFetch,
  buildApiUrl,
  projectRef,
  type FetchLike,
} from './client';
import { sanitizeGitLab } from './sanitize';

/** Bind a Zod input schema to a typed run body, returning the erased ConnectorTool (mirror of k8s). */
function gtool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>) => Promise<unknown>;
}): ConnectorTool {
  return def as ConnectorTool;
}

/** Encode an explicit project ref (numeric id or "group/repo" path) for a URL segment. */
function encodeProject(
  project: string | number | undefined,
  settings: Record<string, unknown>,
): string {
  if (project === undefined || project === '')
    return projectRef(settings, str(settings.service) ?? '');
  return typeof project === 'number' ? String(project) : encodeURIComponent(project);
}

/** Drop undefined-valued keys so an omitted optional tool arg never becomes a literal "undefined" query param. */
function q(o: Record<string, string | number | undefined>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * GitLab granular triage tools. `api_get` is a generic GET over any `/api/v4`
 * path (URL-normalized, origin+prefix-guarded, per_page-clamped) so coverage is comprehensive; the
 * six named tools are ergonomic wrappers over the hot triage paths, defaulting the project to the
 * incident's configured id/service. Every JSON response is passed through the path-gated sanitizer;
 * traces return bounded text. GET-only: no tool can mutate.
 */
export function makeGitLabTools(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
): ConnectorTool[] {
  const settings = config.settings;
  const getUrl = async (url: string): Promise<unknown> => {
    const token = await connectorToken(config);
    const { json, text, truncated = false } = await apiFetch(fetchImpl, url, token);
    if (json !== undefined) return sanitizeGitLab(new URL(url).pathname, json);
    return { truncated, body: text };
  };
  const get = async (path: string, query?: Record<string, string | number>): Promise<unknown> => {
    const base = await apiBase(settings, lookup);
    return getUrl(buildApiUrl(base, path, query));
  };

  if (config.settings.groupId != null || str(config.settings.groupPath)) {
    const projectSchema = z.string().min(1);
    const catalogProject = async (requested: string): Promise<string> => {
      const normalized = requested.trim().toLowerCase();
      const matches = (await config.repositories?.search(requested, 50)) ?? [];
      const exact = matches.find(
        (candidate) =>
          candidate.fullName.toLowerCase() === normalized ||
          candidate.repositoryId === requested.trim(),
      );
      if (!exact)
        throw new Error('gitlab connector: project is outside the synchronized group catalog');
      return exact.fullName;
    };
    const projectGet = async (
      requested: string,
      suffix: string,
      query?: Record<string, string | number>,
    ): Promise<unknown> => {
      const fullPath = await catalogProject(requested);
      const normalized = suffix.replace(/^[\\/]+/, '');
      let decoded: string;
      try {
        decoded = decodeURIComponent(normalized).replace(/\\/g, '/');
      } catch {
        throw new Error('gitlab connector: invalid project API path encoding');
      }
      if (!normalized || decoded.split('/').some((segment) => segment === '.' || segment === '..'))
        throw new Error('gitlab connector: invalid project API path');

      const base = await apiBase(settings, lookup);
      const projectPrefix = new URL(
        `projects/${encodeURIComponent(fullPath)}/`,
        `${base.replace(/\/+$/, '')}/`,
      ).pathname;
      const url = buildApiUrl(
        base,
        `projects/${encodeURIComponent(fullPath)}/${normalized}`,
        query,
      );
      if (!new URL(url).pathname.startsWith(projectPrefix))
        throw new Error('gitlab connector: project API path escaped its catalog project');
      return getUrl(url);
    };

    return [
      gtool({
        name: 'resolve_projects',
        description:
          'Resolve projects associated with an incident service from confirmed topology, Argo CD sources, and exact catalog matches.',
        inputSchema: z.object({ service: z.string() }),
        run: ({ service }) => config.repositories?.resolve(service) ?? Promise.resolve([]),
      }),
      gtool({
        name: 'search_projects',
        description:
          'Search the synchronized group-wide project catalog when service resolution is ambiguous.',
        inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
        run: ({ query, limit }) =>
          config.repositories?.search(query, Math.min(Math.max(1, limit ?? 20), 50)) ??
          Promise.resolve([]),
      }),
      gtool({
        name: 'list_recent_events',
        description:
          'List synchronized push, merge-request, pipeline, job, deployment, and release evidence for selected projects since an ISO timestamp.',
        inputSchema: z.object({
          projects: z.array(z.string()).min(1).max(20),
          since: z.string(),
          limit: z.number().optional(),
        }),
        run: async ({ projects, since, limit }) => {
          const parsed = new Date(since);
          if (!Number.isFinite(parsed.getTime()))
            throw new Error('gitlab connector: invalid since');
          const scoped = await Promise.all(projects.map(catalogProject));
          return (
            config.repositories?.recentEvents(
              scoped,
              parsed,
              Math.min(Math.max(1, limit ?? 50), 100),
            ) ?? Promise.resolve([])
          );
        },
      }),
      gtool({
        name: 'api_get',
        description:
          'GET a read-only REST endpoint beneath one synchronized project. The request cannot escape that project.',
        inputSchema: z.object({
          project: projectSchema,
          path: z.string(),
          query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        }),
        run: ({ project: requested, path, query }) => projectGet(requested, path, query),
      }),
      gtool({
        name: 'list_commits',
        description: 'List recent commits in one synchronized project.',
        inputSchema: z.object({
          project: projectSchema,
          ref_name: z.string().optional(),
          path: z.string().optional(),
          since: z.string().optional(),
          until: z.string().optional(),
          per_page: z.number().optional(),
        }),
        run: ({ project, ref_name, path, since, until, per_page }) =>
          projectGet(
            project,
            'repository/commits',
            q({ ref_name, path, since, until, per_page: per_page ?? DEFAULT_PER_PAGE }),
          ),
      }),
      gtool({
        name: 'get_commit',
        description: 'Get one commit with its parent revisions, changed files, and diff metadata.',
        inputSchema: z.object({ project: projectSchema, ref: z.string() }),
        run: ({ project, ref }) =>
          projectGet(project, `repository/commits/${encodeURIComponent(ref)}`, { stats: 'true' }),
      }),
      gtool({
        name: 'compare_commits',
        description:
          'Compare two revisions in one synchronized project to find commits and files changed between them.',
        inputSchema: z.object({ project: projectSchema, from: z.string(), to: z.string() }),
        run: ({ project, from, to }) =>
          projectGet(project, 'repository/compare', { from, to, straight: 'true' }),
      }),
      gtool({
        name: 'search_code',
        description:
          'Search code in one synchronized project. GitLab code search availability depends on the instance tier and search configuration.',
        inputSchema: z.object({
          project: projectSchema,
          query: z.string(),
          per_page: z.number().optional(),
        }),
        run: ({ project, query, per_page }) =>
          projectGet(project, 'search', {
            scope: 'blobs',
            search: query,
            per_page: Math.min(Math.max(1, Math.floor(per_page ?? 20)), 50),
          }),
      }),
      gtool({
        name: 'get_file',
        description:
          'Read one repository file at a branch, tag, or commit. The content is Base64 encoded by GitLab.',
        inputSchema: z.object({
          project: projectSchema,
          path: z.string(),
          ref: z.string().optional(),
        }),
        run: ({ project, path, ref }) => {
          if (!path || path.startsWith('/') || path.split('/').includes('..'))
            throw new Error('gitlab connector: invalid repository path');
          return projectGet(project, `repository/files/${encodeURIComponent(path)}`, {
            ref: ref ?? 'HEAD',
          });
        },
      }),
      gtool({
        name: 'list_merge_requests',
        description: 'List recent merge requests in one synchronized project.',
        inputSchema: z.object({
          project: projectSchema,
          state: z.string().optional(),
          target_branch: z.string().optional(),
          per_page: z.number().optional(),
        }),
        run: ({ project, state, target_branch, per_page }) =>
          projectGet(
            project,
            'merge_requests',
            q({
              state,
              target_branch,
              order_by: 'updated_at',
              sort: 'desc',
              per_page: per_page ?? DEFAULT_PER_PAGE,
            }),
          ),
      }),
      gtool({
        name: 'list_pipelines',
        description: 'List recent CI pipelines in one synchronized project.',
        inputSchema: z.object({
          project: projectSchema,
          ref: z.string().optional(),
          status: z.string().optional(),
          sha: z.string().optional(),
          per_page: z.number().optional(),
        }),
        run: ({ project, ref, status, sha, per_page }) =>
          projectGet(
            project,
            'pipelines',
            q({
              ref,
              status,
              sha,
              order_by: 'updated_at',
              sort: 'desc',
              per_page: per_page ?? DEFAULT_PER_PAGE,
            }),
          ),
      }),
      gtool({
        name: 'get_pipeline_jobs',
        description: 'List jobs and statuses for one pipeline.',
        inputSchema: z.object({
          project: projectSchema,
          pipeline_id: z.number(),
          per_page: z.number().optional(),
        }),
        run: ({ project, pipeline_id, per_page }) =>
          projectGet(project, `pipelines/${pipeline_id}/jobs`, {
            per_page: per_page ?? 100,
          }),
      }),
      gtool({
        name: 'get_job_trace',
        description:
          'Fetch the bounded tail of a CI job trace. Logs may contain secrets GitLab did not mask.',
        inputSchema: z.object({ project: projectSchema, job_id: z.number() }),
        run: ({ project, job_id }) => projectGet(project, `jobs/${job_id}/trace`),
      }),
      gtool({
        name: 'list_deployments',
        description: 'List recent environment deployments in one synchronized project.',
        inputSchema: z.object({
          project: projectSchema,
          status: z.string().optional(),
          environment: z.string().optional(),
          per_page: z.number().optional(),
        }),
        run: ({ project, status, environment, per_page }) =>
          projectGet(
            project,
            'deployments',
            q({
              status,
              environment,
              order_by: 'updated_at',
              sort: 'desc',
              per_page: per_page ?? DEFAULT_PER_PAGE,
            }),
          ),
      }),
    ];
  }

  return [
    gtool({
      name: 'api_get',
      description:
        'GET any GitLab REST v4 endpoint by path (relative to /api/v4), e.g. "projects/123/pipelines" ' +
        'or "projects/group%2Frepo/merge_requests". Read-only. Optional query params. Secret values ' +
        '(CI variables, tokens, webhook secrets) are redacted. Use this for anything the named tools omit.',
      inputSchema: z.object({
        path: z.string(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
      run: ({ path, query }) => get(path, query),
    }),
    gtool({
      name: 'list_pipelines',
      description:
        'List recent CI pipelines for a project (newest first). Filter by ref/status/sha.',
      inputSchema: z.object({
        project: z.union([z.string(), z.number()]).optional(),
        ref: z.string().optional(),
        status: z.string().optional(),
        sha: z.string().optional(),
        per_page: z.number().optional(),
      }),
      run: ({ project, ref, status, sha, per_page }) =>
        get(
          `projects/${encodeProject(project, settings)}/pipelines`,
          q({
            ref,
            status,
            sha,
            order_by: 'updated_at',
            sort: 'desc',
            per_page: per_page ?? DEFAULT_PER_PAGE,
          }),
        ),
    }),
    gtool({
      name: 'get_pipeline_jobs',
      description: 'List the jobs of a pipeline, with each job status and stage.',
      inputSchema: z.object({
        project: z.union([z.string(), z.number()]).optional(),
        pipeline_id: z.number(),
        per_page: z.number().optional(),
      }),
      run: ({ project, pipeline_id, per_page }) =>
        get(
          `projects/${encodeProject(project, settings)}/pipelines/${pipeline_id}/jobs`,
          q({ per_page: per_page ?? 100 }),
        ),
    }),
    gtool({
      name: 'get_job_trace',
      description:
        'Fetch a job log (trace). Returns bounded text (last ~64K characters). Traces may contain ' +
        'secrets not marked masked in GitLab — treat as sensitive.',
      inputSchema: z.object({
        project: z.union([z.string(), z.number()]).optional(),
        job_id: z.number(),
      }),
      run: ({ project, job_id }) =>
        get(`projects/${encodeProject(project, settings)}/jobs/${job_id}/trace`),
    }),
    gtool({
      name: 'list_commits',
      description:
        'List recent commits for a project. Filter by ref and since/until ISO timestamps.',
      inputSchema: z.object({
        project: z.union([z.string(), z.number()]).optional(),
        ref_name: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        per_page: z.number().optional(),
      }),
      run: ({ project, ref_name, since, until, per_page }) =>
        get(
          `projects/${encodeProject(project, settings)}/repository/commits`,
          q({ ref_name, since, until, per_page: per_page ?? DEFAULT_PER_PAGE }),
        ),
    }),
    gtool({
      name: 'list_merge_requests',
      description:
        'List merge requests for a project. Filter by state (opened/merged/closed) and target branch.',
      inputSchema: z.object({
        project: z.union([z.string(), z.number()]).optional(),
        state: z.string().optional(),
        target_branch: z.string().optional(),
        per_page: z.number().optional(),
      }),
      run: ({ project, state, target_branch, per_page }) =>
        get(
          `projects/${encodeProject(project, settings)}/merge_requests`,
          q({
            state,
            target_branch,
            order_by: 'updated_at',
            sort: 'desc',
            per_page: per_page ?? DEFAULT_PER_PAGE,
          }),
        ),
    }),
    gtool({
      name: 'list_issues',
      description:
        'List issues for a project. Filter by state (opened/closed) and comma-separated labels.',
      inputSchema: z.object({
        project: z.union([z.string(), z.number()]).optional(),
        state: z.string().optional(),
        labels: z.string().optional(),
        per_page: z.number().optional(),
      }),
      run: ({ project, state, labels, per_page }) =>
        get(
          `projects/${encodeProject(project, settings)}/issues`,
          q({ state, labels, per_page: per_page ?? DEFAULT_PER_PAGE }),
        ),
    }),
  ];
}
