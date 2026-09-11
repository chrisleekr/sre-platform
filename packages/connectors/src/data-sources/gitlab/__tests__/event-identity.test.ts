import { expect, test } from 'vitest';
import { gitLabRevisionKey } from '../event-identity';

test('normalizes equivalent provider instants without losing sub-millisecond precision', () => {
  const key = (at: string) => gitLabRevisionKey('pipeline', '7', '42', 'success', at);
  expect(key('2026-09-08T00:00:00.123456Z')).toBe(key('2026-09-08T10:00:00.123456000+10:00'));
  expect(key('2026-09-08T00:00:00.123456Z')).not.toBe(key('2026-09-08T00:00:00.123457Z'));
  expect(key('2026-09-08T00:00:00Z')).toBe(key('2026-09-08T00:00:00.000Z'));
});

test('does not invent revision identity from a status alone or an imprecise date', () => {
  expect(gitLabRevisionKey('pipeline', '7', '42', 'running', undefined)).toBeUndefined();
  expect(
    gitLabRevisionKey('pipeline', '7', undefined, 'running', '2026-09-08T00:00:00Z'),
  ).toBeUndefined();
  expect(gitLabRevisionKey('pipeline', '7', '42', 'running', '2026')).toBeUndefined();
  expect(
    gitLabRevisionKey('pipeline', '7', '42', undefined, '2026-09-08T00:00:00Z'),
  ).toBeUndefined();
});

test('distinguishes provider objects, state transitions, event families and subsequent retries', () => {
  const key = gitLabRevisionKey('pipeline', '7', '42', 'running', '2026-09-08T00:00:00Z');
  expect(gitLabRevisionKey('pipeline', '8', '42', 'running', '2026-09-08T00:00:00Z')).not.toBe(key);
  expect(gitLabRevisionKey('pipeline', '7', '43', 'running', '2026-09-08T00:00:00Z')).not.toBe(key);
  expect(gitLabRevisionKey('pipeline', '7', '42', 'success', '2026-09-08T00:00:00Z')).not.toBe(key);
  expect(gitLabRevisionKey('job', '7', '42', 'running', '2026-09-08T00:00:00Z')).not.toBe(key);
  expect(gitLabRevisionKey('pipeline', '7', '42', 'running', '2026-09-08T00:00:01Z')).not.toBe(key);
});
