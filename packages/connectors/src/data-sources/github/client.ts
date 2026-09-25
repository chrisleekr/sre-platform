import { str } from '../../values';
import { SourceRateLimitError } from '../../source-file-error';
import { TopologyReadError } from '../../topology-transport';
import { rateLimitEvidence, type GitHubRateLimitEvidence } from './auth';
import { boundedSignal } from '../../request-signal';

/**
 * SaaS-only, pinned host. The origin is fully determined by our own code, so — as
 * with Datadog — the token can only ever reach real GitHub, never an attacker-chosen host (CWE-918),
 * and no DNS/SSRF guard is needed for the API calls. GitHub Enterprise Server (self-hosted, base path
 * `/api/v3`) is a documented future extension, not this edition.
 */
export const GITHUB_API = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
export const API_TIMEOUT_MS = 8000;
export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;
export const JOBS_PER_PAGE = 100;
// Job logs can be MB; triage needs the failing tail, so keep the last N characters.
export const MAX_LOG_CHARS = 64 * 1024;
export const TRIAGE_PER_PAGE = 20;
export const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
export const MAX_PAGES = 10;
export const MAX_DEPLOYMENTS_PER_POLL = 100;
export const MAX_ACTIVE_DEPLOYMENTS = 50;
export const MAX_SOURCE_BYTES = 256 * 1024;

/** Injectable so the REST calls are unit-testable without the network. */
export type FetchLike = typeof fetch;

export const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly failureCategory:
      'permission_denied' | 'rate_limited' | 'provider_unavailable' | 'unreachable' | 'provider',
    readonly status: number | null = null,
    readonly rateLimit: GitHubRateLimitEvidence = {},
  ) {
    super(message);
  }
}

export type GitHubInstallationDiscoveryFailure =
  | 'invalid_private_key'
  | 'credentials_rejected'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'unreachable'
  | 'invalid_response';

/** Sanitized setup failure. Provider response bodies and submitted credentials never cross this boundary. */
export class GitHubInstallationDiscoveryError extends Error {
  constructor(
    readonly failureCategory: GitHubInstallationDiscoveryFailure,
    readonly upstreamStatus: number | null = null,
    readonly rateLimit: GitHubRateLimitEvidence = {},
  ) {
    super(`github installation discovery failed: ${failureCategory}`);
    this.name = 'GitHubInstallationDiscoveryError';
  }
}

/**
 * Split an "owner/name" ref into two path segments, each validated against GitHub's allowed charset.
 * This is what stops a crafted ref (`owner="../.."`) from injecting into the URL path — stronger than
 * relying on URL normalization alone.
 */
export function parseRepo(ref: string): { owner: string; repo: string } {
  const parts = ref.split('/');
  if (parts.length !== 2 || !REPO_SEGMENT.test(parts[0]!) || !REPO_SEGMENT.test(parts[1]!)) {
    throw new Error('github connector: repo must be "owner/name" (letters, digits, ., _, -)');
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

/** The repo to query: an explicit tool arg, else the configured default. No service inference. */
export function resolveRepo(
  arg: string | undefined,
  settings: Record<string, unknown>,
): { owner: string; repo: string } {
  const ref = arg ?? str(settings.repo);
  if (!ref) {
    throw new Error(
      'github connector: no repo — pass "repo" as "owner/name" or set settings.repo; use list_repositories to discover accessible repos',
    );
  }
  return parseRepo(ref);
}

export function clampPerPage(n?: number): number {
  return Math.min(Math.max(1, Math.floor(n ?? DEFAULT_PER_PAGE)), MAX_PER_PAGE);
}

export function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
}

export function appHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('github api response exceeds byte limit');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('github api response exceeds byte limit');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text);
}

export function nextPageUrl(link: string | null): string | null {
  if (!link) return null;
  const match = link
    .split(',')
    .map((part) => part.trim().match(/^<([^>]+)>;\s*rel="?next"?$/i))
    .find((candidate) => candidate !== null);
  if (!match) return null;
  const next = new URL(match[1]!);
  if (next.origin !== new URL(GITHUB_API).origin)
    throw new Error('github pagination escaped the pinned origin');
  return next.toString();
}

export async function boundedPage(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  method = 'GET',
  signal?: AbortSignal,
): Promise<{ body: unknown; next: string | null; rateLimit: GitHubRateLimitEvidence }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      signal: boundedSignal(API_TIMEOUT_MS, signal),
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof SourceRateLimitError || error instanceof TopologyReadError) throw error;
    throw new GitHubApiError('github api did not respond', 'unreachable');
  }
  if (!response.ok) {
    const remainingHeader = response.headers.get('x-ratelimit-remaining');
    const rateLimit = rateLimitEvidence(response.headers);
    const failureCategory =
      response.status === 429 ||
      (response.status === 403 && remainingHeader !== null && Number(remainingHeader) === 0)
        ? 'rate_limited'
        : response.status === 401 || response.status === 403 || response.status === 404
          ? 'permission_denied'
          : response.status >= 500
            ? 'provider_unavailable'
            : 'provider';
    throw new GitHubApiError(
      `github api ${response.status}`,
      failureCategory,
      response.status,
      rateLimit,
    );
  }
  return {
    body: await readBoundedJson(response),
    next: nextPageUrl(response.headers.get('link')),
    rateLimit: rateLimitEvidence(response.headers),
  };
}

export async function boundedCollection(
  fetchImpl: FetchLike,
  initialUrl: string,
  headers: Record<string, string>,
  extract: (body: unknown) => unknown[],
  totalLimit = MAX_PAGES * MAX_PER_PAGE,
): Promise<{ values: unknown[]; rateLimit: GitHubRateLimitEvidence; truncated: boolean }> {
  const values: unknown[] = [];
  const seen = new Set<string>();
  let rateLimit: GitHubRateLimitEvidence = {};
  let url: string | null = initialUrl;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    if (seen.has(url)) throw new Error('github api repeated a pagination link');
    seen.add(url);
    const current = await boundedPage(fetchImpl, url, headers);
    const pageValues = extract(current.body);
    if (pageValues.length > MAX_PER_PAGE)
      throw new Error('github api response exceeds page item limit');
    const remaining = Math.max(0, totalLimit - values.length);
    const pageTruncated = pageValues.length > remaining;
    values.push(...pageValues.slice(0, remaining));
    rateLimit = { ...rateLimit, ...current.rateLimit };
    if (values.length >= totalLimit)
      return { values, rateLimit, truncated: pageTruncated || current.next !== null };
    url = current.next;
  }
  if (url) throw new Error('github api response exceeds page limit');
  return { values, rateLimit, truncated: false };
}

export interface GitHubInstallationSummary {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: 'all' | 'selected';
  permissions: Record<string, 'read' | 'write'>;
  /** Every provider permission granted at write level, including permissions SRE Platform never uses. */
  writePermissions?: string[];
  appSlug?: string;
}

export interface GitHubManifestConversion {
  appId: string;
  appSlug: string;
  appUrl: string;
  privateKey: string;
  webhookSecret: string;
}
