/**
 * A provider request signal that fires on its own timeout or when the caller's signal aborts,
 * whichever comes first. Without a caller signal it is the plain timeout, so probe and background
 * paths keep their existing behaviour.
 *
 * @param timeoutMs - Per-request ceiling in milliseconds.
 * @param parent - Caller cancellation, usually the investigation's signal.
 */
export function boundedSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([timeout, parent]) : timeout;
}
