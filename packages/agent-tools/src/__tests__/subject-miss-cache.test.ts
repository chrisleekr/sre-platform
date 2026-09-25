import { expect, test } from 'vitest';
import { SubjectMissCache } from '../subject-miss-cache';

function cache(maxEntries = 3) {
  let now = 1_000;
  const misses = new SubjectMissCache<string>({ ttlMs: 600_000, maxEntries, now: () => now });
  return { misses, advance: (ms: number) => (now += ms) };
}

test('a miss is remembered until its TTL has fully elapsed', () => {
  const { misses, advance } = cache();
  misses.set('connector:0:statuscake:uptime:https://chrislee.kr/', 'no_matching_monitor');
  advance(599_999);
  expect(misses.get('connector:0:statuscake:uptime:https://chrislee.kr/')).toBe(
    'no_matching_monitor',
  );
  advance(1);
  expect(misses.get('connector:0:statuscake:uptime:https://chrislee.kr/')).toBeUndefined();
  // An expired entry is dropped on read, so it no longer counts toward the bound.
  expect(misses.size).toBe(0);
});

test('inserting past the bound evicts the oldest entry first', () => {
  const { misses, advance } = cache(3);
  for (const key of ['a', 'b', 'c']) {
    misses.set(key, key);
    advance(1);
  }
  // Re-setting refreshes both the TTL and the eviction position.
  misses.set('a', 'a');
  misses.set('d', 'd');
  expect(misses.size).toBe(3);
  expect(misses.get('b')).toBeUndefined();
  expect(['a', 'c', 'd'].map((key) => misses.get(key))).toEqual(['a', 'c', 'd']);
});

test('keys are exact, so another connector generation starts with no remembered miss', () => {
  const { misses } = cache();
  misses.set('connector:0:statuscake:uptime:https://chrislee.kr/', 'ambiguous_monitor');
  expect(misses.get('connector:1:statuscake:uptime:https://chrislee.kr/')).toBeUndefined();
});
