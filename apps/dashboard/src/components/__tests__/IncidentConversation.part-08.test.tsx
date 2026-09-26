// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';

import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HubMessage } from '../../lib/types';

import type { WsRefusalCode } from '../../lib/useWsStream';

import { IncidentConversation, lifecycleActions, signalTargets } from '../IncidentConversation';

const getCredentials = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'bearer' as const, token: 'jwt' })),
);

const useWsStream = vi.hoisted(() => vi.fn());

const useAttachments = vi.hoisted(() => vi.fn());

const useIncidentHistory = vi.hoisted(() => vi.fn());

const useIncidentEvidence = vi.hoisted(() => vi.fn());

const useSlackPermalink = vi.hoisted(() => vi.fn());

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials, user: { name: 'Dev Responder', email: 'dev@example.com' } }),
}));

vi.mock('../../lib/useWsStream', () => ({ useWsStream }));

vi.mock('../../lib/useAttachments', () => ({ useAttachments }));

vi.mock('../../lib/useIncidentHistory', () => ({ useIncidentHistory }));

vi.mock('../../lib/useIncidentEvidence', () => ({ useIncidentEvidence }));

vi.mock('../../lib/useSlackPermalink', () => ({ useSlackPermalink }));

// jsdom has no IntersectionObserver; LazyImage (in MessageAttachments) constructs one on mount. A
// no-op stub lets the attachment element render for the attachment wiring test without driving intersection.
beforeAll(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof IntersectionObserver,
  );
});

afterAll(() => vi.unstubAllGlobals());

const originalFetch = globalThis.fetch;

let wsState: {
  messages: HubMessage[];
  status: 'idle' | 'connecting' | 'open' | 'closed';
  error: string | null;
  errorCode: WsRefusalCode | null;
  connectionError: string | null;
  postState: null | {
    clientMessageId: string;
    messageId: string | null;
    state: 'saving' | 'saved' | 'failed';
  };
  send: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  wsState = {
    messages: [],
    status: 'connecting',
    error: null,
    errorCode: null,
    connectionError: null,
    postState: null,
    send: vi.fn(() => false),
    retry: vi.fn(),
  };
  useWsStream.mockImplementation(() => wsState);
  useAttachments.mockReturnValue({ attachments: [] });
  useIncidentHistory.mockImplementation(() => ({
    messages: wsState.messages,
    hasOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    refresh: vi.fn(),
  }));
  useIncidentEvidence.mockReturnValue({
    evidence: [],
    nextCursor: null,
    details: {},
    loading: false,
    error: false,
    paginationError: false,
    detailErrors: {},
    loadDetail: vi.fn(),
    loadOlder: vi.fn(),
    refresh: vi.fn(),
  });
  useSlackPermalink.mockReturnValue({
    permalink: null,
    loading: false,
    error: false,
    refresh: vi.fn(),
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useWsStream.mockClear();
  useAttachments.mockClear();
  useIncidentHistory.mockClear();
  useIncidentEvidence.mockClear();
  useSlackPermalink.mockClear();
  getCredentials.mockClear();
});

const detail = (
  over: Partial<{
    id: string;
    service: string;
    severity: string;
    status: string;
    investigationStatus: 'queued' | 'gathering' | 'assessed' | 'degraded';
    lifecycleVersion: number;
    alertSource: string;
    title: string | null;
    rcaSummary: string | null;
    confidence: number | null;
    recoveryState: 'verifying' | 'monitoring' | 'verified' | 'not_verified' | null;
    recoverySummary: string | null;
    recoveryAttempt: number | null;
    recoveryMaxChecks: number | null;
    recoveryNextCheckAt: string | null;
    recoveryScheduleReason: string | null;
    archivedAt: string | null;
    createdAt: string;
    originSurface: string | null;
    originChannel: string | null;
    originChannelName: string | null;
    originThreadId: string | null;
    requiresHumanAttention: boolean;
    attentionReason: string | null;
  }> = {},
) => ({
  id: '11111111-1111-4111-8111-111111111111',
  service: 'checkout',
  severity: 'sev2',
  status: 'mitigated',
  investigationStatus: 'gathering',
  lifecycleVersion: 1,
  alertSource: 'datadog',
  title: 'Checkout latency',
  rcaSummary: null,
  confidence: null,
  createdAt: '2026-08-18T01:05:00.000Z',
  originSurface: 'slack',
  originChannel: 'C07EWAS8132',
  originChannelName: '#homelab-notification',
  originThreadId: '1787261092.493559',
  requiresHumanAttention: true,
  attentionReason: 'mitigation_active',
  ...over,
});

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function incidentElement(id = detail().id) {
  return (
    <MemoryRouter initialEntries={[`/incidents/${id}`]}>
      <Routes>
        <Route path="/incidents/:id" element={<IncidentConversation />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderIncident(id = detail().id) {
  return render(incidentElement(id));
}

describe('incident response workspace', () => {
  test('extracts distinct Alertmanager targets without granting the text lifecycle authority', () => {
    expect(
      signalTargets(
        'Load at 192.168.1.202:9100 and 192.168.1.203:9100; repeated 192.168.1.202:9100.',
      ),
    ).toEqual(['192.168.1.202:9100', '192.168.1.203:9100']);
  });

  test('offers only valid lifecycle actions for every state', () => {
    expect(lifecycleActions('open').map((action) => action.to)).toEqual([
      'mitigated',
      'resolved',
      'closed',
    ]);
    expect(lifecycleActions('mitigated').map((action) => action.to)).toEqual([
      'open',
      'resolved',
      'closed',
    ]);
    expect(lifecycleActions('resolved').map((action) => action.to)).toEqual(['open', 'closed']);
    expect(lifecycleActions('closed').map((action) => action.to)).toEqual(['open']);
    expect(lifecycleActions('legacy')).toEqual([]);
  });

  test('surfaces the assessment, hypotheses, unknowns, next step, and factual check counts', async () => {
    const supportId = '11111111-1111-4111-8111-111111111111';
    const contradictId = '22222222-2222-4222-8222-222222222222';
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({
          rcaSummary: 'The database pool is saturated.',
          confidence: 82,
          currentState: 'Degraded but serving traffic',
          impact: 'Checkout p95 latency is elevated.',
          assessmentEvidenceIds: [supportId],
          rankedHypotheses: [
            {
              hypothesis: 'Connection leak',
              confidence: 82,
              evidence: 'Active connections rose.',
              state: 'leading',
              supportingEvidenceIds: [supportId],
              contradictingEvidenceIds: [contradictId],
            },
          ],
          unknowns: [
            {
              question: 'Whether the last deploy changed pool settings',
              category: 'partial_evidence',
              evidenceKind: 'deployment_as_of',
              attemptedEvidenceIds: [supportId],
            },
          ],
          nextStep: 'Compare pool settings before and after the deploy.',
          assessmentUpdatedAt: '2026-08-21T00:00:00Z',
        } as never),
        viewerUserId: '11111111-1111-4111-8111-111111111111',
        progress: { total: 7, successful: 5, failed: 2, lastRecordedAt: null },
        signals: [
          {
            id: 'signal-1',
            surface: 'slack',
            channel: 'C07EWAS8132',
            state: 'firing',
            summary: 'CheckoutHighErrorRate',
            lastEventType: 'updated',
            version: 2,
            lastSeenAt: '2026-08-21T00:00:00Z',
          },
        ],
      }),
    );
    const { unmount } = renderIncident();
    expect(await screen.findByText('The database pool is saturated.')).toBeDefined();
    expect(screen.getByText('Degraded but serving traffic')).toBeDefined();
    expect(screen.getByText('Checkout p95 latency is elevated.')).toBeDefined();
    expect(screen.getAllByText(/Connection leak/)).toHaveLength(3);
    expect(
      screen.getAllByRole('link', { name: `Open evidence ${supportId}` }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('link', { name: `Open evidence ${contradictId}`, hidden: true }),
    ).toHaveLength(4);
    expect(screen.getByText('Whether the last deploy changed pool settings')).toBeDefined();
    expect(screen.getByText('Partial evidence')).toBeDefined();
    expect(screen.getByText('deployment as of')).toBeDefined();
    expect(screen.getByText('Compare pool settings before and after the deploy.')).toBeDefined();
    expect(screen.getAllByText('CheckoutHighErrorRate')).toHaveLength(2);
    expect(screen.getAllByText('1 unresolved record')).toHaveLength(2);
    expect(screen.getByText('Model confidence 82/100')).toBeDefined();
    expect(screen.getByText('7')).toBeDefined();
    unmount();
  });

  test('keeps trusted assessment citations while showing a newer non-conclusive run separately', async () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    const trustedSummary = 'The database pool is saturated.';
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({
          investigationStatus: 'assessed',
          rcaSummary: trustedSummary,
          confidence: 82,
          assessmentEvidenceIds: [evidenceId],
          assessmentUpdatedAt: '2026-08-31T00:00:00.000Z',
          latestInvestigationRun: {
            id: '22222222-2222-4222-8222-222222222222',
            operation: 'investigate',
            outcome: 'budget_exhausted',
            triggerReason: 'new_episode',
            triggerAutomatic: true,
            triggerMonitorKey: 'alertmanager:checkout-errors',
            triggerMonitorKeys: ['alertmanager:checkout-errors'],
            triggerBudget: {
              windowHours: 24,
              tenant: {
                runs: 10,
                configuredCostUsd: 5,
                pendingCostRuns: 0,
                missingUsageRuns: 0,
                unpricedRuns: 0,
                runLimit: 10,
                configuredCostLimitUsd: 0,
              },
              monitors: [
                {
                  monitorKey: 'alertmanager:checkout-errors',
                  runs: 3,
                  configuredCostUsd: 2,
                  pendingCostRuns: 0,
                  missingUsageRuns: 0,
                  unpricedRuns: 0,
                  runLimit: 3,
                  configuredCostLimitUsd: 0,
                },
              ],
              exhaustedBy: ['tenant_run_limit', 'monitor_run_limit'],
            },
            completedAt: '2026-08-31T00:02:00.000Z',
          },
        } as never),
        viewerUserId: null,
        progress: { total: 8, successful: 7, failed: 1, lastRecordedAt: null },
        signals: [],
      }),
    );

    const { unmount } = renderIncident();
    expect((await screen.findAllByText(trustedSummary)).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: `Open evidence ${evidenceId}` })).toBeDefined();
    expect(screen.getByText('Latest investigation run')).toBeDefined();
    expect(screen.getByText('Latest follow-up: Budget exhausted')).toBeDefined();
    expect(screen.getByText(/Investigate · Budget exhausted/i)).toBeDefined();
    expect(screen.getByText(/Trigger: New alert episode · automatic/i)).toBeDefined();
    expect(screen.getByText(/24h before run: tenant 10 \/ 10 runs/i)).toBeDefined();
    unmount();
  });

  test('uses a newer recovery decision for state, freshness, citations, and evidence preselection', async () => {
    const assessmentId = '11111111-1111-4111-8111-111111111111';
    const recoveryId = '22222222-2222-4222-8222-222222222222';
    const loadDetail = vi.fn();
    useIncidentEvidence.mockReturnValue({
      evidence: [],
      nextCursor: null,
      details: {},
      loading: false,
      error: false,
      paginationError: false,
      detailErrors: {},
      loadDetail,
      loadOlder: vi.fn(),
      refresh: vi.fn(),
    });
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({
          rcaSummary: 'The database pool was saturated.',
          currentState: 'Degraded',
          assessmentEvidenceIds: [assessmentId],
          assessmentUpdatedAt: '2026-08-21T00:00:00Z',
          recoveryState: 'verified',
          recoverySummary: 'Current metrics confirm the pool has recovered.',
          recoveryEvidenceIds: [recoveryId],
          recoveryUnknowns: ['Whether the downstream synthetic has also recovered'],
          recoveryNextStep: 'Confirm the downstream synthetic before resolving.',
          recoveryUpdatedAt: '2026-08-21T01:00:00Z',
        } as never),
        viewerUserId: null,
        progress: { total: 2, successful: 2, failed: 0, lastRecordedAt: null },
        signals: [
          {
            id: 'signal-recovered-with-followup',
            surface: 'slack',
            channel: 'C07EWAS8132',
            state: 'resolved',
            summary: '[RESOLVED] checkout pool saturation',
            lastEventType: 'resolved',
            version: 2,
            lastSeenAt: '2026-08-21T01:00:00Z',
          },
        ],
      }),
    );

    const { unmount } = renderIncident();
    const brief = (await screen.findByText('Responder brief')).closest('section')!;
    expect(within(brief).getByRole('heading', { name: 'Recovery verified' })).toBeDefined();
    expect(
      within(brief).getByRole('heading', { name: 'Unclassified recovery questions' }),
    ).toBeDefined();
    expect(
      within(brief).getByText('Current metrics confirm the pool has recovered.'),
    ).toBeDefined();
    expect(within(brief).getByRole('link', { name: `Open evidence ${recoveryId}` })).toBeDefined();
    expect(within(brief).queryByRole('link', { name: `Open evidence ${assessmentId}` })).toBeNull();
    expect(
      within(brief).getByText('Whether the downstream synthetic has also recovered'),
    ).toBeDefined();
    expect(
      within(brief).getByText('Confirm the downstream synthetic before resolving.'),
    ).toBeDefined();
    expect(screen.getByText('Recovery verified; lifecycle transition is pending.')).toBeDefined();
    expect(
      screen.getByText(
        'SRE Platform should resolve this recovered occurrence automatically. Preventative follow-up remains in the brief but does not keep the incident active.',
      ),
    ).toBeDefined();
    expect(within(brief).queryByText(/Model confidence/)).toBeNull();
    await waitFor(() => expect(loadDetail).toHaveBeenCalledWith(recoveryId));
    unmount();
  });
});

test('distinguishes recovery blockers and follow-up work with actionable evidence links', async () => {
  const attempt = '33333333-3333-4333-8333-333333333333';
  globalThis.fetch = vi.fn(async () =>
    response({
      incident: detail({
        recoveryState: 'not_verified',
        recoverySummary: 'One health check remains.',
        recoveryUpdatedAt: '2026-08-21T01:00:00Z',
        recoveryUnknowns: ['Stale legacy copy'],
        recoveryQuestions: [
          {
            question: 'Is the deployment ready?',
            category: 'missing_capability',
            evidenceKind: 'runtime_state',
            resolutionRelevance: 'blocking',
            nextAction: 'Restore read access and check readiness.',
            attemptedEvidenceIds: [attempt],
          },
          {
            question: 'What caused the earlier outage?',
            category: 'historical_gap',
            evidenceKind: null,
            resolutionRelevance: 'follow_up',
            nextAction: 'Review retained events for prevention.',
            attemptedEvidenceIds: [],
          },
        ],
      } as never),
      viewerUserId: null,
      signals: [],
      progress: { total: 1, successful: 0, failed: 1, lastRecordedAt: null },
    }),
  );
  const { unmount } = renderIncident();
  const brief = (await screen.findByText('Responder brief')).closest('section')!;
  expect(within(brief).getByRole('heading', { name: 'Blocks resolution' })).toBeDefined();
  expect(within(brief).getByRole('heading', { name: 'Follow-up work' })).toBeDefined();
  expect(within(brief).getByText('Connector or metadata needed')).toBeDefined();
  expect(within(brief).getByText('Restore read access and check readiness.')).toBeDefined();
  expect(within(brief).getByRole('link', { name: `Open evidence ${attempt}` })).toBeDefined();
  expect(within(brief).getByText('No recorded check attempts')).toBeDefined();
  expect(within(brief).queryByText('Stale legacy copy')).toBeNull();
  unmount();
});
