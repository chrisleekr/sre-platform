import { request as httpsRequest } from 'node:https';
import { isBlockedIp, dnsLookup, type HostLookup } from './ssrf';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export interface PinnedHttpsRequest {
  url: URL;
  address: string;
  servername: string;
  rejectUnauthorized: true;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  signal: AbortSignal;
  maxResponseBytes: number;
}

/** Transport seam that must connect to `address` while validating TLS for `servername`. */
export type PinnedHttpsTransport = (request: PinnedHttpsRequest) => Promise<Response>;

export interface PinnedHttpsOptions {
  lookup?: HostLookup;
  transport?: PinnedHttpsTransport;
  timeoutMs?: number;
  maxResponseBytes?: number;
  method?: string;
  headers?: Headers | Record<string, string> | Array<[string, string]>;
  body?: string | URLSearchParams | Uint8Array | ArrayBuffer | null;
}

function bodyBytes(
  body: string | URLSearchParams | Uint8Array | ArrayBuffer | null | undefined,
): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error('guarded HTTPS request body type is unsupported');
}

const defaultTransport: PinnedHttpsTransport = (input) =>
  new Promise((resolve, reject) => {
    const host = input.url.port ? `${input.url.hostname}:${input.url.port}` : input.url.hostname;
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: input.address,
        port: input.url.port || 443,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: { ...Object.fromEntries(input.headers), host },
        servername: input.servername,
        rejectUnauthorized: input.rejectUnauthorized,
        signal: input.signal,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.maxResponseBytes) {
            incoming.destroy(new Error('guarded HTTPS response exceeds byte limit'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
            else if (value !== undefined) headers.set(name, value);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
              statusText: incoming.statusMessage,
              headers,
            }),
          );
        });
        incoming.on('error', reject);
      },
    );
    request.on('error', reject);
    if (input.body) request.write(input.body);
    request.end();
  });

async function boundedResponse(response: Response, maxBytes: number): Promise<Response> {
  if (response.status >= 300 && response.status < 400) {
    throw new Error('guarded HTTPS request refused a redirect');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('guarded HTTPS response exceeds byte limit');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('guarded HTTPS response exceeds byte limit');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Performs one public-only HTTPS request pinned to a validated DNS answer.
 *
 * @param raw - HTTPS URL selected by a remote identity provider.
 * @param options - Bounded transport, resolver, and request overrides.
 */
export async function fetchPinnedHttps(
  raw: string | URL,
  options: PinnedHttpsOptions = {},
): Promise<Response> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('guarded HTTPS URL must be https without credentials or fragment');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('guarded HTTPS URL host not allowed');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('guarded HTTPS request timeout')),
    timeoutMs,
  );
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
    });
    const addresses = await Promise.race([(options.lookup ?? dnsLookup)(hostname), aborted]);
    if (addresses.length === 0) throw new Error('guarded HTTPS URL host does not resolve');
    if (addresses.some((address) => isBlockedIp(address))) {
      throw new Error('guarded HTTPS URL host not allowed');
    }
    const response = await (options.transport ?? defaultTransport)({
      url,
      address: addresses[0]!,
      servername: hostname,
      rejectUnauthorized: true,
      method: options.method ?? 'GET',
      headers: new Headers(options.headers),
      body: bodyBytes(options.body),
      signal: controller.signal,
      maxResponseBytes,
    });
    return await boundedResponse(response, maxResponseBytes);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('guarded HTTPS request timeout', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
