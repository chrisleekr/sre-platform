// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { IncidentWorkspaceData } from '../../lib/types';
import { FindingFeedback } from '../FindingFeedback';
import { IncidentDecisionBrief } from '../IncidentDecisionBrief';
import { IncidentOperatorPanel } from '../IncidentOperatorPanel';
import { SignalOverview } from '../incident-conversation/signals';
import { ConversationLog } from '../incident-conversation/timeline';

const runId = '11111111-1111-4111-8111-111111111111';
const incidentId = '22222222-2222-4222-8222-222222222222';
const signalId = '33333333-3333-4333-8333-333333333333';

function workspace(): IncidentWorkspaceData {
  return {
    incident: {
      id: incidentId,
      service: 'checkout',
      severity: 'sev2',
      status: 'open',
      investigationStatus: 'assessed',
      lifecycleVersion: 1,
      alertSource: 'prometheus',
      rcaSummary: 'Pool saturation caused the errors.',
      confidence: 80,
      trustedAssessmentRunId: runId,
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    assessmentState: 'available',
    viewerUserId: '44444444-4444-4444-8444-444444444444',
    progress: { total: 2, successful: 2, failed: 0, lastRecordedAt: null },
    signals: [
      {
        id: signalId,
        provider: 'alertmanager',
        surface: 'slack',
        channel: 'alerts',
        externalMessageId: 'root',
        state: 'firing',
        lastEventType: 'opened',
        summary: 'Checkout error rate is high.',
        version: 1,
        firstSeenAt: '2026-09-01T00:00:00.000Z',
        lastSeenAt: '2026-09-01T00:01:00.000Z',
        resolvedAt: null,
      },
    ],
    feedback: [],
    feedbackEligibleFindingRunIds: [runId],
    attention: {
      decision: 'Review the high-severity incident and decide the next response action.',
      owner: 'payments-sre',
      nextAutomation: null,
    },
    automation: {
      nextAction: null,
      episodeExpiresAt: '2026-09-02T00:00:00.000Z',
      currentBudget: {
        windowHours: 24,
        tenant: {
          runs: 4,
          configuredCostUsd: 1.5,
          pendingCostRuns: 0,
          missingUsageRuns: 0,
          unpricedRuns: 0,
          runLimit: 10,
          configuredCostLimitUsd: 5,
        },
        monitors: [],
        exhaustedBy: [],
      },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

test('shows the exact responder handoff, owner, budget, and episode boundary', () => {
  render(<IncidentOperatorPanel workspace={workspace()} />);
  expect(screen.getByText('Human decision required')).toBeDefined();
  expect(screen.getByText(/Review the high-severity incident/)).toBeDefined();
  expect(screen.getByText('payments-sre')).toBeDefined();
  expect(screen.getByText('No automation remains.')).toBeDefined();
  expect(screen.getByText(/New matching alerts stop joining this episode/)).toBeDefined();
  expect(screen.getByText(/Tenant · 4 \/ 10 runs/)).toBeDefined();
});

test('saves an attributed finding confirmation and refreshes the workspace', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ feedback: {} }), { status: 201 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  render(
    <FindingFeedback
      workspace={workspace()}
      getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
      onChanged={onChanged}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Confirm conclusion' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review conclusion' }));
  expect(screen.getByText(/does not resolve the incident or approve a change/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm conclusion' }));
  fireEvent.change(screen.getByPlaceholderText(/What evidence confirms/), {
    target: { value: 'Trace and metrics agree.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
    targetType: 'finding',
    targetId: runId,
    decision: 'confirm',
    rationale: 'Trace and metrics agree.',
  });
});

test('hides trusted-finding controls when an upgraded incident has no structured finding', () => {
  const legacy = workspace();
  legacy.feedbackEligibleFindingRunIds = [];
  render(
    <IncidentDecisionBrief
      workspace={legacy}
      onSelectEvidence={vi.fn()}
      getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Review conclusion' })).toBeNull();
});

test('records whether a provider signal is noise', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ feedback: {} }), { status: 201 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  render(
    <SignalOverview
      workspace={workspace()}
      getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
      onChanged={onChanged}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Mark as noise' }));
  fireEvent.change(screen.getByLabelText('Evidence for this decision'), {
    target: { value: 'Synthetic traffic only.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
    targetType: 'noise',
    targetId: signalId,
    decision: 'noise',
  });
});

test('announces a signal-feedback save failure and keeps the decision form open', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'rejected' }), { status: 500 })),
  );
  render(
    <SignalOverview
      workspace={workspace()}
      getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
      onChanged={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Mark actionable' }));
  fireEvent.change(screen.getByLabelText('Evidence for this decision'), {
    target: { value: 'Customer traffic is affected.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Signal feedback could not be saved.',
  );
  expect(screen.getByDisplayValue('Customer traffic is affected.')).toBeDefined();
});

test('labels pending and recovery state without claiming either is a trusted assessment', () => {
  const pending = workspace();
  pending.assessmentState = 'pending';
  pending.incident.investigationStatus = 'gathering';
  pending.incident.trustedAssessmentRunId = null;
  pending.incident.rcaSummary = null;
  const props = {
    onSelectEvidence: vi.fn(),
    getCredentials: async () => ({ kind: 'bearer' as const, token: 'token' }),
    onChanged: vi.fn(),
  };
  const { rerender } = render(<IncidentDecisionBrief workspace={pending} {...props} />);
  expect(screen.getByText('No trusted assessment yet')).toBeDefined();
  expect(screen.getByText('Investigation in progress')).toBeDefined();

  const recovery = workspace();
  recovery.incident.recoveryState = 'monitoring';
  recovery.incident.recoveryUpdatedAt = '2026-09-01T01:00:00.000Z';
  recovery.incident.assessmentUpdatedAt = '2026-09-01T00:00:00.000Z';
  rerender(<IncidentDecisionBrief workspace={recovery} {...props} />);
  expect(screen.getByText('Recovery status')).toBeDefined();
  expect(screen.getByText('Monitoring recovery')).toBeDefined();
});

test('labels finding promotion in the durable conversation', () => {
  render(
    <ConversationLog
      messages={[
        {
          id: 'message-1',
          incidentId,
          author: 'agent',
          kind: 'reply',
          content: 'The current logs are healthy.',
          finding: {
            runId,
            outcome: 'conclusive',
            promotion: 'conversation_only',
            promotionReason: 'responder_reply',
            evidenceIds: [],
            currentState: null,
            impact: null,
            nextStep: null,
          },
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ]}
    />,
  );
  expect(screen.getByText('Conversation update')).toBeDefined();
});

test.each(['failed', 'inconclusive', 'blocked_missing_capability', 'budget_exhausted'] as const)(
  'does not offer review for %s messages even with stale workspace eligibility',
  (outcome) => {
    render(
      <ConversationLog
        workspace={workspace()}
        getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
        onFeedbackChanged={vi.fn()}
        messages={[
          {
            id: 'status-message',
            incidentId,
            author: 'agent',
            kind: 'finding',
            content: 'Investigation finalization failed.',
            finding: {
              runId,
              outcome,
              promotion: 'not_promoted',
              promotionReason: 'investigation_failed',
              evidenceIds: [],
              currentState: null,
              impact: null,
              nextStep: null,
            },
            createdAt: '2026-09-01T00:00:00.000Z',
          },
        ]}
      />,
    );
    expect(screen.getByText('Investigation finalization failed.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Review conclusion' })).toBeNull();
  },
);

test('corrects a conversation-only run-backed finding from the timeline', async () => {
  const conversationRunId = '55555555-5555-4555-8555-555555555555';
  const conversationWorkspace = workspace();
  conversationWorkspace.feedbackEligibleFindingRunIds = [runId, conversationRunId];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify({ feedback: {} }), { status: 201 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(
    <ConversationLog
      workspace={conversationWorkspace}
      getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
      onFeedbackChanged={vi.fn()}
      messages={[
        {
          id: 'message-conversation',
          incidentId,
          author: 'agent',
          kind: 'reply',
          content: 'The current logs point to a timeout.',
          finding: {
            runId: conversationRunId,
            outcome: 'conclusive',
            promotion: 'conversation_only',
            promotionReason: 'responder_reply',
            evidenceIds: [],
            currentState: null,
            impact: null,
            nextStep: null,
          },
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review conclusion' }));
  fireEvent.click(screen.getByRole('button', { name: 'Correct conclusion' }));
  fireEvent.change(screen.getByPlaceholderText(/What evidence confirms/), {
    target: { value: 'The trace identifies a retry storm.' },
  });
  fireEvent.change(screen.getByPlaceholderText('State the corrected conclusion.'), {
    target: { value: 'A retry storm exhausted the downstream pool.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
    targetType: 'finding',
    targetId: conversationRunId,
    decision: 'correct',
  });
});
