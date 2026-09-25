import { expect, vi } from 'vitest';

/**
 * A fetch that never answers a provider request on its own. Like a real fetch it rejects with the
 * signal's reason once that signal aborts, so a request that ignores the caller's cancellation
 * hangs until the test times out. `answer` serves auxiliary requests such as a token mint.
 */
export function abortableFetch(answer?: (url: string) => Response | undefined) {
  const signals: AbortSignal[] = [];
  const impl = ((url: unknown, init?: RequestInit) => {
    const answered = answer?.(String(url));
    if (answered) return Promise.resolve(answered);
    const signal = init?.signal;
    if (!signal) return Promise.reject(new Error('provider request carried no signal'));
    signals.push(signal);
    return new Promise<Response>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  }) as typeof fetch;
  return { impl, signals };
}

/**
 * Starts a tool call under a caller signal, cancels the caller once the first provider request is in
 * flight, and asserts that the request was aborted with the caller's reason and that the call settled.
 */
export async function expectCancelledInFlight(
  run: (signal: AbortSignal) => Promise<unknown>,
  signals: AbortSignal[],
): Promise<void> {
  const caller = new AbortController();
  const reason = new Error('investigation cancelled');
  const call = run(caller.signal);
  await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
  const [request] = signals;
  expect(request!.aborted).toBe(false);
  caller.abort(reason);
  await expect(call).rejects.toThrow();
  expect(request!.aborted).toBe(true);
  expect(request!.reason).toBe(reason);
}
