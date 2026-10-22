// Paths whose responses carry this connector's own API/application keys or the platform's lifecycle
// webhook bearer (`custom_headers` on webhook integrations). Output is not redacted, so these reads
// are refused before the fetch rather than scrubbed after it.
const DENIED_DATADOG_PREFIXES = [
  '/api/v1/api_key',
  '/api/v2/api_keys',
  '/api/v1/application_key',
  '/api/v2/application_keys',
  '/api/v2/current_user/application_keys',
  '/api/v1/integration/webhooks',
];

/**
 * True when `pathname` reaches a key-management or webhook-config endpoint. Normalizes case, repeated
 * slashes and a trailing slash first; refuses any `%` outright so an encoded segment cannot slip past
 * the prefix match. Any `application_keys` segment is denied (service-account keys live under it too).
 */
export function isDeniedDatadogPath(pathname: string): boolean {
  const p = pathname.toLowerCase().replace(/\/+/g, '/').replace(/\/$/, '');
  if (p.includes('%')) return true;
  if (p.split('/').includes('application_keys')) return true;
  return DENIED_DATADOG_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Build a validated absolute GET URL under the pinned host. The path is resolved with WHATWG URL
 * normalization (so `..` collapses) and two assertions close SSRF/traversal: the origin must equal
 * the allowlisted base origin, and the pathname must stay under `/api/`. GET-only by construction,
 * so no tool routed through here can mutate.
 */
export function buildGetUrl(
  base: string,
  path: string,
  query?: Record<string, string | number>,
): string {
  const baseUrl = new URL(base.replace(/\/+$/, '') + '/');
  const u = new URL(path.replace(/^\/+/, ''), baseUrl);
  if (u.origin !== baseUrl.origin)
    throw new Error('datadog connector: path escapes the configured host');
  if (!u.pathname.startsWith('/api/'))
    throw new Error('datadog connector: path must be under /api/');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}
