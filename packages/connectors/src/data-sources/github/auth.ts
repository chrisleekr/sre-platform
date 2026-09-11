import { createPrivateKey, createSign } from 'node:crypto';
import * as z from 'zod';
import type { ConnectorConfig } from '../../registry';

/** Legacy opaque credential shape. New saves keep app/installation IDs in settings and encrypt only
 * the private key; the parser retains this shape until existing rows are rewritten. */
const GitHubCreds = z.object({
  appId: z.union([z.string().min(1), z.number()]),
  privateKey: z.string().min(1),
  installationId: z.union([z.string().min(1), z.number()]),
});
export type GitHubCreds = z.infer<typeof GitHubCreds>;

const GitHubCredentialBundle = z.object({
  version: z.literal(2),
  privateKey: z.string().min(1),
  webhookSecret: z.string().min(16),
  smeeUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.hostname === 'smee.io' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    })
    .optional(),
});
export type GitHubCredentialBundle = z.infer<typeof GitHubCredentialBundle>;

export interface GitHubRateLimitEvidence {
  remaining?: number;
  resetAt?: string;
}

interface GitHubTokenScope {
  repositories?: string[];
  permissions: Record<string, 'read'>;
}

interface RuntimeTokenScope {
  scope: GitHubTokenScope;
  grantedPermissions: Record<string, 'read' | 'write'>;
  writePermissions: string[];
  rateLimit: GitHubRateLimitEvidence;
}

const RUNTIME_PERMISSION_KEYS = ['contents', 'pull_requests', 'actions', 'deployments'] as const;

function repositoryNames(fullNames: string[]): string[] {
  if (fullNames.length > 500)
    throw new Error('github connector: token scope exceeds 500 repositories');
  const names = fullNames.map((fullName) => {
    const parts = fullName.trim().split('/');
    if (
      parts.length !== 2 ||
      !parts[0] ||
      !parts[1] ||
      !/^[A-Za-z0-9._-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9._-]+$/.test(parts[1])
    )
      throw new Error('github connector: repository scope must use owner/name');
    return parts[1];
  });
  return [...new Set(names)].sort();
}

async function runtimeTokenScope(
  fetchImpl: typeof fetch,
  apiBase: string,
  creds: GitHubCreds,
  repositories: string[],
  nowSec: number,
): Promise<RuntimeTokenScope> {
  const scopedRepositories = repositoryNames(repositories);
  const jwt = signAppJwt(creds, nowSec);
  let response: Response;
  try {
    response = await fetchImpl(
      `${apiBase}/app/installations/${encodeURIComponent(String(creds.installationId))}`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
        },
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
        redirect: 'error',
      },
    );
  } catch {
    throw new GitHubAuthError('github connector: installation metadata did not respond', null);
  }
  const rateLimit = rateLimitEvidence(response.headers);
  if (!response.ok) {
    // The token endpoint remains the authority for App/installation authentication. If this
    // permission refresh is unavailable, mint the minimum Contents-read runtime token rather than
    // inheriting installation-wide permissions.
    return {
      scope: {
        ...(scopedRepositories.length > 0 ? { repositories: scopedRepositories } : {}),
        permissions: { contents: 'read' },
      },
      grantedPermissions: {},
      writePermissions: [],
      rateLimit,
    };
  }
  const body = await readAuthJson(response);
  const rawPermissions =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).permissions
      : undefined;
  const granted =
    rawPermissions !== null && typeof rawPermissions === 'object' && !Array.isArray(rawPermissions)
      ? (rawPermissions as Record<string, unknown>)
      : {};
  const grantedPermissions: Record<string, 'read' | 'write'> = {};
  const permissions: Record<string, 'read'> = {};
  const writePermissions = Object.entries(granted)
    .flatMap(([name, value]) => (value === 'write' ? [name] : []))
    .sort();
  for (const name of RUNTIME_PERMISSION_KEYS) {
    const value = granted[name];
    if (value === 'read' || value === 'write') {
      grantedPermissions[name] = value;
      permissions[name] = 'read';
    }
  }
  return {
    scope: {
      ...(scopedRepositories.length > 0 ? { repositories: scopedRepositories } : {}),
      permissions,
    },
    grantedPermissions,
    writePermissions,
    rateLimit,
  };
}

const API_VERSION = '2022-11-28';
const MINT_TIMEOUT_MS = 8000;
// Re-mint when the cached token is within this margin of expiry, so a long tool never rides a token
// that expires mid-flight.
const REFRESH_MARGIN_MS = 60_000;
const FALLBACK_TTL_MS = 3_600_000; // GitHub installation tokens last 1h; used if expires_at is unparseable.
const MAX_AUTH_RESPONSE_BYTES = 256 * 1024;

/** Carries the HTTP status of a failed mint so `probe()` can tell auth failure from unreachability. */
class GitHubAuthError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly rateLimit?: GitHubRateLimitEvidence,
  ) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

async function readAuthJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUTH_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new GitHubAuthError('github connector: auth response exceeds byte limit', null);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/** Resolve either a split private-key credential or the legacy opaque JSON shape. */
export function resolveCreds(
  credential: string,
  settings: Record<string, unknown> = {},
): GitHubCreds {
  try {
    const parsed = JSON.parse(credential);
    const bundle = GitHubCredentialBundle.safeParse(parsed);
    if (bundle.success) {
      return GitHubCreds.parse({
        appId: settings.appId,
        installationId: settings.installationId,
        privateKey: bundle.data.privateKey,
      });
    }
    return GitHubCreds.parse(parsed);
  } catch {
    try {
      return GitHubCreds.parse({
        appId: settings.appId,
        installationId: settings.installationId,
        privateKey: credential,
      });
    } catch {
      throw new GitHubAuthError(
        'github connector: credential must be a private key with appId and installationId settings or legacy JSON',
        null,
      );
    }
  }
}

export function resolveAppIdentity(
  settings: Record<string, unknown>,
  credential: string,
): Pick<GitHubCreds, 'appId' | 'privateKey'> {
  try {
    const raw = JSON.parse(credential);
    const bundle = GitHubCredentialBundle.safeParse(raw);
    if (bundle.success) {
      return z
        .object({ appId: z.union([z.string().min(1), z.number()]), privateKey: z.string().min(1) })
        .parse({ appId: settings.appId, privateKey: bundle.data.privateKey });
    }
    const legacy = GitHubCreds.parse(raw);
    return { appId: legacy.appId, privateKey: legacy.privateKey };
  } catch {
    const parsed = z
      .object({ appId: z.union([z.string().min(1), z.number()]), privateKey: z.string().min(1) })
      .parse({ appId: settings.appId, privateKey: credential });
    return parsed;
  }
}

/**
 * Extracts the webhook secret from a versioned GitHub credential bundle.
 *
 * @param credential - Stored GitHub credential value.
 */
export function githubWebhookSecret(credential: string): string | null {
  try {
    const parsed = GitHubCredentialBundle.safeParse(JSON.parse(credential));
    return parsed.success ? parsed.data.webhookSecret : null;
  } catch {
    return null;
  }
}

/**
 * Extracts the optional Smee relay URL from a versioned GitHub credential bundle.
 *
 * @param credential - Stored GitHub credential value.
 */
export function githubSmeeUrl(credential: string): string | null {
  try {
    const parsed = GitHubCredentialBundle.safeParse(JSON.parse(credential));
    return parsed.success ? (parsed.data.smeeUrl ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Extracts the private key while retaining support for legacy raw-key credentials.
 *
 * @param credential - Stored GitHub credential value.
 */
export function githubPrivateKey(credential: string): string {
  try {
    const parsed = GitHubCredentialBundle.safeParse(JSON.parse(credential));
    return parsed.success ? parsed.data.privateKey : credential;
  } catch {
    return credential;
  }
}

/**
 * Serializes GitHub delivery credentials into the versioned write-only bundle.
 *
 * @param privateKey - GitHub App private key in PEM form.
 * @param webhookSecret - Secret used to verify GitHub webhook signatures.
 * @param smeeUrl - Optional development relay channel.
 */
export function githubCredentialBundle(
  privateKey: string,
  webhookSecret: string,
  smeeUrl?: string,
): string {
  return JSON.stringify(
    GitHubCredentialBundle.parse({ version: 2, privateKey, webhookSecret, smeeUrl }),
  );
}

export function rateLimitEvidence(headers: Headers): GitHubRateLimitEvidence {
  const remainingHeader = headers.get('x-ratelimit-remaining');
  const resetHeader = headers.get('x-ratelimit-reset');
  const remainingValue = remainingHeader === null ? Number.NaN : Number(remainingHeader);
  const resetSeconds = resetHeader === null ? Number.NaN : Number(resetHeader);
  return {
    ...(Number.isFinite(remainingValue) ? { remaining: remainingValue } : {}),
    ...(Number.isFinite(resetSeconds) && resetSeconds > 0
      ? { resetAt: new Date(resetSeconds * 1000).toISOString() }
      : {}),
  };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Sign an app-level JWT (RS256). `iat` is backdated 60s for clock drift and `exp` is 9 minutes out
 * (GitHub's hard ceiling is 10). `iss` is the app/client id. node:crypto reads GitHub's PKCS#1 PEM
 * natively (jose's importPKCS8 would reject it), so no extra dependency is needed.
 */
export function signAppJwt(creds: GitHubCreds, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(creds.appId) }),
  );
  const signingInput = `${header}.${payload}`;
  let key;
  try {
    key = createPrivateKey(creds.privateKey);
  } catch {
    throw new GitHubAuthError('github connector: privateKey is not a valid PEM', null);
  }
  const sig = createSign('RSA-SHA256').update(signingInput).sign(key);
  return `${signingInput}.${b64url(sig)}`;
}

type FetchLike = typeof fetch;

/**
 * Mint an installation access token. The app JWT rides the Authorization header; `redirect:'error'`
 * stops a 3xx bouncing the JWT elsewhere. A non-201 throws a GitHubAuthError carrying the status so
 * the probe can distinguish a bad key/installation (401/404) from a transient fault.
 */
export async function mintInstallationToken(
  fetchImpl: FetchLike,
  apiBase: string,
  creds: GitHubCreds,
  nowSec: number,
  scope?: GitHubTokenScope,
): Promise<{ token: string; expiresAtMs: number; rateLimit: GitHubRateLimitEvidence }> {
  const jwt = signAppJwt(creds, nowSec);
  const url = `${apiBase}/app/installations/${encodeURIComponent(String(creds.installationId))}/access_tokens`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...(scope ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(scope ? { body: JSON.stringify(scope) } : {}),
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new GitHubAuthError('github connector: token endpoint did not respond', null);
  }
  if (res.status !== 201) {
    throw new GitHubAuthError(
      `github connector: installation token mint failed (${res.status})`,
      res.status,
      rateLimitEvidence(res.headers),
    );
  }
  const body = (await readAuthJson(res)) as { token?: unknown; expires_at?: unknown };
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token)
    throw new GitHubAuthError('github connector: token mint returned no token', res.status);
  const parsed = Date.parse(String(body.expires_at));
  return {
    token,
    expiresAtMs: Number.isFinite(parsed) ? parsed : nowSec * 1000 + FALLBACK_TTL_MS,
    rateLimit: rateLimitEvidence(res.headers),
  };
}

/** A per-run source of a valid installation token. Memoized so one run mints once. */
export interface InstallationTokenProvider {
  token(repositories?: string[]): Promise<string>;
  evidence(): GitHubRateLimitEvidence | undefined;
}

/**
 * Build the token provider for one connector instance. Because the worker constructs a connector once
 * per triage run, this closure's cache lives for the whole run: the first tool call mints, the rest
 * reuse until the token nears expiry. `now` is injectable so the refresh margin is testable.
 */
export function makeInstallationTokenProvider(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  apiBase: string,
  now: () => number = () => Date.now(),
): InstallationTokenProvider {
  const cached = new Map<string, { token: string; expMs: number }>();
  let evidence: GitHubRateLimitEvidence | undefined;
  return {
    async token(repositories: string[] = []): Promise<string> {
      const nowMs = now();
      const key = repositoryNames(repositories).join(',') || '*';
      const hit = cached.get(key);
      if (hit && nowMs < hit.expMs - REFRESH_MARGIN_MS) return hit.token;
      const creds = resolveCreds(await config.getCredential(), config.settings);
      const runtime = await runtimeTokenScope(
        fetchImpl,
        apiBase,
        creds,
        repositories,
        Math.floor(nowMs / 1000),
      );
      const minted = await mintInstallationToken(
        fetchImpl,
        apiBase,
        creds,
        Math.floor(nowMs / 1000),
        runtime.scope,
      );
      evidence = { ...runtime.rateLimit, ...minted.rateLimit };
      cached.set(key, { token: minted.token, expMs: minted.expiresAtMs });
      return minted.token;
    },
    evidence: () => evidence,
  };
}

/**
 * Probe the auth chain: mint a token and report the outcome. Returns the installation token on 201.
 * Returns `{ status }` (no token) when the endpoint answered conclusively (401/404 → bad
 * key/installation) or transiently (null/5xx); the caller maps that to reachable/authorized.
 */
export async function probeMint(
  fetchImpl: FetchLike,
  apiBase: string,
  credential: string,
  nowMs: number,
  settings: Record<string, unknown> = {},
): Promise<
  | {
      token: string;
      rateLimit: GitHubRateLimitEvidence;
      grantedPermissions: Record<string, 'read' | 'write'>;
      writePermissions: string[];
    }
  | { status: number | null; rateLimit?: GitHubRateLimitEvidence }
> {
  const creds = resolveCreds(credential, settings);
  try {
    const runtime = await runtimeTokenScope(
      fetchImpl,
      apiBase,
      creds,
      [],
      Math.floor(nowMs / 1000),
    );
    const { token, rateLimit } = await mintInstallationToken(
      fetchImpl,
      apiBase,
      creds,
      Math.floor(nowMs / 1000),
      runtime.scope,
    );
    return {
      token,
      rateLimit: { ...runtime.rateLimit, ...rateLimit },
      grantedPermissions: runtime.grantedPermissions,
      writePermissions: runtime.writePermissions,
    };
  } catch (e) {
    if (e instanceof GitHubAuthError)
      return {
        status: e.status,
        ...(e.rateLimit && Object.keys(e.rateLimit).length > 0 ? { rateLimit: e.rateLimit } : {}),
      };
    throw e;
  }
}
