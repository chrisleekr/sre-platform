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

const failedRun = (summary: string) => ({
  id: 'run',
  operation: 'investigate' as const,
  outcome: 'failed' as const,
  nextStep: null,
  reason: null,
  summary,
  triggerReason: null,
  triggerAutomatic: false,
  triggerMonitorKey: null,
  triggerMonitorKeys: [],
  triggerBudget: null,
  completedAt: '2026-09-20T00:00:00Z',
});

test('recognized provider rate limit gives an actionable safe blocker', () => {
  const state = incidentOperatorState(
    {
      ...idle,
      requiresHumanAttention: true,
      attentionReason: 'investigation_failed',
      latestInvestigationRun: failedRun('AI provider rate limit reached.'),
    } as State,
    [],
  );
  expect(state.attention?.decision).toMatch(/provider.*rate limit/i);
  expect(state.attention?.decision).toMatch(/account limit/i);
  expect(state.attention?.decision).toMatch(/retry/i);
});

test.each(['secret token=abc', 'AI provider rate limit reached. token=abc'])(
  'arbitrary failure summaries remain private: %s',
  (summary) => {
    const state = incidentOperatorState(
      {
        ...idle,
        requiresHumanAttention: true,
        attentionReason: 'investigation_failed',
        latestInvestigationRun: failedRun(summary),
      } as State,
      [],
    );
    expect(state.attention?.decision).toBe(
      'Investigate manually or retry after the investigation blocker is cleared.',
    );
    expect(JSON.stringify(state)).not.toContain('token=abc');
  },
);

test('the current structured operator question is the handoff decision', () => {
  const state = incidentOperatorState(
    {
      ...idle,
      requiresHumanAttention: true,
      attentionReason: 'operator_decision',
      operatorDecision: 'Must capacity survive losing one node?',
      pendingAutomation: {
        type: 'triage',
        status: 'processing',
        scheduledAt: '2026-09-20T00:00:00Z',
      },
    } as unknown as State,
    [],
  );
  expect(state.attention?.decision).toBe('Must capacity survive losing one node?');
  expect(state.automation).not.toBeNull();
  expect(state.attention?.owner).toBeNull();
});

test('approval handoff retains priority over a structured operator decision', () => {
  const state = incidentOperatorState(
    {
      ...idle,
      requiresHumanAttention: true,
      attentionReason: 'approval_pending',
      operatorDecision: 'Must capacity survive losing one node?',
    } as State,
    [],
  );
  expect(state.attention?.decision).toBe('Approve or deny the pending proposed action.');
});

const needsHuman = {
  ...idle,
  requiresHumanAttention: true,
  attentionReason: 'investigation_failed',
  latestInvestigationRun: failedRun('Investigation failed.'),
} as State;
const REPORTED = 'Provider reported recovery in Slack. Confirm resolution.';

test('asks to confirm resolution when every active signal has a Slack recovery report', () => {
  const state = incidentOperatorState(needsHuman, [], {
    signals: [
      { id: 'a', state: 'unknown' },
      { id: 'b', state: 'unknown' },
      { id: 'cleared', state: 'resolved' },
    ],
    reportedSignalIds: ['a', 'b'],
  });
  expect(state.attention?.decision).toBe(REPORTED);
});

test.each([
  { name: 'one active signal is unreported', signals: ['a', 'b'], reported: ['a'] },
  { name: 'no signal is active', signals: [], reported: ['a'] },
])('keeps the investigation decision when $name', ({ signals, reported }) => {
  const state = incidentOperatorState(needsHuman, [], {
    signals: signals.map((id) => ({ id, state: 'unknown' })),
    reportedSignalIds: reported,
  });
  expect(state.attention?.decision).toBe(
    'Investigate manually or retry after the investigation blocker is cleared.',
  );
});

test('a pending approval keeps priority over a reported recovery', () => {
  const state = incidentOperatorState(
    { ...needsHuman, attentionReason: 'approval_pending' } as State,
    [],
    { signals: [{ id: 'a', state: 'unknown' }], reportedSignalIds: ['a'] },
  );
  expect(state.attention?.decision).toBe('Approve or deny the pending proposed action.');
});
