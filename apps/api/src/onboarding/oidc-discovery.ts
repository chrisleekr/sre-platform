const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_MAX_BYTES = 64 * 1024;

export interface OidcMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

export interface JsonFetchOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  redirect: 'error';
}

export type JsonFetcher = (url: URL, options: JsonFetchOptions) => Promise<unknown>;

/** Represents a public discovery request that cannot safely produce provider metadata. */
export class OidcDiscoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OidcDiscoveryError';
  }
}

function issuerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcDiscoveryError('invalid_issuer', 'issuer must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new OidcDiscoveryError(
      'invalid_issuer',
      'issuer must be HTTPS without credentials, query, or fragment',
    );
  }
  return url;
}

function endpoint(document: Record<string, unknown>, name: string): string {
  const raw = document[name];
  if (typeof raw !== 'string') {
    throw new OidcDiscoveryError('invalid_metadata', `discovery document is missing ${name}`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcDiscoveryError('invalid_metadata', `discovery ${name} is not a valid URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new OidcDiscoveryError('invalid_metadata', `discovery ${name} must be a safe HTTPS URL`);
  }
  return url.href;
}

/** Discovers and validates the endpoints needed by the browser and API relay. */
export async function discoverOidcProvider(
  rawIssuer: string,
  dependencies: { fetchJson: JsonFetcher },
): Promise<OidcMetadata> {
  const issuer = issuerUrl(rawIssuer);
  const basePath = issuer.pathname.endsWith('/') ? issuer.pathname : `${issuer.pathname}/`;
  const discoveryUrl = new URL(issuer);
  discoveryUrl.pathname = `${basePath}.well-known/openid-configuration`;
  let value: unknown;
  try {
    value = await dependencies.fetchJson(discoveryUrl, {
      maxResponseBytes: DISCOVERY_MAX_BYTES,
      redirect: 'error',
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
  } catch (error) {
    throw new OidcDiscoveryError('discovery_failed', 'issuer discovery failed', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OidcDiscoveryError('invalid_metadata', 'discovery document must be an object');
  }
  const document = value as Record<string, unknown>;
  if (document.issuer !== rawIssuer) {
    throw new OidcDiscoveryError('issuer_mismatch', 'discovery issuer does not match the request');
  }
  return {
    issuer: rawIssuer,
    authorizationEndpoint: endpoint(document, 'authorization_endpoint'),
    tokenEndpoint: endpoint(document, 'token_endpoint'),
    jwksUri: endpoint(document, 'jwks_uri'),
  };
}
