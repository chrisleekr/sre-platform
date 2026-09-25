import * as z from 'zod';
import type { ConnectorConfig } from '../../registry';
import { assertSafeHttpsUrl, type HostLookup } from '../../ssrf';
import type { ConnectorTool, ToolRunOptions } from '../../types';
import { boundedSignal } from '../../request-signal';
import { obj, str } from '../../values';
import type { InstallationTokenProvider } from './auth';
import {
  API_TIMEOUT_MS,
  GITHUB_API,
  JOBS_PER_PAGE,
  MAX_LOG_CHARS,
  clampPerPage,
  ghHeaders,
  parseRepo,
  resolveRepo,
  type FetchLike,
} from './client';
import { buildGetUrl, ghGet } from './source-code';

/** Keep the last `max` characters; a log can be MB and triage needs the failing tail. */
function clampTail(text: string, max: number): { truncated: boolean; body: string } {
  if (text.length <= max) return { truncated: false, body: text };
  return { truncated: true, body: text.slice(text.length - max) };
}

/**
 * Fetch a job's logs. Unlike GitLab's inline trace, GitHub answers `/actions/jobs/{id}/logs` with a
 * 302 to a short-lived (1 min) signed blob URL on a DIFFERENT host (githubusercontent / Azure blob).
 * Handling that safely: don't auto-follow (redirect:'manual'); run the Location through the SSRF guard
 * (public-only, so a hypothetical bad Location can't reach internal infra); and — the key detail —
 * do NOT send our Bearer token to the third-party blob host (the URL is self-signed, docs: "anyone
 * with read access can use this endpoint"). No host allowlist: the blob host moves across GitHub's
 * CDNs, and since no credential is sent, the public-only guard is the correct control.
 */
async function fetchJobLogs(
  fetchImpl: FetchLike,
  token: string,
  owner: string,
  repo: string,
  jobId: number,
  lookup: HostLookup,
  signal?: AbortSignal,
): Promise<{ truncated: boolean; body: string }> {
  const url = buildGetUrl(GITHUB_API, `repos/${owner}/${repo}/actions/jobs/${jobId}/logs`);
  const res = await fetchImpl(url, {
    headers: ghHeaders(token),
    signal: boundedSignal(API_TIMEOUT_MS, signal),
    redirect: 'manual',
  });
  // Bun exposes the real 302 + Location under redirect:'manual' (a deliberate divergence from the
  // WHATWG opaque status-0 response). A runtime that returned the opaque form would surface status 0
  // here; treat that as unsupported rather than a confusing `github api 0`.
  if (res.status !== 302) {
    if (res.status === 0)
      throw new Error('github connector: runtime did not expose the job-logs redirect Location');
    // GitHub documents a 302; tolerate a direct 200 body, but fail loudly on anything else.
    if (res.ok) return clampTail(await res.text(), MAX_LOG_CHARS);
    throw new Error(`github api ${res.status}`);
  }
  const location = res.headers.get('location');
  if (!location) throw new Error('github connector: job logs redirect had no Location');
  await assertSafeHttpsUrl(location, lookup); // https + public only; rejects internal/metadata hosts
  const blob = await fetchImpl(location, {
    // No Authorization header: the signed blob URL needs none, and our token must not leak off-host.
    signal: boundedSignal(API_TIMEOUT_MS, signal),
    redirect: 'error',
  });
  if (!blob.ok) throw new Error(`github logs blob ${blob.status}`);
  return clampTail(await blob.text(), MAX_LOG_CHARS);
}

export function mapCommit(raw: unknown): Record<string, unknown> {
  const c = obj(raw);
  const commit = obj(c.commit);
  const author = obj(commit.author);
  const sha = str(c.sha);
  return {
    sha: sha ? sha.slice(0, 8) : undefined,
    message: str(commit.message)?.split('\n')[0],
    author: str(author.name),
    at: str(author.date),
    url: str(c.html_url),
  };
}

export function mapRun(raw: unknown): Record<string, unknown> {
  const r = obj(raw);
  return {
    id: r.id,
    name: str(r.name),
    status: str(r.status),
    conclusion: str(r.conclusion),
    event: str(r.event),
    branch: str(r.head_branch),
    at: str(r.updated_at),
    url: str(r.html_url),
  };
}

/** Drop undefined-valued keys so an omitted optional tool arg never becomes a literal "undefined". */
function q(o: Record<string, string | number | undefined>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/** Bind a Zod input schema to a typed run body, returning the erased ConnectorTool (mirror of others). */
function gtool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.infer<S>, options?: ToolRunOptions) => Promise<unknown>;
}): ConnectorTool {
  return def as ConnectorTool;
}

const repoArg = z.string().optional();

/**
 * GitHub granular triage tools. `api_get` is a GET-only passthrough over the whole
 * REST surface (origin-guarded); `list_repositories` enumerates the installation's accessible repos so
 * the agent can discover what it may read; the rest are ergonomic wrappers over the hot deploy-
 * correlation paths (commits / PRs / Actions), each defaulting the repo to `settings.repo`. GET-only,
 * so no tool can mutate. Output redaction is the dispatch layer's single choke point: GitHub
 * never returns Actions secret values (write-only) and Actions variables are non-secret, so there is
 * no structured-secret endpoint to path-gate — unlike GitLab's CI-variables. Job logs are arbitrary
 * text (the same accepted best-effort limit as GitLab traces / k8s pod logs).
 */
export function makeGitHubTools(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  auth: InstallationTokenProvider,
  lookup: HostLookup,
): ConnectorTool[] {
  const settings = config.settings;
  const repoOf = (arg: string | undefined) => resolveRepo(arg, settings);
  const getForRepo = async (
    repository: string,
    path: string,
    query?: Record<string, string | number>,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    ghGet(fetchImpl, await auth.token([repository]), path, query, undefined, signal);

  return [
    gtool({
      name: 'api_get',
      description:
        'GET a read-only REST endpoint beneath one repository. The path must start with the same ' +
        'repos/OWNER/REPO selected by repo, so the incident-scoped token cannot be used elsewhere.',
      inputSchema: z.object({
        repo: z.string(),
        path: z.string(),
        query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      }),
      run: ({ repo, path, query }, call) => {
        const parsed = parseRepo(repo);
        const normalized = path.replace(/^\/+/, '');
        const prefix = `repos/${parsed.owner}/${parsed.repo}`;
        if (normalized !== prefix && !normalized.startsWith(`${prefix}/`))
          throw new Error(
            'github connector: api_get path must stay inside the selected repository',
          );
        return getForRepo(repo, normalized, query, call?.signal);
      },
    }),
    gtool({
      name: 'resolve_repositories',
      description:
        'Resolve the repositories associated with an incident service from confirmed topology, ' +
        'Argo CD source evidence, and exact catalog matches.',
      inputSchema: z.object({ service: z.string() }),
      run: ({ service }) => config.repositories?.resolve(service) ?? Promise.resolve([]),
    }),
    gtool({
      name: 'search_repositories',
      description:
        'Search the installation-wide repository catalog by owner/name when service resolution is ' +
        'ambiguous. Returns bounded metadata, not repository contents.',
      inputSchema: z.object({ query: z.string(), limit: z.number().optional() }),
      run: ({ query, limit }) =>
        config.repositories?.search(query, Math.min(Math.max(1, limit ?? 20), 50)) ??
        Promise.resolve([]),
    }),
    gtool({
      name: 'list_recent_events',
      description:
        'List synchronized push, pull-request, workflow, and deployment evidence for selected ' +
        'repositories since an ISO timestamp.',
      inputSchema: z.object({
        repositories: z.array(z.string()).min(1).max(20),
        since: z.string(),
        limit: z.number().optional(),
      }),
      run: ({ repositories, since, limit }) => {
        const parsed = new Date(since);
        if (!Number.isFinite(parsed.getTime())) throw new Error('github connector: invalid since');
        repositories.forEach(parseRepo);
        return (
          config.repositories?.recentEvents(
            repositories,
            parsed,
            Math.min(Math.max(1, limit ?? 50), 100),
          ) ?? Promise.resolve([])
        );
      },
    }),
    gtool({
      name: 'list_commits',
      description:
        'List recent commits for a repo (newest first). Filter by sha/branch (sha), path, author, ' +
        'and since/until ISO timestamps.',
      inputSchema: z.object({
        repo: repoArg,
        sha: z.string().optional(),
        path: z.string().optional(),
        author: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        per_page: z.number().optional(),
      }),
      run: async ({ repo, sha, path, author, since, until, per_page }, call) => {
        const { owner, repo: name } = repoOf(repo);
        const repository = `${owner}/${name}`;
        return getForRepo(
          repository,
          `repos/${owner}/${name}/commits`,
          q({ sha, path, author, since, until, per_page: clampPerPage(per_page) }),
          call?.signal,
        );
      },
    }),
    gtool({
      name: 'get_commit',
      description:
        'Get one commit with its author, message, parent revisions, changed files, and patch metadata.',
      inputSchema: z.object({ repo: z.string(), ref: z.string() }),
      run: async ({ repo, ref }, call) => {
        const { owner, repo: name } = parseRepo(repo);
        return getForRepo(
          repo,
          `repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`,
          undefined,
          call?.signal,
        );
      },
    }),
    gtool({
      name: 'compare_commits',
      description:
        'Compare two revisions in one repository to identify commits and files changed between the ' +
        'last known-good and incident revisions.',
      inputSchema: z.object({ repo: z.string(), base: z.string(), head: z.string() }),
      run: async ({ repo, base, head }, call) => {
        const { owner, repo: name } = parseRepo(repo);
        return getForRepo(
          repo,
          `repos/${owner}/${name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
          undefined,
          call?.signal,
        );
      },
    }),
    gtool({
      name: 'search_code',
      description:
        'Search code inside one resolved repository for an error symbol, stack-trace path, ' +
        'configuration key, or diagnostic string. Results are bounded and repository-scoped.',
      inputSchema: z.object({
        repo: z.string(),
        query: z.string(),
        per_page: z.number().optional(),
      }),
      run: async ({ repo, query, per_page }, call) => {
        parseRepo(repo);
        return getForRepo(
          repo,
          'search/code',
          {
            q: `${query} repo:${repo}`,
            per_page: Math.min(Math.max(1, Math.floor(per_page ?? 20)), 50),
          },
          call?.signal,
        );
      },
    }),
    gtool({
      name: 'get_content',
      description:
        'Read one file or directory at an optional revision from a resolved repository. File content ' +
        'is bounded to the provider response limits and remains read-only.',
      inputSchema: z.object({ repo: z.string(), path: z.string(), ref: z.string().optional() }),
      run: async ({ repo, path, ref }, call) => {
        const { owner, repo: name } = parseRepo(repo);
        if (!path || path.startsWith('/') || path.split('/').includes('..'))
          throw new Error('github connector: invalid repository path');
        return getForRepo(
          repo,
          `repos/${owner}/${name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
          q({ ref }),
          call?.signal,
        );
      },
    }),
    gtool({
      name: 'list_pull_requests',
      description:
        'List pull requests for a repo. Filter by state (open/closed/all), base branch, head, and ' +
        'sort (created/updated/popularity).',
      inputSchema: z.object({
        repo: repoArg,
        state: z.string().optional(),
        base: z.string().optional(),
        head: z.string().optional(),
        sort: z.string().optional(),
        direction: z.string().optional(),
        per_page: z.number().optional(),
      }),
      run: async ({ repo, state, base, head, sort, direction, per_page }, call) => {
        const { owner, repo: name } = repoOf(repo);
        const repository = `${owner}/${name}`;
        return getForRepo(
          repository,
          `repos/${owner}/${name}/pulls`,
          q({ state, base, head, sort, direction, per_page: clampPerPage(per_page) }),
          call?.signal,
        );
      },
    }),
    gtool({
      name: 'get_pull_request',
      description:
        'Get a single pull request by number (title, state, merge status, head/base sha).',
      inputSchema: z.object({ repo: repoArg, number: z.number() }),
      run: async ({ repo, number }, call) => {
        const { owner, repo: name } = repoOf(repo);
        const repository = `${owner}/${name}`;
        return getForRepo(
          repository,
          `repos/${owner}/${name}/pulls/${number}`,
          undefined,
          call?.signal,
        );
      },
    }),
    gtool({
      name: 'list_workflow_runs',
      description:
        'List recent GitHub Actions workflow runs for a repo (newest first). Filter by branch, ' +
        'event, status (e.g. completed/failure/in_progress), and actor. The core deploy-correlation ' +
        'tool.',
      inputSchema: z.object({
        repo: repoArg,
        branch: z.string().optional(),
        event: z.string().optional(),
        status: z.string().optional(),
        actor: z.string().optional(),
        per_page: z.number().optional(),
      }),
      run: async ({ repo, branch, event, status, actor, per_page }, call) => {
        const { owner, repo: name } = repoOf(repo);
        const repository = `${owner}/${name}`;
        return getForRepo(
          repository,
          `repos/${owner}/${name}/actions/runs`,
          q({ branch, event, status, actor, per_page: clampPerPage(per_page) }),
          call?.signal,
        );
      },
    }),
    gtool({
      name: 'get_workflow_run_jobs',
      description:
        'List the jobs of a workflow run, each with its status, conclusion, and failing-step names.',
      inputSchema: z.object({
        repo: repoArg,
        run_id: z.number(),
        per_page: z.number().optional(),
      }),
      run: async ({ repo, run_id, per_page }, call) => {
        const { owner, repo: name } = repoOf(repo);
        const repository = `${owner}/${name}`;
        return getForRepo(
          repository,
          `repos/${owner}/${name}/actions/runs/${run_id}/jobs`,
          q({ per_page: clampPerPage(per_page ?? JOBS_PER_PAGE) }),
          call?.signal,
        );
      },
    }),
    gtool({
      name: 'get_job_logs',
      description:
        'Fetch a workflow job log. Returns bounded plain text (last ~64K characters). Logs may ' +
        'contain secrets not masked by GitHub — treat as sensitive.',
      inputSchema: z.object({ repo: repoArg, job_id: z.number() }),
      run: async ({ repo, job_id }, call) => {
        const { owner, repo: name } = repoOf(repo);
        const repository = `${owner}/${name}`;
        return fetchJobLogs(
          fetchImpl,
          await auth.token([repository]),
          owner,
          name,
          job_id,
          lookup,
          call?.signal,
        );
      },
    }),
  ];
}
