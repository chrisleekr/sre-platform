import { describe, expect, test } from 'vitest';
// The `relativeTime` duplicated in NodeDetail.tsx and DeploymentsList.tsx is extracted to
// this shared module, imported by both. The assertions pin the exact bucket semantics both callers rely on.
import { formatAbsoluteTime, futureRelativeTime, relativeTime } from '../time';

describe('relativeTime', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  test('sub-minute → "just now"', () => {
    expect(relativeTime(ago(30_000), now)).toBe('just now');
  });

  test('minutes → "Nm ago"', () => {
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5m ago');
  });

  test('hours → "Nh ago"', () => {
    expect(relativeTime(ago(2 * 60 * 60_000), now)).toBe('2h ago');
  });

  test('days → "Nd ago"', () => {
    expect(relativeTime(ago(3 * 24 * 60 * 60_000), now)).toBe('3d ago');
  });

  test('future scheduled work is never presented as current', () => {
    expect(futureRelativeTime(new Date(now + 5 * 60_000).toISOString(), now)).toBe('in 5m');
    expect(futureRelativeTime(new Date(now + 60 * 60_000).toISOString(), now)).toBe('in 1h');
    expect(futureRelativeTime(new Date(now - 1).toISOString(), now)).toBe('due now');
  });
});

describe('formatAbsoluteTime', () => {
  test('formats an operator-readable absolute timestamp instead of exposing the raw ISO value', () => {
    const iso = '2026-08-18T01:05:00.000Z';
    const formatted = formatAbsoluteTime(iso);

    expect(formatted).not.toBe(iso);
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(formatted).not.toMatch(/Invalid Date/i);
  });
});
