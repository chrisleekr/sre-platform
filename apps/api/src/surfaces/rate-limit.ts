/** A token bucket: `tryTake` consumes one token if available, refilling over time. */
export interface TokenBucket {
  tryTake(): boolean;
}

/**
 * Pure token-bucket rate limiter. Caps how fast one caller can push work (e.g. resume triggers
 * from a WS connection) — CWE-770. The clock is injected (`now` in ms) so it is deterministic and
 * timer-free; tokens refill continuously at `refillPerSec`, capped at `capacity`.
 */
export function makeTokenBucket(opts: {
  capacity: number;
  refillPerSec: number;
  now: () => number;
}): TokenBucket {
  let tokens = opts.capacity;
  let last = opts.now();
  return {
    tryTake() {
      const t = opts.now();
      tokens = Math.min(opts.capacity, tokens + ((t - last) / 1000) * opts.refillPerSec);
      last = t;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      return false;
    },
  };
}
