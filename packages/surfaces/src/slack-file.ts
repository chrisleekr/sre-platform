// Slack file fetcher: download the bytes of a human-attached file for one-shot
// vision interpretation (worker) or a proxied dashboard render (API). The bytes are TRANSIENT —
// returned to the caller, never persisted. Counterpart of makeSlackThreadReader:
// same injected fetch + getToken, same null-token skip convention. Two hardening controls, because
// the url comes from an untrusted Slack event payload:
//   - Host-pin + no-redirect: only a Slack files host (files.slack.com / *.slack.com) over https, AND
//     `redirect: 'error'` so a redirect off the pinned host fails closed — the host-pin only validates
//     the INITIAL url, so a followed redirect could still land on a private/metadata endpoint (SSRF).
//   - Size cap: stream the body and abort the moment cumulative bytes exceed SLACK_FILE_MAX_BYTES, so
//     an absent/understated Content-Length cannot fully allocate a huge upload before rejection.

/** Slice of the DOM fetch Response this fetcher needs — a streamable body + headers, stubbable in tests. */
export type FileFetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    redirect?: 'error' | 'follow' | 'manual';
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}>;

/** Max file size we will download for interpretation / proxy (5 MB). Oversize is rejected. */
export const SLACK_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** Per-fetch timeout so a slow Slack CDN cannot wedge the caller. */
const FETCH_TIMEOUT_MS = 15_000;

export interface SlackFileFetcherDeps {
  /** Injected fetch (a fake in tests), mirroring makeSlackThreadReader. Defaults to the global fetch. */
  fetch?: FileFetchLike;
  /** The tenant's Slack bot token, or null when unset (mirrors the thread reader's getToken). */
  getToken: (tenantId: string) => Promise<string | null>;
}

export interface SlackFileFetcher {
  /** Fetch a Slack file's transient bytes + content type. Rejects a non-Slack host or an oversize file. */
  fetch(tenantId: string, urlPrivate: string): Promise<{ bytes: ArrayBuffer; contentType: string }>;
}

/**
 * Read a response body, aborting as soon as cumulative bytes exceed `cap`. Bounds allocation to ~cap
 * (plus one in-flight chunk), so a lying/absent Content-Length cannot fully buffer an oversize body
 * before the cap is enforced (the check that used to run only AFTER arrayBuffer() allocated it all).
 */
async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<ArrayBuffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) throw new Error('slack file too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/** Host-pin: only https to a Slack files host. Anything else (private ip, metadata endpoint) is rejected. */
function assertSlackFileHost(urlPrivate: string): URL {
  let url: URL;
  try {
    url = new URL(urlPrivate);
  } catch {
    throw new Error('slack file url is not a valid url');
  }
  if (url.protocol !== 'https:') throw new Error('slack file url must be https');
  const host = url.hostname.toLowerCase();
  if (host !== 'slack.com' && !host.endsWith('.slack.com')) {
    throw new Error('slack file url host is not a Slack files host');
  }
  return url;
}

/**
 * Builds a bounded Slack file downloader with host and redirect checks.
 *
 * @param deps - HTTP and bot-token dependencies for Slack file reads.
 */
export function makeSlackFileFetcher(deps: SlackFileFetcherDeps): SlackFileFetcher {
  const fetchImpl: FileFetchLike = deps.fetch ?? (globalThis.fetch as unknown as FileFetchLike);
  return {
    async fetch(tenantId, urlPrivate): Promise<{ bytes: ArrayBuffer; contentType: string }> {
      // SSRF guard FIRST: reject before resolving the token or touching the network.
      assertSlackFileHost(urlPrivate);
      const token = await deps.getToken(tenantId);
      // No token: cannot authorize the download (a Slack file url_private 302s to a login page without
      // it). Fail rather than fetch — the caller treats it as a best-effort miss.
      if (!token) throw new Error('slack file fetch: no bot token for tenant');

      let res: Awaited<ReturnType<FileFetchLike>>;
      try {
        res = await fetchImpl(urlPrivate, {
          method: 'GET',
          // Bearer header (never the url), so a fetch-rejection url cannot leak the token.
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          // Fail closed on any redirect: the host-pin only validated the initial url, so following a
          // redirect off the pinned Slack host would defeat the SSRF guard (CWE-918).
          redirect: 'error',
        });
      } catch {
        throw new Error('slack file request failed');
      }
      if (!res.ok) throw new Error(`slack file fetch failed: ${res.status}`);

      // Fast-reject oversize by the advertised length before reading a single byte of the body.
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > SLACK_FILE_MAX_BYTES) {
        throw new Error('slack file too large');
      }
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
      if (!res.body) throw new Error('slack file response had no body');
      // Stream-read with a running cap so a lying/absent Content-Length cannot allocate a huge file.
      const bytes = await readCapped(res.body, SLACK_FILE_MAX_BYTES);
      return { bytes, contentType };
    },
  };
}
