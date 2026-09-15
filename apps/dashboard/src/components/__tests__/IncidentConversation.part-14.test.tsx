// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';

import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { EvidenceDetail, EvidenceListItem, HubMessage } from '../../lib/types';

import type { WsRefusalCode } from '../../lib/useWsStream';

import { IncidentConversation } from '../IncidentConversation';
import { installDialogMethods } from '../../test/dialog';
let dialogMethods: ReturnType<typeof installDialogMethods>;

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
  dialogMethods = installDialogMethods();
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
  dialogMethods.restore();
  window.history.replaceState(null, '', '/');
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
  test('renders persisted metric samples as an accessible chart and the same-data table', async () => {
    const item: EvidenceListItem = {
      id: '33333333-3333-4333-8333-333333333333',
      tool: 'prometheus_query_range',
      outcome: 'data',
      latencyMs: 9,
      recordedAt: '2026-08-21T00:00:00Z',
      hasOutput: true,
    };
    const detailPayload: EvidenceDetail = {
      ...item,
      input: { query: 'up', start: 'now-1h', end: 'now' },
      output: { data: { resultType: 'matrix' } },
      projection: {
        kind: 'time_series',
        source: 'prometheus',
        query: 'up',
        from: '2026-08-20T23:59:00Z',
        to: '2026-08-21T00:00:00Z',
        series: [
          {
            name: 'up {job=checkout}',
            unit: null,
            points: [{ timestamp: '2026-08-21T00:00:00Z', value: 1 }],
          },
          {
            name: 'errors {job=checkout}',
            unit: 'requests',
            points: [
              { timestamp: '2026-08-20T23:59:00Z', value: 0.1 },
              { timestamp: '2026-08-21T00:00:00Z', value: 0.2 },
            ],
          },
        ],
      },
      referenceUrl: 'https://prometheus.example.com/graph?g0.expr=up',
    };
    useIncidentEvidence.mockReturnValue({
      evidence: [item],
      nextCursor: null,
      details: { [item.id]: detailPayload },
      loading: false,
      error: false,
      detailErrors: {},
      loadDetail: vi.fn(),
      loadOlder: vi.fn(),
      refresh: vi.fn(),
    });
    globalThis.fetch = vi.fn(async () => response(detail()));

    const { unmount } = renderIncident();
    fireEvent.click(await screen.findByRole('button', { name: /Prometheus/ }));
    const inspector = within(screen.getByRole('dialog'));
    const unitlessChart = await inspector.findByRole('img', {
      name: 'prometheus metric evidence, unit not reported',
    });
    const requestsChart = inspector.getByRole('img', {
      name: 'prometheus metric evidence, requests',
    });
    expect(unitlessChart.querySelector('circle')).not.toBeNull();
    expect(requestsChart.querySelector('polyline')?.getAttribute('points')).toContain(',200');
    expect(requestsChart.querySelector('polyline')?.getAttribute('points')).toContain(',16');
    expect(screen.getByText('up {job=checkout} · unit not reported')).toBeDefined();
    expect(screen.getByText('errors {job=checkout} · requests')).toBeDefined();
    const captions = inspector.getAllByText((_, element) => element?.tagName === 'FIGCAPTION');
    expect(captions).toHaveLength(2);
    expect(captions.every((caption) => caption.textContent?.includes('Recorded'))).toBe(true);
    for (const disclosure of screen.getAllByText('View chart data table')) {
      fireEvent.click(disclosure);
    }
    const unitlessTable = screen.getByRole('table', {
      name: 'Metric evidence data, unit not reported',
    });
    const requestsTable = screen.getByRole('table', { name: 'Metric evidence data, requests' });
    expect(within(unitlessTable).getAllByRole('row')).toHaveLength(2);
    expect(within(requestsTable).getAllByRole('row')).toHaveLength(3);
    expect(within(requestsTable).getByText('2026-08-20T23:59:00Z')).toBeDefined();
    expect(within(requestsTable).getByRole('cell', { name: '0.1' })).toBeDefined();
    expect(within(requestsTable).getByRole('cell', { name: '0.2' })).toBeDefined();
    expect(within(unitlessTable).getByRole('cell', { name: '1' })).toBeDefined();
    expect(
      screen.getByRole('link', { name: 'Open provider reference ↗' }).getAttribute('href'),
    ).toBe(detailPayload.referenceUrl);
    unmount();
  });

  test('shows a retryable unavailable state instead of claiming evidence is empty', async () => {
    const refresh = vi.fn();
    useIncidentEvidence.mockReturnValue({
      evidence: [],
      nextCursor: null,
      details: {},
      loading: false,
      error: true,
      detailErrors: {},
      loadDetail: vi.fn(),
      loadOlder: vi.fn(),
      refresh,
    });
    globalThis.fetch = vi.fn(async () => response(detail()));

    const { unmount } = renderIncident();
    fireEvent.click(await screen.findByRole('button', { name: /All evidence/ }));
    expect(await screen.findByText(/Evidence is unavailable\./)).toBeDefined();
    expect(screen.queryByText('No checks recorded yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry evidence' }));
    expect(refresh).toHaveBeenCalledOnce();
    unmount();
  });

  test('keeps one page heading across loading, not-found, and load-error states', async () => {
    const assertHeading = () => {
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.getByRole('heading', { level: 1, name: 'Incident' })).toBeDefined();
    };

    globalThis.fetch = vi.fn(() => new Promise<Response>(() => {}));
    const loadingView = renderIncident();
    expect(screen.getAllByText('Loading incident…')).toHaveLength(1);
    assertHeading();
    loadingView.unmount();

    globalThis.fetch = vi.fn(async () => response({ error: 'incident not found' }, 404));
    const missingView = renderIncident();
    expect(await screen.findByText('Incident not found.')).toBeDefined();
    expect(screen.getAllByText('Incident not found.')).toHaveLength(1);
    assertHeading();
    missingView.unmount();

    globalThis.fetch = vi.fn(async () => response({ error: 'unavailable' }, 503));
    const errorView = renderIncident();
    expect(await screen.findByText('Failed to load incident.')).toBeDefined();
    expect(screen.getAllByText('Failed to load incident.')).toHaveLength(1);
    assertHeading();
    errorView.unmount();
  });

  test('gates the WebSocket and attachment list while incident detail is loading', () => {
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => {}));

    const { unmount } = renderIncident();

    expect(screen.getByText(/loading incident/i)).toBeDefined();
    expect(useWsStream.mock.calls.some(([id]) => id === detail().id)).toBe(false);
    expect(useAttachments.mock.calls.some(([id]) => id === detail().id)).toBe(false);
    unmount();
  });

  test('shows a reliable back path and incident identity before starting live hooks', async () => {
    globalThis.fetch = vi.fn(async () => response(detail()));

    const { container, unmount } = renderIncident();

    expect(await screen.findByText('checkout')).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Checkout latency' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Incidents' }).getAttribute('href')).toBe(
      '/w/incidents',
    );
    for (const value of ['sev2', 'mitigated']) {
      expect(screen.getByText(value)).toBeDefined();
    }
    expect(screen.getByText(/Slack · #homelab-notification · link unavailable/)).toBeDefined();
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(detail().createdAt);
    expect(useWsStream).toHaveBeenCalledWith(detail().id, expect.any(Object));
    expect(useAttachments).toHaveBeenCalledWith(detail().id, expect.any(Object));
    unmount();
  });

  test('settles missing detail into a non-disclosing not-found state with a back path', async () => {
    globalThis.fetch = vi.fn(async () => response({ error: 'incident not found' }, 404));

    const { unmount } = renderIncident();

    expect(await screen.findByText(/incident not found/i)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Incidents' }).getAttribute('href')).toBe(
      '/w/incidents',
    );
    expect(useWsStream.mock.calls.some(([id]) => id === detail().id)).toBe(false);
    expect(useAttachments.mock.calls.some(([id]) => id === detail().id)).toBe(false);
    unmount();
  });

  test('offers a safe detail retry after a load error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(response(detail()));
    globalThis.fetch = fetchMock;

    const { unmount } = renderIncident();
    expect(await screen.findByText(/failed to load incident/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByText('checkout')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
  });
});
