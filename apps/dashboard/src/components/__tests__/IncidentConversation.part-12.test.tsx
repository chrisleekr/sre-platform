// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
  test('shows model-directed recovery monitoring without asking for human action', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({
          status: 'open',
          investigationStatus: 'assessed',
          lifecycleVersion: 0,
          recoveryState: 'monitoring',
          recoverySummary: 'Latency is improving while the rollout converges.',
          recoveryAttempt: 1,
          recoveryMaxChecks: 3,
          recoveryNextCheckAt: '2026-08-21T00:10:00Z',
          recoveryScheduleReason: 'The rollout is still converging.',
          requiresHumanAttention: false,
        }),
        viewerUserId: null,
        progress: { total: 4, successful: 4, failed: 0, lastRecordedAt: null },
        signals: [
          {
            id: 'signal-resolved-monitoring',
            surface: 'slack',
            channel: 'C07EWAS8132',
            state: 'resolved',
            summary: '[RESOLVED] CheckoutLatency',
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
      (await screen.findAllByText(/scheduled recovery check overdue/i)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Recovery not verified')).toBeDefined();
    expect(screen.queryByText(/no human action is required yet/i)).toBeNull();
    view.unmount();
  });

  test('rolls grouped Alertmanager history up by target and collapses cleared notification noise', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({ status: 'open', investigationStatus: 'assessed', lifecycleVersion: 0 }),
        viewerUserId: null,
        progress: { total: 4, successful: 4, failed: 0, lastRecordedAt: null },
        signals: [
          {
            id: 'group-firing',
            surface: 'slack',
            channel: 'C07EWAS8132',
            state: 'firing',
            summary:
              '[FIRING:2] NodeSystemSaturation\nLoad at 192.168.1.202:9100 and 192.168.1.203:9100.',
            lastEventType: 'opened',
            version: 1,
            firstSeenAt: '2026-08-23T06:07:00Z',
            lastSeenAt: '2026-08-23T06:07:00Z',
            resolvedAt: null,
          },
          {
            id: 'target-resolved',
            surface: 'slack',
            channel: 'C07EWAS8132',
            state: 'resolved',
            summary: '[RESOLVED] NodeSystemSaturation\nLoad at 192.168.1.203:9100.',
            lastEventType: 'resolved',
            version: 2,
            firstSeenAt: '2026-08-23T06:12:00Z',
            lastSeenAt: '2026-08-23T06:17:00Z',
            resolvedAt: '2026-08-23T06:17:00Z',
          },
        ],
      }),
    );

    const view = renderIncident();

    expect(await screen.findByText('192.168.1.202:9100 · firing')).toBeDefined();
    expect(screen.getByText('192.168.1.203:9100 · resolved')).toBeDefined();
    expect(screen.getByText('Unresolved notification records')).toBeDefined();
    expect(screen.getByText('1 cleared notification record')).toBeDefined();
    expect(screen.getByText(/Alertmanager can aggregate several targets/)).toBeDefined();
    view.unmount();
  });

  test('links the Slack origin to its server-resolved thread permalink', async () => {
    useSlackPermalink.mockReturnValue({
      permalink: 'https://company.slack.com/archives/C07EWAS8132/p1787261092493559',
      loading: false,
      error: false,
      refresh: vi.fn(),
    });
    globalThis.fetch = vi.fn(async () => response(detail()));

    const view = renderIncident();

    const link = await screen.findByRole('link', { name: 'Slack · #homelab-notification ↗' });
    expect(link.getAttribute('href')).toBe(
      'https://company.slack.com/archives/C07EWAS8132/p1787261092493559',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(useSlackPermalink).toHaveBeenCalledWith(detail().id, expect.any(Object));
    view.unmount();
  });

  test('presents a shareable incident page with breadcrumbs and a distinct browser title', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    globalThis.fetch = vi.fn(async () => response(detail()));

    const view = renderIncident();

    expect(await screen.findByRole('heading', { name: 'Checkout latency' })).toBeDefined();
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).queryByRole('button', { name: 'Issues' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Issues' })).toBeDefined();
    expect(within(breadcrumb).getByRole('link', { name: 'Dashboard' }).getAttribute('href')).toBe(
      '/w',
    );
    expect(within(breadcrumb).getByRole('link', { name: 'Incidents' }).getAttribute('href')).toBe(
      '/w/incidents',
    );
    await waitFor(() => expect(document.title).toBe('SEV2 · Checkout latency · SRE Platform'));

    fireEvent.click(screen.getByRole('button', { name: 'Copy incident link' }));

    expect(await screen.findByRole('button', { name: 'Incident link copied' })).toBeDefined();
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    view.unmount();
  });
});
