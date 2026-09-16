import { expect, test } from 'vitest';
import { incidentOperatorState } from '../operator-state';

type State = Parameters<typeof incidentOperatorState>[0];

const idle = {
  attentionReason: null,
  latestInvestigationRun: null,
  nextStep: null,
  pendingAutomation: null,
  recoveryNextCheckAt: null,
  recoveryNextStep: null,
  recoveryState: null,
  requiresHumanAttention: false,
} as unknown as State;

test('a processing job is described as recorded work, without its runnable time as a schedule', () => {
  const state = incidentOperatorState(
    {
      ...idle,
      pendingAutomation: {
        type: 'triage',
        status: 'processing',
        scheduledAt: '2026-09-16T01:00:00.000Z',
      },
    },
    [],
  );
  expect(state.automation).toEqual({
    description: 'Complete the investigation recorded as processing',
    scheduledAt: null,
  });
});

test('a queued job keeps its scheduled time', () => {
  const state = incidentOperatorState(
    {
      ...idle,
      pendingAutomation: {
        type: 'triage',
        status: 'queued',
        scheduledAt: '2026-09-16T01:00:00.000Z',
      },
    },
    [],
  );
  expect(state.automation).toEqual({
    description: 'Start the queued investigation',
    scheduledAt: '2026-09-16T01:00:00.000Z',
  });
});

test.each([
  { investigationStatus: 'queued' },
  { investigationStatus: 'gathering' },
  { recoveryState: 'verifying' },
])('a status left behind without a job row does not imply automation: %o', (leftover) => {
  const state = incidentOperatorState({ ...idle, ...leftover } as State, []);
  expect(state.automation).toBeNull();
});
