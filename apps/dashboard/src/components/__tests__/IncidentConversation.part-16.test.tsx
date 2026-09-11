// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

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

test('a failed investigation offers a reviewable retry request without sending immediately', async () => {
  globalThis.fetch = vi.fn(async () =>
    response({
      ...detail({ investigationStatus: 'degraded' }),
      pendingAutomation: null,
      latestInvestigationRun: {
        id: 'run',
        outcome: 'failed',
        summary: 'AI provider rate limit reached.',
      },
    }),
  );
  wsState.status = 'open';
  const view = renderIncident();
  const retry = await screen.findByRole('button', { name: 'Prepare retry request' });
  fireEvent.click(retry);
  expect((screen.getByLabelText('Ask the SRE') as HTMLTextAreaElement).value).toContain(
    'Please retry the investigation',
  );
  expect(wsState.send).not.toHaveBeenCalled();
  view.unmount();
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

function NavigableIncident() {
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() => navigate('/incidents/22222222-2222-4222-8222-222222222222')}
      >
        Next incident
      </button>
      <Routes>
        <Route path="/incidents/:id" element={<IncidentConversation />} />
      </Routes>
    </>
  );
}

describe('incident response workspace', () => {
  test('uses a normalized signal name when a legacy incident has no title', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({ service: 'slack:C07EWAS8132', title: null }),
        viewerUserId: null,
        progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
        signals: [
          {
            id: 'signal-title',
            surface: 'slack',
            channel: 'C07EWAS8132',
            externalMessageId: '1788013740.759289',
            state: 'resolved',
            lastEventType: 'resolved',
            summary: 'Pod api-7d9f is restarting',
            alertName: 'Pod is crash looping.',
            version: 1,
            firstSeenAt: '2026-09-01T00:00:00.000Z',
            lastSeenAt: '2026-09-01T00:05:00.000Z',
            resolvedAt: '2026-09-01T00:05:00.000Z',
          },
        ],
      }),
    );

    const view = renderIncident();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Pod is crash looping.' }),
    ).toBeDefined();
    expect(screen.queryByRole('heading', { level: 1, name: 'slack:C07EWAS8132' })).toBeNull();
    await waitFor(() => expect(document.title).toBe('SEV2 · Pod is crash looping. · SRE Platform'));
    view.unmount();
  });

  test('preserves the waiting receipt for a Slack-bound incident', async () => {
    wsState = {
      ...wsState,
      status: 'open',
      messages: [
        msg({
          id: 'slack-reply',
          author: 'human',
          originSurface: 'dashboard',
          content: 'Share this reply with the incident thread',
        }),
      ],
      postState: {
        clientMessageId: 'client-slack-reply',
        messageId: 'slack-reply',
        state: 'saved',
      },
    };
    globalThis.fetch = vi.fn(async () => response(detail()));

    const { unmount } = renderIncident();

    expect(
      await screen.findByText('Saved to the incident. Waiting for Slack acceptance.'),
    ).toBeDefined();
    unmount();
  });

  test('retryable server refusals keep the conversation available', async () => {
    wsState = {
      ...wsState,
      status: 'open',
      error: 'too many messages; retry shortly',
      errorCode: 'rate_limited',
    };
    globalThis.fetch = vi.fn(async () => response(detail({ status: 'closed' })));
    const retryable = renderIncident();
    expect(await screen.findByText('checkout')).toBeDefined();
    expect((screen.getByLabelText('Ask the SRE') as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Ask the SRE'), {
      target: { value: 'Retry the check' },
    });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    retryable.unmount();
  });

  test('submits a reasoned, version-fenced manual lifecycle transition', async () => {
    wsState = { ...wsState, status: 'open', send: vi.fn(() => true) };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return response({
          transition: { outcome: 'applied', from: 'open', to: 'mitigated', version: 1 },
        });
      }
      return response(
        detail({ status: 'open', investigationStatus: 'gathering', lifecycleVersion: 0 }),
      );
    });
    globalThis.fetch = fetchMock;

    const view = renderIncident();
    expect(await screen.findByText('checkout')).toBeDefined();
    const mitigate = screen.getByRole('button', { name: 'Mark mitigated' });
    expect((mitigate as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Lifecycle change reason'), {
      target: { value: 'Traffic shifted to the healthy region.' },
    });
    expect((mitigate as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(mitigate);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/incidents\/[^/]+\/lifecycle$/),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({
      to: 'mitigated',
      reason: 'Traffic shifted to the healthy region.',
      expectedVersion: 0,
    });
    view.unmount();
  });

  test('does not expose a platform acknowledgement or takeover action', async () => {
    wsState = { ...wsState, status: 'open', send: vi.fn(() => true) };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('no lifecycle action should be submitted');
      return response(detail({ status: 'open', lifecycleVersion: 0 }));
    });
    globalThis.fetch = fetchMock;

    const view = renderIncident();
    expect(await screen.findByText('checkout')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Mark mitigated' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    view.unmount();
  });

  test('refreshes and explains a stale manual lifecycle transition', async () => {
    wsState = { ...wsState, status: 'open', send: vi.fn(() => true) };
    let getCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ error: 'stale' }, 409);
      getCount += 1;
      return response(
        detail({
          status: getCount > 1 ? 'mitigated' : 'open',
          lifecycleVersion: getCount > 1 ? 1 : 0,
        }),
      );
    });
    globalThis.fetch = fetchMock;

    const view = renderIncident();
    expect(await screen.findByText('checkout')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Lifecycle change reason'), {
      target: { value: 'Traffic shifted to the healthy region.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark mitigated' }));

    expect(
      await screen.findByText('Incident state changed. Review it and try again.'),
    ).toBeDefined();
    await waitFor(() => expect(getCount).toBeGreaterThanOrEqual(2));
    view.unmount();
  });

  test('a route-id change resets the live child draft before connecting to the next incident', async () => {
    wsState = { ...wsState, status: 'open', send: vi.fn(() => true) };
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const parts = String(input).split('/');
      const id = parts[parts.indexOf('incidents') + 1]!;
      return response(detail({ id, service: id.startsWith('2222') ? 'billing' : 'checkout' }));
    });
    const { unmount } = render(
      <MemoryRouter initialEntries={[`/incidents/${detail().id}`]}>
        <NavigableIncident />
      </MemoryRouter>,
    );
    expect(await screen.findByText('checkout')).toBeDefined();
    const input = screen.getByLabelText('Ask the SRE') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'This belongs only to checkout' } });

    fireEvent.click(screen.getByRole('button', { name: 'Next incident' }));

    expect(await screen.findByText('billing')).toBeDefined();
    expect((screen.getByLabelText('Ask the SRE') as HTMLInputElement).value).toBe('');
    expect(useWsStream).toHaveBeenLastCalledWith(
      '22222222-2222-4222-8222-222222222222',
      expect.any(Object),
    );
    unmount();
  });

  test('uses compact wrapping seams for long detail identity and composer content', async () => {
    wsState = { ...wsState, status: 'open' };
    globalThis.fetch = vi.fn(async () =>
      response(detail({ service: 'checkout-edge-router-with-a-very-long-identity' })),
    );
    const { container, unmount } = renderIncident();
    expect(await screen.findByText('checkout-edge-router-with-a-very-long-identity')).toBeDefined();

    expect(container.querySelector('section')?.className).toMatch(/min-w-0|overflow-x-hidden/);
    expect(screen.getByLabelText('Ask the SRE').className).toMatch(/min-w-0/);
    expect(screen.getByLabelText('Ask the SRE').parentElement?.className).toMatch(/flex-wrap|grid/);
    unmount();
  });

  test('keeps tags below incident identity and sends only intentional nonempty messages', async () => {
    wsState = { ...wsState, status: 'open', send: vi.fn(() => true) };
    globalThis.fetch = vi.fn(async () => response(detail()));
    const { unmount } = renderIncident();
    const title = await screen.findByRole('heading', { level: 1 });
    const tags = screen.getByRole('region', { name: 'Incident tags' });
    expect(title.compareDocumentPosition(tags) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByLabelText('Add tag')).toBeNull();
    expect(screen.getByText('Jump to')).toBeDefined();
    const input = screen.getByLabelText('Ask the SRE');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Check the latest metrics' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(wsState.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(wsState.send).toHaveBeenCalledWith('Check the latest metrics');
    expect((input as HTMLTextAreaElement).value).toBe('');
    unmount();
  });
});
