import { assertSafeHttpsUrl, type HostLookup } from '../../ssrf';
import { str } from '../../values';

export type FetchLike = typeof fetch;

/**
 * GitLab REST v4 base for the tenant's instance; self-hosted URL from connector settings.
 * The shared guard requires https and permits private self-managed instances while still rejecting
 * loopback, link-local, and metadata targets (SSRF, CWE-918). The token rides the PRIVATE-TOKEN
 * header every poll cadence, so plaintext http is refused too.
 */
export async function apiBase(
  settings: Record<string, unknown>,
  lookup: HostLookup,
): Promise<string> {
  const raw = str(settings.baseUrl) ?? 'https://gitlab.com';
  // Build from the validated URL, not the raw string, so a query/fragment/userinfo can't corrupt the path.
  const url = await assertSafeHttpsUrl(raw, lookup, { allowPrivate: true });
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/v4`;
}

/** The project to inspect: an explicit `projectId` setting, else the incident's service as a path. */
export function projectRef(settings: Record<string, unknown>, service: string): string {
  const configured = settings.projectId;
  if (typeof configured === 'number') return String(configured);
  if (typeof configured === 'string' && configured.length > 0)
    return encodeURIComponent(configured);
  return encodeURIComponent(service);
}

export const MAX_PER_PAGE = 100;
export const MAX_PAGES = 10;
export const MAX_CATALOG_PAGES = 50;
export const DEFAULT_PER_PAGE = 20;
export const API_TIMEOUT_MS = 8000;
export const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
export const MAX_TRACE_TAIL_BYTES = 64 * 1024;
export const MAX_SOURCE_BYTES = 256 * 1024;

export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('gitlab api response exceeds byte limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('gitlab api response exceeds byte limit');
    }
    text += decoder.decode(value, { stream: true });
  }
}

export async function readStreamingTail(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  let tail = new Uint8Array(0);
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return {
        text: new TextDecoder().decode(tail),
        truncated: total > maxBytes,
      };
    }
    total += value.byteLength;
    if (value.byteLength >= maxBytes) {
      tail = value.slice(value.byteLength - maxBytes);
      continue;
    }
    const keepFromExisting = Math.min(tail.byteLength, maxBytes - value.byteLength);
    const next = new Uint8Array(keepFromExisting + value.byteLength);
    next.set(tail.subarray(tail.byteLength - keepFromExisting));
    next.set(value, keepFromExisting);
    tail = next;
  }
}

export function requestedPageSize(url: string): number {
  const requested = Number(new URL(url).searchParams.get('per_page')) || DEFAULT_PER_PAGE;
  return Math.min(Math.max(1, Math.floor(requested)), MAX_PER_PAGE);
}

export async function responseArray(response: Response, url: string): Promise<unknown[]> {
  const text = await readBoundedText(response, MAX_JSON_RESPONSE_BYTES);
  const body: unknown = JSON.parse(text);
  if (!Array.isArray(body)) throw new Error('gitlab api expected an array response');
  if (body.length > requestedPageSize(url))
    throw new Error('gitlab api response exceeds page item limit');
  return body;
}

export async function requestArrayPage(
  fetchImpl: FetchLike,
  url: string,
  token: string,
): Promise<{ response: Response; values: unknown[] }> {
  // The token travels in the PRIVATE-TOKEN header, never the URL, so it cannot leak via error text.
  const res = await fetchImpl(url, {
    headers: { 'PRIVATE-TOKEN': token },
    // fetch has no default timeout; bound the tenant-controlled request so a dead/slow host cannot
    // hang the tool call, engine loop, and worker slot (noisy-neighbor DoS, CWE-400).
    signal: AbortSignal.timeout(8000),
    // Don't follow redirects: a 3xx from the configured host could otherwise bypass the host guard.
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`gitlab api ${res.status}`);
  return { response: res, values: await responseArray(res, url) };
}

export async function getArray(
  fetchImpl: FetchLike,
  url: string,
  token: string,
): Promise<unknown[]> {
  return (await requestArrayPage(fetchImpl, url, token)).values;
}

export function nextPageUrl(link: string | null, base: string): string | null {
  if (!link) return null;
  const match = link
    .split(',')
    .map((part) => part.trim().match(/^<([^>]+)>;\s*rel="?next"?$/i))
    .find((value) => value !== null);
  if (!match) return null;
  const next = new URL(match[1]!);
  const configured = new URL(base);
  if (next.origin !== configured.origin || !next.pathname.startsWith('/api/v4/')) {
    throw new Error('gitlab api pagination escaped the configured origin');
  }
  return next.toString();
}

export async function getPaginatedArray(
  fetchImpl: FetchLike,
  firstUrl: string,
  token: string,
  base: string,
  maxPages = MAX_PAGES,
): Promise<unknown[]> {
  const values: unknown[] = [];
  const seen = new Set<string>();
  let url: string | null = firstUrl;
  for (let page = 0; url && page < maxPages; page += 1) {
    if (seen.has(url)) throw new Error('gitlab api repeated a pagination link');
    seen.add(url);
    const { response, values: body } = await requestArrayPage(fetchImpl, url, token);
    values.push(...body);
    if (values.length > maxPages * MAX_PER_PAGE)
      throw new Error('gitlab api response exceeds total item limit');
    url = nextPageUrl(response.headers.get('link'), base);
  }
  if (url) throw new Error('gitlab api response exceeds page limit');
  return values;
}

export async function getBootstrapArray(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  base: string,
): Promise<unknown[]> {
  const pageSize = requestedPageSize(url);
  const values: unknown[] = [];
  const seen = new Set<string>();
  let next: string | null = url;
  for (let page = 0; next && page < MAX_PAGES && values.length < pageSize; page += 1) {
    if (seen.has(next)) throw new Error('gitlab api repeated a pagination link');
    seen.add(next);
    const current = await requestArrayPage(fetchImpl, next, token);
    values.push(...current.values.slice(0, pageSize - values.length));
    if (values.length >= pageSize) break;
    next = nextPageUrl(current.response.headers.get('link'), base);
  }
  return values;
}

/**
 * Build a validated absolute URL under the tenant's `/api/v4` base. The path is resolved with WHATWG
 * URL normalization (so `..` is collapsed) and then two assertions close SSRF/traversal: the origin
 * must equal the SSRF-checked base origin, and the pathname must stay under `/api/v4/`. Query values
 * go through URLSearchParams (percent-encoded), never string concatenation; `per_page` is clamped.
 */
export function buildApiUrl(
  base: string,
  path: string,
  query?: Record<string, string | number>,
): string {
  const baseUrl = new URL(base.replace(/\/+$/, '') + '/');
  const u = new URL(path.replace(/^\/+/, ''), baseUrl);
  if (u.origin !== baseUrl.origin)
    throw new Error('gitlab connector: path escapes the configured host');
  if (!u.pathname.startsWith('/api/v4/')) throw new Error('gitlab connector: path escapes /api/v4');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (k === 'per_page') continue; // clamped below
      u.searchParams.set(k, String(v));
    }
    if (query.per_page !== undefined) u.searchParams.set('per_page', String(query.per_page));
  }
  // Clamp whatever per_page ended up set — from the query arg OR inline in the path — and default when absent/garbage.
  const per = Math.min(
    Math.max(1, Math.floor(Number(u.searchParams.get('per_page')) || DEFAULT_PER_PAGE)),
    MAX_PER_PAGE,
  );
  u.searchParams.set('per_page', String(per));
  return u.toString();
}

/** GET a GitLab URL. Returns parsed JSON when the response is JSON, else raw text (e.g. job traces). */
export async function apiFetch(
  fetchImpl: FetchLike,
  url: string,
  token: string,
): Promise<{ json?: unknown; text: string; truncated?: boolean }> {
  const res = await fetchImpl(url, {
    headers: { 'PRIVATE-TOKEN': token },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`gitlab api ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const text = await readBoundedText(res, MAX_JSON_RESPONSE_BYTES);
    try {
      return { json: JSON.parse(text), text };
    } catch {
      return { text };
    }
  }
  const tail = await readStreamingTail(res, MAX_TRACE_TAIL_BYTES);
  return { text: tail.text, truncated: tail.truncated };
}
