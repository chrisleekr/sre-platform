import type { ConnectorConfig } from '../../registry';
import { argoCdUrlError } from '@sre/contracts';
import { assertSafeHttpOrHttpsUrl, type HostLookup } from '../../ssrf';
import { obj, str } from '../../values';
import { topologyReadIssue } from '../../topology-transport';
import { boundedSignal } from '../../request-signal';

/** Injectable so the REST calls are unit-testable without the network. */
export type FetchLike = typeof fetch;

export const API_TIMEOUT_MS = 8000;
export const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_JSON_BYTES = 16 * 1024;
export const MAX_LOG_CHARS = 64 * 1024;
export const MAX_LOG_RETAIN_BYTES = MAX_LOG_CHARS * 4;
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TAIL_LINES = 100;
export const MAX_TAIL_LINES = 1000;
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_APPLICATIONS = 200;
export const MAX_HISTORY_PER_APPLICATION = 20;
export const MAX_CONDITIONS_PER_APPLICATION = 50;
export const MAX_APPLICATION_SCOPES = 50;
export const MAX_BASE_URL_CHARS = 2048;
export const MAX_TOKEN_BYTES = 64 * 1024;
export const MAX_NAME_CHARS = 253;
export const MAX_NAMESPACE_CHARS = 63;
export const LEGACY_PROJECT_ROLE = 'sre-platform';

// The manifest state fields on a managed-resources item; each is a JSON-encoded k8s manifest that can
// carry live Secret data, so every one is parsed and scrubbed before it reaches the model.
export const STATE_FIELDS = [
  'targetState',
  'liveState',
  'normalizedLiveState',
  'predictedLiveState',
] as const;

// Last path segments api_get refuses: every endpoint that returns raw/rendered k8s manifests (which
// carry live Secret data). managed-resources has a masking bypass (GHSA-3v3m-wc6v-x4x3); resource
// (GetResource) and manifests / manifests-with-files (GetManifests) are denied for the same reason the
// diff path is — the connector does not trust ArgoCD's own hideSecretData. Reach scrubbed manifests via
// get_managed_resources instead.
export const DENIED_SEGMENTS: ReadonlySet<string> = new Set([
  'managed-resources',
  'resource',
  'manifests',
  'manifests-with-files',
]);

// ArgoCD application/namespace names are Kubernetes RFC1123 names. Validating a path segment against
// this before interpolating kills traversal/query-smuggling in `/applications/{name}/...`.
export const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
export const SCOPE_SEGMENT_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$|^\*$/;
export const ACCOUNT_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isValidName(v: string): boolean {
  return NAME_RE.test(v);
}

/** Validate a model-controlled path segment, throwing before any fetch when it is not a k8s name. */
export function validateName(field: string, value: string): string {
  if (!isValidName(value)) throw new Error(`argocd connector: invalid ${field} '${value}'`);
  return value;
}

export interface TlsOpts {
  ca?: string;
  rejectUnauthorized?: boolean;
}
/** Bun's fetch accepts a `tls` option that the DOM RequestInit type omits (mirrors prometheus). */
type FetchInit = RequestInit & { tls?: TlsOpts };

/**
 * Bun fetch `tls` for server trust from settings: a pinned CA (a private/self-signed ArgoCD ingress
 * that system trust cannot verify) and/or the explicit insecure escape hatch. Same vocabulary as the
 * Prometheus connector. ArgoCD auth is a bearer token, so there is no client cert here.
 */
export function buildServerTls(settings: Record<string, unknown>): TlsOpts | undefined {
  const caCert = str(settings.caCert);
  const insecure = settings.insecureSkipTLSVerify === true;
  if (caCert && insecure) return { ca: caCert, rejectUnauthorized: false };
  if (caCert) return { ca: caCert };
  if (insecure) return { rejectUnauthorized: false };
  return undefined;
}

/** Resolve Argo CD with SSRF checks; plaintext HTTP is confined to internal networks. */
export async function resolveBase(
  settings: Record<string, unknown>,
  lookup: HostLookup,
): Promise<string> {
  const raw = str(settings.baseUrl);
  if (!raw) throw new Error('argocd connector: baseUrl is required');
  if (raw.length > MAX_BASE_URL_CHARS)
    throw new Error('argocd connector: baseUrl exceeds length limit');
  const error = argoCdUrlError(raw);
  if (error) throw new Error(error);
  let addresses: string[] = [];
  const url = await assertSafeHttpOrHttpsUrl(
    raw,
    async (hostname) => {
      addresses = await lookup(hostname);
      return addresses;
    },
    {
      allowPrivate: true,
      requirePrivate: new URL(raw).protocol === 'http:',
    },
  );
  // Do not re-resolve a hostname after approving plaintext delivery to a private IP.
  if (url.protocol === 'http:' && addresses.length) {
    const address = addresses[0]!;
    url.hostname = address.includes(':') ? `[${address}]` : address;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export type QueryValue = string | number | string[];

/**
 * Build a validated absolute GET URL under the pinned host. The path is WHATWG-normalized (so `..`
 * collapses) and three assertions close SSRF/traversal: the origin must equal the SSRF-checked base
 * origin, the pathname must stay under `<base>/api/` (a path-prefixed ingress still validates), and the
 * pathname must carry no percent-encoding. The last one matters because a downstream string check on a
 * path segment (the `api_get` manifest-endpoint denylist) compares decoded words, while ArgoCD's
 * grpc-gateway also decodes the path before routing: an encoded `managed-resource%73` would slip a
 * literal-string denylist yet still hit the real handler. Legitimate ArgoCD paths are RFC1123 names,
 * hex revisions, and fixed segments, none of which need `%`; query values live in the search component
 * (encoded there) and are unaffected. GET-only by construction, so no tool routed through here can mutate.
 */
export function buildGetUrl(
  base: string,
  path: string,
  query?: Record<string, QueryValue | undefined>,
): string {
  const baseUrl = new URL(base.replace(/\/+$/, '') + '/');
  const u = new URL(path.replace(/^\/+/, ''), baseUrl);
  if (u.origin !== baseUrl.origin)
    throw new Error('argocd connector: path escapes the configured host');
  if (!u.pathname.startsWith(`${baseUrl.pathname}api/`))
    throw new Error('argocd connector: path must be under /api/');
  if (u.pathname.includes('%'))
    throw new Error('argocd connector: percent-encoded path segments are not allowed');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) {
        for (const item of v) if (item !== '') u.searchParams.append(k, String(item));
      } else {
        u.searchParams.set(k, String(v));
      }
    }
  }
  return u.toString();
}

/** The connection primitives shared by every read path (tools, first-pass, probe). */
export interface ArgoClient {
  base: string;
  hostHeader?: string;
  token: string;
  serverTls: TlsOpts | undefined;
  signal?: AbortSignal;
}

export async function connect(config: ConnectorConfig, lookup: HostLookup): Promise<ArgoClient> {
  configuredScopes(config.settings);
  const identity = str(config.settings.identity) ?? str(config.settings.account);
  const projectRole = /^proj:[a-z0-9]([-a-z0-9.]*[a-z0-9])?:[A-Za-z0-9._-]+$/.test(identity ?? '');
  const localAccount =
    identity &&
    identity !== 'admin' &&
    ACCOUNT_RE.test(identity) &&
    new TextEncoder().encode(identity).byteLength <= 32;
  if (!projectRole && !localAccount)
    throw new Error('argocd connector: a project role identity is required');
  const base = await resolveBase(config.settings, lookup);
  // A missing credential throws here and propagates (the tool degrades to error, never a fake read).
  const token = (await config.getCredential()).trim();
  if (!token) throw new Error('argocd connector: credential (API token) is required');
  if (new TextEncoder().encode(token).byteLength > MAX_TOKEN_BYTES)
    throw new Error('argocd connector: credential exceeds length limit');
  return {
    base,
    token,
    ...(base.startsWith('http:')
      ? { hostHeader: new URL(String(config.settings.baseUrl)).host }
      : {}),
    serverTls: base.startsWith('https:') ? buildServerTls(config.settings) : undefined,
  };
}

/** Request init: the bearer token rides a header (never the URL), 8s timeout, no redirects. */
export function aInit(client: ArgoClient): FetchInit {
  return {
    headers: {
      Authorization: `Bearer ${client.token}`,
      Accept: 'application/json',
      ...(client.hostHeader ? { Host: client.hostHeader } : {}),
    },
    signal: boundedSignal(API_TIMEOUT_MS, client.signal),
    redirect: 'error',
    tls: client.serverTls,
  };
}

/** GET an ArgoCD endpoint and parse JSON. */
export async function aget(
  fetchImpl: FetchLike,
  client: ArgoClient,
  path: string,
  query?: Record<string, QueryValue | undefined>,
): Promise<unknown> {
  return checkedJsonGet(fetchImpl, client, path, query);
}

/** GET an ArgoCD endpoint and return the raw body text (the logs stream is newline-delimited JSON). */
export async function atext(
  fetchImpl: FetchLike,
  client: ArgoClient,
  path: string,
  query?: Record<string, QueryValue | undefined>,
): Promise<string> {
  const response = await checkedGet(fetchImpl, client, path, query);
  return boundedText(response, MAX_LOG_BYTES, MAX_LOG_RETAIN_BYTES);
}

export class ArgoApiError extends Error {
  constructor(
    message: string,
    readonly failureCategory:
      'permission_denied' | 'provider_unavailable' | 'unreachable' | 'backlog' | 'tls',
  ) {
    super(message);
    this.name = 'ArgoApiError';
  }
}

export class ArgoPermissionError extends ArgoApiError {
  constructor(
    message: string,
    readonly check: 'required_reads' | 'deny_samples',
  ) {
    super(message, 'permission_denied');
    this.name = 'ArgoPermissionError';
  }
}

export const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

export function isTlsFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const raw = current as Record<string, unknown>;
    if (typeof raw.code === 'string' && TLS_ERROR_CODES.has(raw.code)) return true;
    if (
      typeof raw.message === 'string' &&
      /(certificate|self[- ]signed|unable to verify|unknown ca|hostname.*match)/i.test(raw.message)
    )
      return true;
    current = raw.cause;
  }
  return false;
}

export function abortAsUnavailable(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new ArgoApiError('argocd probe deadline exceeded', 'unreachable')),
      { once: true },
    );
  });
}

export async function boundedJson(response: Response, limit = MAX_JSON_BYTES): Promise<unknown> {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new ArgoApiError('argocd response exceeds byte limit', 'backlog');
  }
  if (!response.body?.getReader) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > limit)
      throw new ArgoApiError('argocd response exceeds byte limit', 'backlog');
    try {
      return JSON.parse(body);
    } catch {
      throw new ArgoApiError('argocd returned invalid JSON', 'provider_unavailable');
    }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new ArgoApiError('argocd response exceeds byte limit', 'backlog');
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined));
  } catch {
    throw new ArgoApiError('argocd returned invalid JSON', 'provider_unavailable');
  }
}

export async function boundedText(
  response: Response,
  totalLimit: number,
  retainLimit: number,
): Promise<string> {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > totalLimit) {
    await response.body?.cancel();
    throw new ArgoApiError('argocd response exceeds byte limit', 'backlog');
  }
  if (!response.body?.getReader) {
    const body = await response.text();
    const encoded = new TextEncoder().encode(body);
    if (encoded.byteLength > totalLimit)
      throw new ArgoApiError('argocd response exceeds byte limit', 'backlog');
    return new TextDecoder().decode(encoded.slice(-retainLimit));
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let tail = new Uint8Array(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > totalLimit) {
      await reader.cancel();
      throw new ArgoApiError('argocd response exceeds byte limit', 'backlog');
    }
    if (value.byteLength >= retainLimit) {
      tail = value.slice(-retainLimit);
      continue;
    }
    const combined = new Uint8Array(Math.min(retainLimit, tail.byteLength + value.byteLength));
    const previous = tail.slice(-Math.max(0, combined.byteLength - value.byteLength));
    combined.set(previous, 0);
    combined.set(value, previous.byteLength);
    tail = combined;
  }
  return new TextDecoder().decode(tail);
}

export async function checkedGet(
  fetchImpl: FetchLike,
  client: ArgoClient,
  path: string,
  query?: Record<string, QueryValue | undefined>,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(buildGetUrl(client.base, path, query), aInit(client));
  } catch (error) {
    if (topologyReadIssue(error)) throw error;
    const tls = isTlsFailure(error);
    throw new ArgoApiError(
      tls ? 'argocd TLS verification failed' : 'argocd did not respond',
      tls ? 'tls' : 'unreachable',
    );
  }
  if (!response.ok) {
    const category =
      response.status === 401 || response.status === 403 || response.status === 404
        ? 'permission_denied'
        : 'provider_unavailable';
    throw new ArgoApiError(`argocd api ${response.status}`, category);
  }
  return response;
}

export async function checkedJsonGet(
  fetchImpl: FetchLike,
  client: ArgoClient,
  path: string,
  query?: Record<string, QueryValue | undefined>,
  limit?: number,
): Promise<unknown> {
  return boundedJson(await checkedGet(fetchImpl, client, path, query), limit);
}

export interface ApplicationScope {
  project: string;
  name: string;
  namespace?: string;
}

export function configuredScopes(settings: Record<string, unknown>): ApplicationScope[] {
  if (
    !Array.isArray(settings.applications) ||
    settings.applications.length === 0 ||
    settings.applications.length > MAX_APPLICATION_SCOPES ||
    (settings.applicationsInAnyNamespace !== true && settings.applicationsInAnyNamespace !== false)
  )
    throw new ArgoApiError('argocd application scope is missing or invalid', 'permission_denied');
  const anyNamespace = settings.applicationsInAnyNamespace === true;
  return settings.applications.map((value) => {
    const raw = obj(value);
    const project = str(raw.project);
    const name = str(raw.name);
    const namespace = str(raw.namespace);
    if (
      !project ||
      !name ||
      project.length > MAX_NAME_CHARS ||
      name.length > MAX_NAME_CHARS ||
      !SCOPE_SEGMENT_RE.test(project) ||
      !SCOPE_SEGMENT_RE.test(name) ||
      (anyNamespace &&
        (!namespace ||
          namespace.length > MAX_NAMESPACE_CHARS ||
          !SCOPE_SEGMENT_RE.test(namespace))) ||
      (!anyNamespace && raw.namespace !== undefined)
    )
      throw new ArgoApiError('argocd application scope is missing or invalid', 'permission_denied');
    return { project, name, ...(namespace ? { namespace } : {}) };
  });
}
