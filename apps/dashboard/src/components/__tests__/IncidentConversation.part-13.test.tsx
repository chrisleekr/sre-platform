// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { EvidenceDetail, EvidenceListItem, HubMessage } from '../../lib/types';

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

const msg = (over: Partial<HubMessage> = {}): HubMessage => ({
  id: 'm1',
  incidentId: 'i1',
  author: 'agent',
  kind: 'text',
  content: 'looking into it',
  createdAt: 't',
  ...over,
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
  test('flags a terminal lifecycle while a provider signal is still active', async () => {
    const workspace = {
      incident: detail({ status: 'resolved', investigationStatus: 'assessed' }),
      viewerUserId: '11111111-1111-4111-8111-111111111111',
      progress: { total: 4, successful: 4, failed: 0, lastRecordedAt: null },
      signals: [
        {
          id: 'signal-refired',
          surface: 'slack',
          channel: 'C07EWAS8132',
          state: 'firing',
          summary: '[FIRING] monitoring (NodeSystemSaturation warning)',
          lastEventType: 'refired',
          version: 3,
          lastSeenAt: '2026-08-21T00:00:00Z',
        },
      ],
    };
    let corrected = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        corrected = true;
        return response({
          correction: { outcome: 'applied', signalId: 'signal-refired', version: 4 },
        });
      }
      return response(
        corrected
          ? {
              ...workspace,
              signals: [
                {
                  ...workspace.signals[0],
                  state: 'resolved',
                  lastEventType: 'resolved',
                  version: 4,
                },
              ],
            }
          : workspace,
      );
    });
    globalThis.fetch = fetchMock;

    const view = renderIncident();

    expect(await screen.findByText('Incident resolved')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toMatch(
      /lifecycle is resolved, but 1 provider signal is still active/i,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review signal state' }));
    expect(screen.getByText('Correct a mistaken provider projection')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Correction reason'), {
      target: { value: 'The provider recovery message was misclassified.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark selected signal cleared' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/incidents/${detail().id}/signals/signal-refired/correct`),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"expectedVersion":3'),
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText(/provider signal is still active/i)).toBeNull());
    view.unmount();
  });

  test('keeps transcript and evidence visible when the structured assessment is invalid', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({ rankedHypotheses: [], unknowns: [] } as never),
        assessmentState: 'invalid',
        viewerUserId: null,
        progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
      }),
    );
    wsState = { ...wsState, messages: [msg({ content: 'Transcript remains available' })] };

    const { unmount } = renderIncident();

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /structured assessment is invalid/i,
    );
    expect(screen.getByText('Transcript remains available')).toBeDefined();
    expect(screen.getByText('Evidence ledger')).toBeDefined();
    unmount();
  });

  test('wires evidence expansion, detail JSON, and older-page loading to the evidence hook', async () => {
    const item: EvidenceListItem = {
      id: 'evidence-1',
      tool: 'query_metrics',
      outcome: 'data',
      latencyMs: 12,
      recordedAt: '2026-08-21T00:00:00Z',
      hasOutput: true,
    };
    const detailPayload: EvidenceDetail = {
      ...item,
      input: { service: 'checkout' },
      output: { saturation: 0.98 },
      projection: {
        kind: 'facts',
        columns: ['saturation'],
        rows: [{ saturation: 0.98 }],
      },
      referenceUrl: null,
    };
    const loadDetail = vi.fn();
    const loadOlder = vi.fn();
    useIncidentEvidence.mockReturnValue({
      evidence: [item],
      nextCursor: 'older-page',
      details: { [item.id]: detailPayload },
      loading: false,
      error: false,
      paginationError: true,
      detailErrors: {},
      loadDetail,
      loadOlder,
      refresh: vi.fn(),
    });
    globalThis.fetch = vi.fn(async () => response(detail()));

    const { unmount } = renderIncident();
    const summary = await screen.findByRole('button', { name: /Metrics/ });
    fireEvent.click(summary);

    expect(loadDetail).toHaveBeenCalledWith(item.id);
    const factTable = screen.getByRole('table', { name: 'Human-readable evidence facts' });
    expect(within(factTable).getByRole('columnheader', { name: 'saturation' })).toBeDefined();
    expect(within(factTable).getByRole('cell', { name: '0.98' })).toBeDefined();
    const rawEvidence = screen.getByText('Raw evidence').closest('details')!;
    expect(rawEvidence.hasAttribute('open')).toBe(false);
    fireEvent.click(screen.getByText('Raw evidence'));
    expect(screen.getByText(/"service": "checkout"/)).toBeDefined();
    expect(screen.getByText(/"saturation": 0.98/)).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('Older evidence is unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry older evidence' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load older evidence' }));
    expect(loadOlder).toHaveBeenCalledTimes(2);
    unmount();
  });
});
