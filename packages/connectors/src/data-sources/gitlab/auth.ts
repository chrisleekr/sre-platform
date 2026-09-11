interface GitLabCredentialBundleV2 {
  version: 2;
  token: string;
  webhookSecret?: string;
}

interface GitLabCredentialBundleV3 {
  version: 3;
  token: string;
  webhookSecret?: string;
  webhookSigningToken?: string;
  smeeUrl?: string;
}

interface GitLabCredentialOptions {
  webhookSecret?: string;
  webhookSigningToken?: string;
  smeeUrl?: string;
}

type GitLabCredentialBundle = GitLabCredentialBundleV2 | GitLabCredentialBundleV3;

export async function connectorToken(config: ConnectorConfig): Promise<string> {
  const credential = await config.getCredential();
  const token = gitLabAccessToken(credential);
  if (!token) throw new Error('gitlab connector: no access token configured');
  return token;
}

function validSigningToken(value: string): boolean {
  if (!value.startsWith('whsec_')) return false;
  try {
    return Buffer.from(value.slice('whsec_'.length), 'base64').byteLength === 32;
  } catch {
    return false;
  }
}

function validSmeeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'smee.io' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function parseBundle(value: string): GitLabCredentialBundle | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const bundle = parsed as Record<string, unknown>;
    if (
      (bundle.version !== 2 && bundle.version !== 3) ||
      typeof bundle.token !== 'string' ||
      !bundle.token.trim()
    )
      return null;
    if (
      bundle.webhookSecret !== undefined &&
      (typeof bundle.webhookSecret !== 'string' || bundle.webhookSecret.length < 16)
    )
      return null;
    if (
      bundle.version === 3 &&
      bundle.webhookSigningToken !== undefined &&
      (typeof bundle.webhookSigningToken !== 'string' ||
        !validSigningToken(bundle.webhookSigningToken))
    )
      return null;
    if (
      bundle.version === 3 &&
      bundle.smeeUrl !== undefined &&
      (typeof bundle.smeeUrl !== 'string' || !validSmeeUrl(bundle.smeeUrl))
    )
      return null;
    return {
      version: bundle.version,
      token: bundle.token,
      ...(typeof bundle.webhookSecret === 'string' ? { webhookSecret: bundle.webhookSecret } : {}),
      ...(bundle.version === 3 && typeof bundle.webhookSigningToken === 'string'
        ? { webhookSigningToken: bundle.webhookSigningToken }
        : {}),
      ...(bundle.version === 3 && typeof bundle.smeeUrl === 'string'
        ? { smeeUrl: bundle.smeeUrl }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Serializes GitLab API and delivery credentials into one versioned write-only bundle.
 *
 * @param token - GitLab access token used for read-only API calls.
 * @param options - Optional webhook, signing, and development relay credentials.
 */
export function gitLabCredentialBundle(
  token: string,
  options: GitLabCredentialOptions = {},
): string {
  return JSON.stringify({ version: 3, token, ...options });
}

/**
 * Extracts the API token while retaining support for legacy raw-token credentials.
 *
 * @param credential - Stored GitLab credential value.
 */
export function gitLabAccessToken(credential: string): string | null {
  const bundle = parseBundle(credential);
  return (
    bundle?.token ?? (credential.trim() && !credential.trim().startsWith('{') ? credential : null)
  );
}

/**
 * Extracts the legacy webhook secret from a versioned GitLab credential bundle.
 *
 * @param credential - Stored GitLab credential value.
 */
export function gitLabWebhookSecret(credential: string): string | null {
  return parseBundle(credential)?.webhookSecret ?? null;
}

/**
 * Extracts the webhook bearer token from a versioned GitLab credential bundle.
 *
 * @param credential - Stored GitLab credential value.
 */
export function gitLabWebhookSigningToken(credential: string): string | null {
  const bundle = parseBundle(credential);
  return bundle?.version === 3 ? (bundle.webhookSigningToken ?? null) : null;
}

/**
 * Extracts the optional Smee relay URL from a versioned GitLab credential bundle.
 *
 * @param credential - Stored GitLab credential value.
 */
export function gitLabSmeeUrl(credential: string): string | null {
  const bundle = parseBundle(credential);
  return bundle?.version === 3 ? (bundle.smeeUrl ?? null) : null;
}
import type { ConnectorConfig } from '../../registry';
