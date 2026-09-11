import { describe, expect, test } from 'vitest';
import { makeTokenBucket } from '../rate-limit';

// harden resume trigger: a pure token bucket caps how fast one surface can push resume triggers.
// The clock is injected (now: () => ms) so refill is deterministic without real timers.
describe('makeTokenBucket', () => {
  test('allows a burst up to capacity then rejects', () => {
    let t = 0;
    const bucket = makeTokenBucket({ capacity: 3, refillPerSec: 1, now: () => t });
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false); // capacity exhausted, no time elapsed
  });

  test('refills over time', () => {
    let t = 0;
    const bucket = makeTokenBucket({ capacity: 3, refillPerSec: 1, now: () => t });
    for (let i = 0; i < 3; i++) bucket.tryTake();
    expect(bucket.tryTake()).toBe(false);

    t = 2000; // 2s at 1 token/sec → 2 tokens back
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  test('never exceeds capacity on refill', () => {
    let t = 0;
    const bucket = makeTokenBucket({ capacity: 3, refillPerSec: 1, now: () => t });
    for (let i = 0; i < 3; i++) bucket.tryTake();

    t = 1_000_000; // idle far longer than capacity/refill; must still cap at capacity
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false); // never more than 3 tokens accrued
  });
});
