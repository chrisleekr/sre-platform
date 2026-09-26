// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { IncidentWorkspaceData } from '../../lib/types';
import { IncidentOperatorPanel } from '../IncidentOperatorPanel';

const incidentId = '22222222-2222-4222-8222-222222222222';
const signalId = '33333333-3333-4333-8333-333333333333';
const groupedSignalId = '55555555-5555-4555-8555-555555555555';
const randomSignalId = '66666666-6666-4666-8666-666666666666';
const getCredentials = async () => ({ kind: 'bearer' as const, token: 'token' });

function signal(
  id: string,
  state: IncidentWorkspaceData['signals'][number]['state'] = 'unknown',
): IncidentWorkspaceData['signals'][number] {
  return {
    id,
    surface: 'slack',
    channel: 'C-ALERTS',
    externalMessageId: `root#${id}`,
    state,
    lastEventType: 'opened',
    summary: 'Checkout error rate is high.',
    version: 1,
    firstSeenAt: '2026-09-20T00:00:00.000Z',
    lastSeenAt: '2026-09-20T00:00:00.000Z',
    resolvedAt: null,
  };
}

/** A workspace whose one active signal carries a Slack recovery report. */
function reported(over: Partial<IncidentWorkspaceData['incident']> = {}): IncidentWorkspaceData {
  const data = workspace(over);
  data.signals = [signal(signalId)];
  data.providerRecoveryReports = [{ signalId, reportedAt: '2026-09-20T00:05:00.000Z' }];
  return data;
}

function workspace(over: Partial<IncidentWorkspaceData['incident']> = {}): IncidentWorkspaceData {
  return {
    incident: {
      id: incidentId,
      service: 'checkout',
      severity: 'sev3',
      status: 'open',
      investigationStatus: 'assessed',
      lifecycleVersion: 4,
      alertSource: 'slack',
      createdAt: '2026-09-20T00:00:00.000Z',
      attentionReason: null,
      ...over,
    } as IncidentWorkspaceData['incident'],
    viewerUserId: '44444444-4444-4444-8444-444444444444',
    progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
    signals: [],
    attention: {
      decision: 'Review the incident and decide the next response action.',
      owner: null,
      nextAutomation: null,
    },
    automation: { nextAction: null, currentBudget: null, episodeExpiresAt: null },
  };
}

function stubFetch(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('shows neither action without a recovery report or a retryable investigation', () => {
  render(
    <IncidentOperatorPanel
      workspace={workspace({ attentionReason: 'investigation_inconclusive' })}
      getCredentials={getCredentials}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Confirm resolved' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry investigation' })).toBeNull();
});

test('a read-only panel shows no actions', () => {
  const data = workspace({ attentionReason: 'investigation_failed' });
  data.providerRecoveryReports = [{ signalId, reportedAt: '2026-09-20T00:05:00.000Z' }];
  render(<IncidentOperatorPanel workspace={data} />);
  expect(screen.queryByRole('button')).toBeNull();
});

test('confirms a Slack-reported recovery through the lifecycle route with an operator basis', async () => {
  const fetchMock = stubFetch();
  const onChanged = vi.fn();
  const data = reported();
  data.providerRecoveryReports = [
    { signalId, reportedAt: '2026-09-20T00:05:00.000Z' },
    { signalId, reportedAt: '2026-09-20T00:07:00.000Z' },
  ];
  render(
    <IncidentOperatorPanel
      workspace={data}
      getCredentials={getCredentials}
      onChanged={onChanged}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Confirm resolved' }));

  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
    new RegExp(`/incidents/${incidentId}/lifecycle$`),
  );
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    to: 'resolved',
    reason:
      'Provider reported recovery in Slack at 2026-09-20T00:07:00.000Z; confirmed by an operator.',
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    expectedVersion: 4,
  });
});

test.each([
  { status: 'open', shown: true },
  { status: 'mitigated', shown: true },
  { status: 'resolved', shown: false },
  { status: 'closed', shown: false },
])('confirmation on a $status incident shown: $shown', ({ status, shown }) => {
  render(
    <IncidentOperatorPanel
      workspace={reported({ status })}
      getCredentials={getCredentials}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Confirm resolved' }) !== null).toBe(shown);
});

test('hides confirmation while an active signal has no recovery report', () => {
  const data = reported();
  data.signals = [signal(signalId), signal(groupedSignalId)];
  render(
    <IncidentOperatorPanel workspace={data} getCredentials={getCredentials} onChanged={vi.fn()} />,
  );
  expect(screen.queryByRole('button', { name: 'Confirm resolved' })).toBeNull();
});

test('offers confirmation when every active signal is covered, resolved ones aside', () => {
  const data = reported();
  data.signals = [signal(signalId), signal(groupedSignalId), signal(randomSignalId, 'resolved')];
  data.providerRecoveryReports = [
    { signalId, reportedAt: '2026-09-20T00:05:00.000Z' },
    { signalId: groupedSignalId, reportedAt: '2026-09-20T00:05:00.000Z' },
  ];
  render(
    <IncidentOperatorPanel workspace={data} getCredentials={getCredentials} onChanged={vi.fn()} />,
  );
  expect(screen.getByRole('button', { name: 'Confirm resolved' })).toBeDefined();
});

test.each([
  { name: 'a resolved incident', over: { status: 'resolved' } },
  { name: 'a closed incident', over: { status: 'closed' } },
  {
    name: 'queued work',
    over: {
      pendingAutomation: {
        type: 'resume',
        status: 'queued' as const,
        scheduledAt: '2026-09-20T00:06:00.000Z',
      },
    },
  },
])('offers no retry for $name', ({ over }) => {
  render(
    <IncidentOperatorPanel
      workspace={workspace({ attentionReason: 'investigation_failed', ...over })}
      getCredentials={getCredentials}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Retry investigation' })).toBeNull();
});

test.each(['investigation_degraded', 'investigation_failed'] as const)(
  'retries an investigation marked %s through the retry route',
  async (attentionReason) => {
    const fetchMock = stubFetch(202);
    const onChanged = vi.fn();
    render(
      <IncidentOperatorPanel
        workspace={workspace({ attentionReason })}
        getCredentials={getCredentials}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry investigation' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      new RegExp(`/incidents/${incidentId}/investigation/retry$`),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedVersion: 4,
    });
  },
);

test('a stale version refreshes the workspace and explains the conflict', async () => {
  stubFetch(409);
  const onChanged = vi.fn();
  render(
    <IncidentOperatorPanel
      workspace={workspace({ attentionReason: 'investigation_failed' })}
      getCredentials={getCredentials}
      onChanged={onChanged}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Retry investigation' }));

  expect((await screen.findByRole('alert')).textContent).toBe(
    'Incident state changed. Review it and try again.',
  );
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test.each([
  { code: 'stale', message: 'Incident state changed. Review it and try again.' },
  {
    code: 'not_retryable',
    message:
      'This investigation can no longer be retried. The incident is closed or its investigation is no longer failed or degraded.',
  },
  {
    code: 'automation_pending',
    message: 'Investigation work is already queued. Wait for it to finish before retrying.',
  },
  { code: 'constructor', message: 'Incident state changed. Review it and try again.' },
])('a retry refused as $code explains why', async ({ code, message }) => {
  stubFetch(409, { error: code });
  const onChanged = vi.fn();
  render(
    <IncidentOperatorPanel
      workspace={workspace({ attentionReason: 'investigation_failed' })}
      getCredentials={getCredentials}
      onChanged={onChanged}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Retry investigation' }));

  expect((await screen.findByRole('alert')).textContent).toBe(message);
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test.each([
  { code: 'invalid', message: 'The incident cannot be resolved from its current state.' },
  { code: 'stale', message: 'Incident state changed. Review it and try again.' },
])('a confirmation refused as $code explains why', async ({ code, message }) => {
  stubFetch(409, { error: code, transition: { outcome: code } });
  render(
    <IncidentOperatorPanel
      workspace={reported()}
      getCredentials={getCredentials}
      onChanged={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Confirm resolved' }));

  expect((await screen.findByRole('alert')).textContent).toBe(message);
});
