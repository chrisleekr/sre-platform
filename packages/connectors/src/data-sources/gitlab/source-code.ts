import type { ConnectorConfig } from '../../registry';
import type { HostLookup } from '../../ssrf';
import type { SourceCodeReader, SourceComparison, SourceRepository } from '../../types';
import { obj, str } from '../../values';
import { resolveSourceRepository } from '../../source-repository';
import { SourceFileNotFoundError } from '../../source-file-error';
import { connectorToken } from './auth';
import {
  API_TIMEOUT_MS,
  MAX_SOURCE_BYTES,
  apiBase,
  apiFetch,
  buildApiUrl,
  readBoundedText,
  type FetchLike,
} from './client';
import { sanitizeGitLab } from './sanitize';

function immutableGitRevision(value: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(value))
    throw new Error('gitlab connector: provider did not resolve an immutable commit');
  return value;
}

function sourcePath(path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new Error('gitlab connector: invalid repository path');
  return path;
}

function trustedGitLabWebUrl(base: string, repository: SourceRepository): URL {
  const provider = new URL(base);
  const candidate = new URL(repository.webUrl);
  const apiSuffix = '/api/v4';
  const providerRoot = provider.pathname.endsWith(apiSuffix)
    ? provider.pathname.slice(0, -apiSuffix.length)
    : provider.pathname;
  if (
    candidate.username ||
    candidate.password ||
    candidate.origin !== provider.origin ||
    (providerRoot && !candidate.pathname.startsWith(`${providerRoot}/`))
  )
    throw new Error('gitlab connector: repository URL escaped the configured provider');
  return candidate;
}

function gitLabSourceUrl(
  base: string,
  repository: SourceRepository,
  revision: string,
  path?: string,
): string {
  const root = trustedGitLabWebUrl(base, repository).toString().replace(/\/+$/, '');
  if (!path) return `${root}/-/commit/${encodeURIComponent(revision)}`;
  return `${root}/-/blob/${encodeURIComponent(revision)}/${sourcePath(path)
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

export async function makeGitLabSourceCodeReader(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
): Promise<SourceCodeReader> {
  const base = await apiBase(config.settings, lookup);
  const token = async () => connectorToken(config);
  const assertRepository = async (repository: SourceRepository): Promise<void> => {
    if (repository.dataSourceId !== config.id || repository.provider !== 'gitlab')
      throw new Error('gitlab connector: repository belongs to another data source');
    const normalized = repository.fullName.trim().toLowerCase();
    const matches = (await config.repositories?.search(repository.fullName, 50)) ?? [];
    if (!matches.some((candidate) => candidate.fullName.toLowerCase() === normalized))
      throw new Error('gitlab connector: project is outside the synchronized group catalog');
  };
  const projectUrl = (
    repository: SourceRepository,
    suffix: string,
    query?: Record<string, string | number>,
  ) =>
    buildApiUrl(
      base,
      `projects/${encodeURIComponent(repository.fullName)}/${suffix.replace(/^\/+/, '')}`,
      query,
    );
  const getJson = async (
    repository: SourceRepository,
    suffix: string,
    query?: Record<string, string | number>,
  ): Promise<unknown> => {
    await assertRepository(repository);
    const response = await apiFetch(
      fetchImpl,
      projectUrl(repository, suffix, query),
      await token(),
    );
    if (response.json === undefined) throw new Error('gitlab connector: expected JSON response');
    return sanitizeGitLab(new URL(projectUrl(repository, suffix, query)).pathname, response.json);
  };
  return {
    resolveRepository: (reference) => resolveSourceRepository(config, 'gitlab', reference),
    async resolve(service) {
      const repositories = (await config.repositories?.resolve(service)) ?? [];
      return repositories.map((repository) => ({
        dataSourceId: config.id,
        dataSourceName: config.name,
        provider: 'gitlab' as const,
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
      const raw = obj(
        await getJson(repository, `repository/commits/${encodeURIComponent(revision)}`),
      );
      const resolved = immutableGitRevision(str(raw.id) ?? '');
      return { revision: resolved, providerUrl: gitLabSourceUrl(base, repository, resolved) };
    },
    async search(repository, query, limit) {
      if (!query.trim() || query.length > 256)
        throw new Error('gitlab connector: invalid code search query');
      const page = Math.min(Math.max(1, Math.floor(limit)), 20);
      const raw = await getJson(repository, 'search', {
        scope: 'blobs',
        search: query,
        per_page: page,
      });
      const values = Array.isArray(raw) ? raw.slice(0, page) : [];
      return {
        incomplete: values.length >= page,
        matches: values.flatMap((candidate) => {
          const match = obj(candidate);
          const path = str(match.path) ?? str(match.filename);
          if (!path) return [];
          return [
            {
              path,
              scope: {
                kind: 'default_branch' as const,
                ref: str(match.ref) ?? repository.defaultBranch,
              },
              fragment: str(match.data) ?? null,
              line: typeof match.startline === 'number' ? match.startline : null,
            },
          ];
        }),
      };
    },
    async read(repository, revision, path) {
      await assertRepository(repository);
      const immutable = immutableGitRevision(revision);
      const safePath = sourcePath(path);
      const response = await fetchImpl(
        projectUrl(repository, `repository/files/${encodeURIComponent(safePath)}/raw`, {
          ref: immutable,
        }),
        {
          headers: { 'PRIVATE-TOKEN': await token() },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
          redirect: 'error',
        },
      );
      if (response.status === 404) throw new SourceFileNotFoundError();
      if (!response.ok) throw new Error(`gitlab api ${response.status}`);
      const text = await readBoundedText(response, MAX_SOURCE_BYTES);
      if (text.includes('\0')) throw new Error('gitlab connector: repository file is binary');
      return {
        path: safePath,
        revision: immutable,
        text,
        providerUrl: gitLabSourceUrl(base, repository, immutable, safePath),
      };
    },
    async compare(repository, baseRevision, headRevision): Promise<SourceComparison> {
      const baseRevisionSafe = immutableGitRevision(baseRevision);
      const headRevisionSafe = immutableGitRevision(headRevision);
      const raw = obj(
        await getJson(repository, 'repository/compare', {
          from: baseRevisionSafe,
          to: headRevisionSafe,
          straight: 'true',
        }),
      );
      const rawDiffs = Array.isArray(raw.diffs) ? raw.diffs : [];
      const diffs = rawDiffs.slice(0, 300);
      return {
        files: diffs.flatMap((candidate) => {
          const diff = obj(candidate);
          const path = str(diff.new_path) ?? str(diff.old_path);
          return path
            ? [
                {
                  path,
                  status: diff.new_file
                    ? 'added'
                    : diff.deleted_file
                      ? 'removed'
                      : diff.renamed_file
                        ? 'renamed'
                        : 'modified',
                },
              ]
            : [];
        }),
        filesIncomplete: raw.compare_timeout === true || rawDiffs.length > diffs.length,
      };
    },
  };
}
