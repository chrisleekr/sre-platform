import type { ConnectorConfig } from '../../registry';
import type { SourceCodeReader, SourceComparison, SourceRepository } from '../../types';
import { obj, str } from '../../values';
import { resolveSourceRepository } from '../../source-repository';
import { SourceFileNotFoundError } from '../../source-file-error';
import { topologyFetch } from '../../topology-transport';
import type { InstallationTokenProvider } from './auth';
import {
  GITHUB_API,
  GitHubApiError,
  boundedPage,
  ghHeaders,
  parseRepo,
  type FetchLike,
} from './client';

const MAX_SOURCE_BYTES = 256 * 1024;

/**
 * Build a validated absolute GET URL under the pinned host. The path is resolved with WHATWG URL
 * normalization (so `..` collapses) and the origin must equal the pinned origin, which closes
 * SSRF/traversal. GET-only by construction, so no tool routed through here can mutate. GitHub's API
 * root is `/` (no version prefix like GitLab's `/api/v4`), so an origin check is the whole guard.
 */
export function buildGetUrl(
  base: string,
  path: string,
  query?: Record<string, string | number>,
): string {
  const baseUrl = new URL(base.replace(/\/+$/, '') + '/');
  const u = new URL(path.replace(/^\/+/, ''), baseUrl);
  if (u.origin !== baseUrl.origin)
    throw new Error('github connector: path escapes the configured host');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

/** GET a GitHub REST endpoint. The token rides the Authorization header, never the URL. `signal` is the tool caller's cancellation. */
export async function ghGet(
  fetchImpl: FetchLike,
  token: string,
  path: string,
  query?: Record<string, string | number>,
  accept = 'application/vnd.github+json',
  signal?: AbortSignal,
): Promise<unknown> {
  const url = buildGetUrl(GITHUB_API, path, query);
  return (await boundedPage(fetchImpl, url, { ...ghHeaders(token), Accept: accept }, 'GET', signal))
    .body;
}

function immutableGitRevision(value: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(value))
    throw new Error('github connector: provider did not resolve an immutable commit');
  return value;
}

function sourcePath(path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new Error('github connector: invalid repository path');
  return path;
}

function githubSourceUrl(repository: SourceRepository, revision: string, path?: string): string {
  const parsed = parseRepo(repository.fullName);
  const root = `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  if (!path) return `${root}/commit/${encodeURIComponent(revision)}`;
  return `${root}/blob/${encodeURIComponent(revision)}/${sourcePath(path)
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function decodeGitHubSource(raw: unknown): string {
  const file = obj(raw);
  if (file.encoding !== 'base64' || typeof file.content !== 'string')
    throw new Error('github connector: expected a Base64 repository file');
  const normalized = file.content.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized))
    throw new Error('github connector: invalid Base64 repository content');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.byteLength > MAX_SOURCE_BYTES)
    throw new Error('github connector: source file exceeds byte limit');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('github connector: repository file is not UTF-8 text');
  }
  if (text.includes('\0')) throw new Error('github connector: repository file is binary');
  return text;
}

function assertGitHubRepository(config: ConnectorConfig, repository: SourceRepository): void {
  if (repository.dataSourceId !== config.id || repository.provider !== 'github')
    throw new Error('github connector: repository belongs to another data source');
  parseRepo(repository.fullName);
}

async function readRegularBlob(
  fetchImpl: FetchLike,
  token: string,
  repo: string,
  revision: string,
  path: string,
) {
  const parts = path.split('/');
  if (parts.length > 32) throw new Error('github connector: source path exceeds depth limit');
  const bounded = topologyFetch(fetchImpl);
  const commit = obj(await ghGet(bounded, token, `${repo}/git/commits/${revision}`));
  if (str(commit.sha)?.toLowerCase() !== revision.toLowerCase())
    throw new Error('github connector: source commit did not match requested revision');
  let sha = immutableGitRevision(str(obj(commit.tree).sha) ?? '');
  // Contents dereferences symlinks. Walk pinned nonrecursive trees so path confinement is real.
  for (let index = 0; index < parts.length; index++) {
    const tree = obj(await ghGet(bounded, token, `${repo}/git/trees/${sha}`));
    if (tree.truncated !== false || !Array.isArray(tree.tree))
      throw new Error('github connector: incomplete source tree');
    const entries = tree.tree.map(obj).filter((entry) => entry.path === parts[index]);
    if (!entries.length) throw new SourceFileNotFoundError();
    if (entries.length !== 1) throw new Error('github connector: ambiguous source tree entry');
    const entry = entries[0]!;
    const leaf = index === parts.length - 1;
    if (
      leaf
        ? entry.type !== 'blob' || !['100644', '100755'].includes(String(entry.mode))
        : entry.type !== 'tree' || entry.mode !== '040000'
    )
      throw new Error('github connector: source path is not a regular file');
    sha = immutableGitRevision(str(entry.sha) ?? '');
  }
  return ghGet(bounded, token, `${repo}/git/blobs/${sha}`);
}

export function makeGitHubSourceCodeReader(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  auth: InstallationTokenProvider,
): SourceCodeReader {
  const tokenFor = async (repository: SourceRepository) => {
    assertGitHubRepository(config, repository);
    return auth.token([repository.fullName]);
  };
  return {
    resolveRepository: (reference) => resolveSourceRepository(config, 'github', reference),
    async resolve(service) {
      const repositories = (await config.repositories?.resolve(service)) ?? [];
      return repositories.map((repository) => ({
        dataSourceId: config.id,
        dataSourceName: config.name,
        provider: 'github' as const,
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
        webUrl: repository.htmlUrl,
        pathPrefix: repository.path?.replace(/^\/+|\/+$/g, '') || null,
        mappingSource: repository.mappingSource ?? null,
        role:
          repository.role ??
          (repository.mappingSource === 'argocd' ? 'deployment_config' : 'application_source'),
        resolution: repository.confirmed
          ? ('confirmed_mapping' as const)
          : repository.source === 'exact_name'
            ? ('exact_name' as const)
            : ('discovered_mapping' as const),
      }));
    },
    async verifyRevision(repository, revision) {
      const { owner, repo } = parseRepo(repository.fullName);
      const raw = obj(
        await ghGet(
          fetchImpl,
          await tokenFor(repository),
          `repos/${owner}/${repo}/commits/${encodeURIComponent(revision)}`,
        ),
      );
      const resolved = immutableGitRevision(str(raw.sha) ?? '');
      return { revision: resolved, providerUrl: githubSourceUrl(repository, resolved) };
    },
    async search(repository, query, limit) {
      if (!query.trim() || query.length > 256)
        throw new Error('github connector: invalid code search query');
      const page = Math.min(Math.max(1, Math.floor(limit)), 20);
      const raw = obj(
        await ghGet(
          fetchImpl,
          await tokenFor(repository),
          'search/code',
          { q: `${query} repo:${repository.fullName}`, per_page: page },
          'application/vnd.github.text-match+json',
        ),
      );
      const items = Array.isArray(raw.items) ? raw.items.slice(0, page) : [];
      return {
        incomplete: raw.incomplete_results === true,
        matches: items.flatMap((candidate) => {
          const item = obj(candidate);
          const path = str(item.path);
          if (!path) return [];
          const matches = Array.isArray(item.text_matches) ? item.text_matches : [];
          const fragment = matches.map((match) => str(obj(match).fragment)).find(Boolean) ?? null;
          return [
            {
              path,
              scope: { kind: 'default_branch' as const, ref: repository.defaultBranch },
              fragment,
              line: null,
            },
          ];
        }),
      };
    },
    async read(repository, revision, path) {
      const immutable = immutableGitRevision(revision);
      const { owner, repo } = parseRepo(repository.fullName);
      const safePath = sourcePath(path);
      const raw = await readRegularBlob(
        fetchImpl,
        await tokenFor(repository),
        `repos/${owner}/${repo}`,
        immutable,
        safePath,
      ).catch((error) => {
        if (error instanceof GitHubApiError && error.status === 404)
          throw new SourceFileNotFoundError();
        throw error;
      });
      return {
        path: safePath,
        revision: immutable,
        text: decodeGitHubSource(raw),
        providerUrl: githubSourceUrl(repository, immutable, safePath),
      };
    },
    async compare(repository, baseRevision, headRevision): Promise<SourceComparison> {
      const base = immutableGitRevision(baseRevision);
      const head = immutableGitRevision(headRevision);
      const { owner, repo } = parseRepo(repository.fullName);
      const raw = obj(
        await ghGet(
          fetchImpl,
          await tokenFor(repository),
          `repos/${owner}/${repo}/compare/${base}...${head}`,
        ),
      );
      const files = Array.isArray(raw.files) ? raw.files.slice(0, 300) : [];
      return {
        files: files.flatMap((candidate) => {
          const file = obj(candidate);
          const path = str(file.filename);
          return path ? [{ path, status: str(file.status) ?? 'modified' }] : [];
        }),
        filesIncomplete: Array.isArray(raw.files) && raw.files.length >= 300,
      };
    },
  };
}
