// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HubMessage } from '../../lib/types';

import type { WsRefusalCode } from '../../lib/useWsStream';

import { IncidentConversation } from '../IncidentConversation';

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
  test('shows resolved repositories and recent signed changes as first-class incident evidence', async () => {
    const fetchMock = vi.fn(async () =>
      response({
        incident: detail(),
        viewerUserId: '11111111-1111-4111-8111-111111111111',
        progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
        signals: [],
        codeContext: {
          resolvedServices: ['checkout', 'checkout-worker'],
          repositories: [
            {
              serviceName: 'checkout',
              provider: 'github',
              dataSourceId: '00000000-0000-4000-8000-000000000001',
              dataSourceName: 'Primary GitHub',
              repositoryId: '202',
              fullName: 'acme/checkout',
              defaultBranch: 'main',
              private: true,
              archived: false,
              htmlUrl: 'https://github.com/acme/checkout',
              path: 'services/checkout',
              source: 'mapping',
              confirmed: false,
            },
            {
              serviceName: 'checkout-worker',
              provider: 'github',
              dataSourceId: '00000000-0000-4000-8000-000000000001',
              dataSourceName: 'Primary GitHub',
              repositoryId: '202',
              fullName: 'acme/checkout',
              defaultBranch: 'main',
              private: true,
              archived: false,
              htmlUrl: 'https://github.com/acme/checkout',
              path: 'services/checkout-worker',
              source: 'mapping',
              confirmed: false,
            },
          ],
          events: [
            {
              provider: 'github',
              dataSourceId: '00000000-0000-4000-8000-000000000001',
              dataSourceName: 'Primary GitHub',
              eventType: 'workflow_run',
              action: 'completed',
              repositoryFullName: 'acme/checkout',
              actor: 'deploy-bot',
              ref: 'refs/heads/main',
              sha: 'abcdef1234567890',
              summary: { conclusion: 'failure' },
              occurredAt: '2026-08-21T00:00:00Z',
            },
          ],
        },
      }),
    );
    globalThis.fetch = fetchMock;

    const view = renderIncident();

    expect(await screen.findByRole('heading', { name: 'Code context' })).toBeDefined();
    const repositories = screen.getAllByRole('link', { name: 'acme/checkout' });
    const codeContext = screen.getByRole('heading', { name: 'Code context' }).closest('section')!;
    expect(codeContext.className).toContain('@container');
    expect(screen.getByLabelText('Resolved repositories').parentElement?.className).toContain(
      '@3xl:grid-cols',
    );
    expect(repositories).toHaveLength(2);
    expect(repositories[0]!.getAttribute('href')).toBe('https://github.com/acme/checkout');
    expect(
      screen.getByText(/Discovered from Argo CD · checkout · services\/checkout · main/),
    ).toBeDefined();
    expect(screen.getByText('workflow run · completed')).toBeDefined();
    expect(screen.getByText('failure')).toBeDefined();
    expect(screen.getByText(/acme\/checkout · main · abcdef12 · deploy-bot/)).toBeDefined();
    expect(
      screen.getByText(
        /Discovered from Argo CD · checkout-worker · services\/checkout-worker · main/,
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm for checkout-worker' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/incidents/${detail().id}/code-context/confirm`),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            provider: 'github',
            dataSourceId: '00000000-0000-4000-8000-000000000001',
            repositoryId: '202',
            serviceName: 'checkout-worker',
            path: 'services/checkout-worker',
          }),
        }),
      ),
    );
    view.unmount();
  });

  test('separates cleared provider signals from responder-controlled lifecycle state', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({
          status: 'open',
          investigationStatus: 'gathering',
          lifecycleVersion: 0,
          recoveryState: 'verifying',
        }),
        viewerUserId: '11111111-1111-4111-8111-111111111111',
        progress: { total: 4, successful: 4, failed: 0, lastRecordedAt: null },
        signals: [
          {
            id: 'signal-resolved',
            surface: 'slack',
            channel: 'C07EWAS8132',
            state: 'resolved',
            summary: '[RESOLVED] monitoring (NodeSystemSaturation warning)',
            lastEventType: 'created',
            version: 2,
            lastSeenAt: '2026-08-21T00:00:00Z',
          },
        ],
      }),
    );

    const view = renderIncident();

    expect(await screen.findByText('All signals clear')).toBeDefined();
    expect(screen.getByText('Signals cleared; recovery verification is running.')).toBeDefined();
    expect(
      screen.getByText(
        /checking current evidence before deciding whether human attention is required/i,
      ),
    ).toBeDefined();
    view.unmount();
  });

  test('shows a structured positive recovery result without closing lifecycle automatically', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({
          status: 'mitigated',
          investigationStatus: 'assessed',
          lifecycleVersion: 1,
          recoveryState: 'verified',
          recoverySummary: 'Current telemetry confirms the synthetic check recovered.',
        }),
        viewerUserId: null,
        progress: { total: 4, successful: 4, failed: 0, lastRecordedAt: null },
        signals: [
          {
            id: 'signal-resolved',
            surface: 'slack',
            channel: 'C07EWAS8132',
            state: 'resolved',
            summary: '[RESOLVED] SyntheticCheck',
            lastEventType: 'resolved',
            version: 2,
            firstSeenAt: '2026-08-21T00:00:00Z',
            lastSeenAt: '2026-08-21T00:05:00Z',
            resolvedAt: '2026-08-21T00:05:00Z',
          },
        ],
      }),
    );

    const view = renderIncident();

    expect(
      await screen.findByText('Recovery verified; lifecycle transition is pending.'),
    ).toBeDefined();
    expect(
      screen.getByText('Current telemetry confirms the synthetic check recovered.'),
    ).toBeDefined();
    expect(screen.getByText('Needs human attention; mitigation in place')).toBeDefined();
    view.unmount();
  });

  test('does not report missing provider signals for a human-created incident', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({
          alertSource: 'manual',
          originSurface: 'dashboard',
          originChannel: null,
          originChannelName: null,
          originThreadId: null,
        }),
        viewerUserId: null,
        progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
        signals: [],
      }),
    );

    const view = renderIncident();

    expect(await screen.findByText('Not applicable for human report')).toBeDefined();
    expect(screen.queryByText('Signal tracking unavailable')).toBeNull();
    view.unmount();
  });

  test('reports unavailable tracking when a provider-backed incident has no signals', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({ alertSource: 'prometheus' }),
        viewerUserId: null,
        progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
        signals: [],
      }),
    );

    const view = renderIncident();

    expect(await screen.findByText('Signal tracking unavailable')).toBeDefined();
    view.unmount();
  });
});
