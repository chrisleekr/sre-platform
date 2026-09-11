import { obj, str } from '../../values';
import { mintInstallationToken, resolveAppIdentity, resolveCreds, signAppJwt } from './auth';
import {
  API_VERSION,
  GITHUB_API,
  GitHubApiError,
  GitHubInstallationDiscoveryError,
  appHeaders,
  boundedCollection,
  boundedPage,
  ghHeaders,
  type FetchLike,
  type GitHubInstallationSummary,
  type GitHubManifestConversion,
} from './client';

/**
 * Exchanges a one-time GitHub App manifest code for generated credentials.
 *
 * @param code - One-time manifest conversion code returned by GitHub.
 * @param fetchImpl - HTTP transport used for the conversion request.
 */
export async function convertGitHubAppManifest(
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<GitHubManifestConversion> {
  if (!/^[A-Za-z0-9_-]{16,255}$/.test(code)) throw new Error('invalid GitHub App manifest code');
  const { body } = await boundedPage(
    fetchImpl,
    `${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`,
    { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION },
    'POST',
  );
  const raw = obj(body);
  const appId = raw.id;
  const appSlug = str(raw.slug);
  const appUrl = str(raw.html_url);
  const privateKey = str(raw.pem);
  const webhookSecret = str(raw.webhook_secret);
  if (
    (typeof appId !== 'number' && typeof appId !== 'string') ||
    !appSlug ||
    !appUrl ||
    !privateKey ||
    !webhookSecret
  )
    throw new Error('GitHub App manifest conversion returned incomplete credentials');
  return { appId: String(appId), appSlug, appUrl, privateKey, webhookSecret };
}

export interface GitHubRepositorySummary {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch?: string;
  private: boolean;
  archived: boolean;
  webUrl: string;
  pushedAt?: string;
}

const ALLOWED_PERMISSIONS = ['deployments', 'metadata', 'contents', 'pull_requests', 'actions'];

/**
 * Lists installations visible to validated GitHub App credentials.
 *
 * @param settings - GitHub App identity settings.
 * @param credential - Write-only private key credential or credential bundle.
 * @param fetchImpl - HTTP transport used for GitHub API requests.
 */
export async function discoverGitHubInstallations(
  settings: Record<string, unknown>,
  credential: string,
  fetchImpl: FetchLike = fetch,
): Promise<GitHubInstallationSummary[]> {
  let headers: Record<string, string>;
  try {
    const identity = resolveAppIdentity(settings, credential);
    const jwt = signAppJwt({ ...identity, installationId: 0 }, Math.floor(Date.now() / 1000));
    headers = appHeaders(jwt);
  } catch {
    throw new GitHubInstallationDiscoveryError('invalid_private_key');
  }

  let appSlug: string | undefined;
  let values: unknown[];
  try {
    const app = await boundedPage(fetchImpl, `${GITHUB_API}/app`, headers);
    appSlug = str(obj(app.body).slug);
    ({ values } = await boundedCollection(
      fetchImpl,
      `${GITHUB_API}/app/installations?per_page=100`,
      headers,
      (body) => (Array.isArray(body) ? body : []),
    ));
  } catch (error) {
    if (error instanceof GitHubApiError) {
      const failureCategory =
        error.failureCategory === 'permission_denied'
          ? 'credentials_rejected'
          : error.failureCategory === 'provider'
            ? 'invalid_response'
            : error.failureCategory;
      throw new GitHubInstallationDiscoveryError(failureCategory, error.status, error.rateLimit);
    }
    throw new GitHubInstallationDiscoveryError('invalid_response');
  }
  return values.flatMap((raw) => {
    const installation = obj(raw);
    const account = obj(installation.account);
    const id = installation.id;
    const accountLogin = str(account.login);
    const accountType = str(account.type);
    const repositorySelection = str(installation.repository_selection);
    if (
      typeof id !== 'number' ||
      !accountLogin ||
      !accountType ||
      (repositorySelection !== 'all' && repositorySelection !== 'selected')
    )
      return [];
    const rawPermissions = obj(installation.permissions);
    const permissions = Object.fromEntries(
      ALLOWED_PERMISSIONS.flatMap((key) => {
        const value = str(rawPermissions[key]);
        return value === 'read' || value === 'write' ? [[key, value]] : [];
      }),
    ) as Record<string, 'read' | 'write'>;
    const writePermissions = Object.entries(rawPermissions)
      .flatMap(([name, value]) => (value === 'write' ? [name] : []))
      .sort();
    return [
      {
        id,
        accountLogin,
        accountType,
        repositorySelection,
        permissions,
        writePermissions,
        ...(appSlug ? { appSlug } : {}),
      },
    ];
  });
}

/**
 * Lists every repository visible to one GitHub App installation.
 *
 * @param settings - GitHub App and installation settings.
 * @param credential - Write-only private key credential or credential bundle.
 * @param fetchImpl - HTTP transport used for GitHub API requests.
 */
export async function discoverGitHubRepositories(
  settings: Record<string, unknown>,
  credential: string,
  fetchImpl: FetchLike = fetch,
): Promise<GitHubRepositorySummary[]> {
  const creds = resolveCreds(credential, settings);
  const minted = await mintInstallationToken(
    fetchImpl,
    GITHUB_API,
    creds,
    Math.floor(Date.now() / 1000),
  );
  const { values } = await boundedCollection(
    fetchImpl,
    `${GITHUB_API}/installation/repositories?per_page=100`,
    ghHeaders(minted.token),
    (body) => {
      const repositories = obj(body).repositories;
      return Array.isArray(repositories) ? repositories : [];
    },
  );
  return values.flatMap((raw) => {
    const repository = obj(raw);
    const id = repository.id;
    const name = str(repository.name);
    const fullName = str(repository.full_name);
    const webUrl = str(repository.html_url);
    const owner = str(obj(repository.owner).login) ?? fullName?.split('/')[0];
    const defaultBranch = str(repository.default_branch);
    const pushedAt = str(repository.pushed_at);
    if (typeof id !== 'number' || !owner || !name || !fullName || !webUrl) return [];
    return [
      {
        id,
        owner,
        name,
        fullName,
        ...(defaultBranch ? { defaultBranch } : {}),
        private: repository.private === true,
        archived: repository.archived === true,
        webUrl,
        ...(pushedAt ? { pushedAt } : {}),
      },
    ];
  });
}
