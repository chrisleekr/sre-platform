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
  test('retains the transcript and offers explicit reconnect after the socket closes', async () => {
    wsState = {
      ...wsState,
      status: 'closed',
      connectionError: 'Could not connect to the incident stream.',
      messages: [msg({ id: 'retained', content: 'Keep this received message' })],
    };
    globalThis.fetch = vi.fn(async () => response(detail()));

    const { unmount } = renderIncident();

    expect(await screen.findByText('Keep this received message')).toBeDefined();
    expect(screen.getByText(/could not connect/i)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    expect(wsState.retry).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Ask the SRE') as HTMLInputElement).disabled).toBe(true);
    unmount();
  });

  test('keeps the live workspace mounted while a message refreshes the assessment', async () => {
    wsState = {
      ...wsState,
      status: 'open',
      messages: [
        msg({ id: 'newest', kind: 'finding', content: 'Keep the active investigation visible' }),
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(detail()))
      .mockReturnValueOnce(new Promise<Response>(() => {}));
    globalThis.fetch = fetchMock;

    const { unmount } = renderIncident();
    expect(await screen.findByText('Keep the active investigation visible')).toBeDefined();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('heading', { level: 1, name: 'Checkout latency' })).toBeDefined();
    expect(screen.queryByText('Loading incident…')).toBeNull();
    unmount();
  });

  test('enables replies only for an open socket and a non-resolved incident', async () => {
    globalThis.fetch = vi.fn(async () => response(detail()));
    const view = renderIncident();
    expect(await screen.findByText('checkout')).toBeDefined();
    expect((screen.getByLabelText('Ask the SRE') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);

    wsState = { ...wsState, status: 'open' };
    view.rerender(
      <MemoryRouter initialEntries={[`/incidents/${detail().id}`]}>
        <Routes>
          <Route path="/incidents/:id" element={<IncidentConversation />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Ask the SRE') as HTMLInputElement).disabled).toBe(false),
    );
    view.unmount();
  });

  test('keeps a draft until useWsStream confirms an open-socket handoff', async () => {
    wsState = { ...wsState, status: 'open', send: vi.fn(() => false) };
    globalThis.fetch = vi.fn(async () => response(detail()));
    const { unmount } = renderIncident();
    expect(await screen.findByText('checkout')).toBeDefined();
    const input = screen.getByLabelText('Ask the SRE') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Acknowledge and investigate' } });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(input.value).toBe('Acknowledge and investigate');

    wsState.send.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(input.value).toBe('');
    unmount();
  });

  test('resolved and closed incidents remain available for discussion', async () => {
    wsState = { ...wsState, status: 'open', send: vi.fn(() => true) };
    const fetchMock = vi.fn(async () => response(detail({ status: 'resolved' })));
    globalThis.fetch = fetchMock;
    const resolvedView = renderIncident();
    expect(await screen.findByText('checkout')).toBeDefined();
    expect((screen.getByLabelText('Ask the SRE') as HTMLInputElement).disabled).toBe(false);
    resolvedView.unmount();

    globalThis.fetch = vi.fn(async () => response(detail({ status: 'closed' })));
    const closedView = renderIncident();
    expect(await screen.findByText('checkout')).toBeDefined();
    expect((screen.getByLabelText('Ask the SRE') as HTMLInputElement).disabled).toBe(false);
    closedView.unmount();
  });

  test('deletes a terminal incident only after an explicit reason and confirmation', async () => {
    wsState = { ...wsState, status: 'open' };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return response({
          archive: {
            outcome: 'applied',
            archivedAt: '2026-08-27T00:00:00.000Z',
            lifecycleVersion: 2,
          },
        });
      }
      return response(detail({ status: 'resolved', lifecycleVersion: 2 }));
    });
    globalThis.fetch = fetchMock;
    const view = renderIncident();

    expect(await screen.findByRole('button', { name: 'Delete' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirmation = screen.getByRole('alertdialog', { name: 'Delete incident' });
    expect(within(confirmation).getByText(/direct link will stop working/i)).toBeDefined();
    const confirm = within(confirmation).getByRole('button', { name: 'Confirm delete' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(confirmation).getByLabelText('Reason'), {
      target: { value: 'Synthetic verification record.' },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/incidents\/[^/]+\/archive$/),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({
      archived: true,
      reason: 'Synthetic verification record.',
      expectedVersion: 2,
    });
    expect(JSON.parse(String(post[1]!.body)).requestId).toMatch(/^[0-9a-f-]{36}$/i);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull());
    view.unmount();
  });

  test('reports a dashboard-only reply as locally saved without waiting for Slack', async () => {
    wsState = {
      ...wsState,
      status: 'open',
      messages: [
        msg({
          id: 'local-reply',
          author: 'human',
          originSurface: 'dashboard',
          content: 'Recheck the current observation',
        }),
      ],
      postState: {
        clientMessageId: 'client-local-reply',
        messageId: 'local-reply',
        state: 'saved',
      },
    };
    globalThis.fetch = vi.fn(async () =>
      response(detail({ originSurface: null, originThreadId: null })),
    );

    const { unmount } = renderIncident();

    expect(
      await screen.findByText('Saved to the incident. Investigation is continuing.'),
    ).toBeDefined();
    expect(screen.queryByText(/Waiting for Slack/)).toBeNull();
    unmount();
  });
});
