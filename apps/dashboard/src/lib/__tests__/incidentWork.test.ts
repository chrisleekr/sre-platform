import { expect, test } from 'vitest';
import { investigationWorkLabel } from '../incidentState';
import type { Incident } from '../types';

test.each(['queued', 'gathering', 'assessed', 'degraded'] as const)(
  'legacy %s is not evidence of active work',
  (investigationStatus) => {
    expect(investigationWorkLabel({ investigationStatus } as Incident)).toBe(
      'No active automation recorded',
    );
  },
);
test.each(['triage', 'resume', 'signal.reassess', 'recovery.verify'])(
  'processing %s remains a recorded snapshot not a liveness claim',
  (type) => {
    expect(
      investigationWorkLabel({ pendingAutomation: { type, status: 'processing' } } as Incident),
    ).toContain('recorded as processing');
  },
);
test('an overdue bounded schedule does not claim execution', () => {
  expect(
    investigationWorkLabel({
      recoveryState: 'monitoring',
      recoveryNextCheckAt: '2020-01-01T00:00:00Z',
    } as Incident),
  ).toBe('Scheduled recovery check overdue; execution not confirmed');
  expect(
    investigationWorkLabel({
      recoveryState: 'monitoring',
      recoveryNextCheckAt: 'invalid',
    } as Incident),
  ).toBe('No active automation recorded');
});
