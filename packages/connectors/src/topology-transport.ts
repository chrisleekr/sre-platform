import { SourceRateLimitError } from './source-file-error';

export const TOPOLOGY_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_MS = 8000;
const COLLECTION_MS = 45000;

export class TopologyReadError extends Error {
  constructor(
    readonly issue: 'limit' | 'unreachable',
    readonly deadlineExceeded = false,
  ) {
    super(
      issue === 'limit'
        ? 'Topology collection limit reached'
        : 'Topology request deadline exceeded',
    );
  }
}

/** Retain the discovery limit category without exposing provider response content.
 * @param error - Failure from the bounded discovery transport.
 */
export function topologyReadIssue(error: unknown): 'limit' | 'unreachable' | undefined {
  return error instanceof TopologyReadError ? error.issue : undefined;
}

/** Bound discovery response bytes and elapsed time while retaining the provider's guarded transport.
 * @param fetchImpl - Already host-confined provider transport, including its TLS and authentication options.
 */
export function topologyFetch(fetchImpl: typeof fetch): typeof fetch {
  const deadline = Date.now() + COLLECTION_MS;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TopologyReadError('limit', true);
    const controller = new AbortController();
    const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const cancel = () => controller.abort(new TopologyReadError('unreachable'));
    if (parent?.aborted) cancel();
    else parent?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new TopologyReadError(
            remaining < REQUEST_MS ? 'limit' : 'unreachable',
            remaining < REQUEST_MS,
          ),
        ),
      Math.min(remaining, REQUEST_MS),
    );
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    let reader:
      Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'> | undefined;
    try {
      if (controller.signal.aborted) await aborted;
      const request = fetchImpl(input, { ...init, signal: controller.signal }).then((response) => {
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw controller.signal.reason;
        }
        return response;
      });
      const response = await Promise.race([request, aborted]);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      if (Number(response.headers.get('content-length')) > TOPOLOGY_RESPONSE_BYTES) {
        void response.body?.cancel().catch(() => {});
        throw new TopologyReadError('limit');
      }
      if (!response.body) return response;
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > TOPOLOGY_RESPONSE_BYTES) throw new TopologyReadError('limit');
        chunks.push(value);
      }
      const body = new Uint8Array(bytes);
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
    } catch (error) {
      controller.abort(error);
      void reader?.cancel().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort);
      reader?.releaseLock();
    }
  }) as typeof fetch;
}

/** Apply discovery budgets and stop source scans when the provider requests a rate-limit pause.
 * @param fetchImpl - Existing host-confined source transport.
 * @param additionalRateLimit - Provider-specific rate-limit response detection.
 */
export function sourceTopologyFetch(
  fetchImpl: typeof fetch,
  additionalRateLimit?: (response: Response) => boolean,
): typeof fetch {
  const bounded = topologyFetch(fetchImpl);
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await bounded(input, init);
    if (response.status === 429 || additionalRateLimit?.(response))
      throw new SourceRateLimitError();
    return response;
  }) as typeof fetch;
}
