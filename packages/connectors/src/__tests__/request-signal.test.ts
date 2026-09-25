import { describe, expect, it } from 'vitest';
import { boundedSignal } from '../request-signal';

describe('boundedSignal', () => {
  it('aborts with the caller reason when the caller aborts first', () => {
    const caller = new AbortController();
    const signal = boundedSignal(60_000, caller.signal);
    const reason = new Error('cancelled');

    caller.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it('still times out on its own without a caller', async () => {
    const signal = boundedSignal(1);

    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

    expect((signal.reason as Error).name).toBe('TimeoutError');
  });
});
