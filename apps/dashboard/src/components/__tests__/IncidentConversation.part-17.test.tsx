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

const INCIDENT_ID = detail().id;

function renderIncident() {
  return render(
    <MemoryRouter initialEntries={[`/incidents/${INCIDENT_ID}`]}>
      <Routes>
        <Route path="/incidents/:id" element={<IncidentConversation />} />
        <Route path="/w/incidents/:id/postmortem" element={<p>Postmortem page stub</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const workspace = {
  incident: detail({ status: 'resolved', investigationStatus: 'assessed' }),
  viewerUserId: null,
  progress: { total: 1, successful: 1, failed: 0, lastRecordedAt: null },
  signals: [],
};

describe('postmortem generation from the incident workspace', () => {
  test('a refused approval is visible in the conversation and can be retried', async () => {
    wsState.messages = [
      {
        id: 'approval-message',
        incidentId: INCIDENT_ID,
        author: 'agent',
        content: 'Choose the next action',
        createdAt: '2026-09-09T00:00:00Z',
        kind: 'approval',
        approval: { id: 'approval-1', options: [{ id: 'inspect', label: 'Inspect again' }] },
      },
    ];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? response({ error: 'approval already decided' }, 409)
        : response(workspace),
    );
    renderIncident();
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect again' }));
    expect((await screen.findByText('approval already decided')).getAttribute('role')).toBe(
      'alert',
    );
  });
  test('offers a Generate postmortem control with the five Ch 15 triggers', async () => {
    globalThis.fetch = vi.fn(async () => response(workspace));
    const view = renderIncident();
    await screen.findByText('Incident resolved');
    expect(screen.getByText('Generate postmortem')).toBeDefined();
    const select = screen.getByLabelText('Postmortem trigger') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      '',
      'user_visible_impact',
      'data_loss',
      'oncall_intervention',
      'slow_resolution',
      'monitoring_failure',
    ]);
    const confirm = screen.getByRole('button', { name: 'Confirm postmortem generation' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole('link', { name: 'Open postmortem' }) as HTMLAnchorElement).getAttribute(
        'href',
      ),
    ).toBe(`/w/incidents/${INCIDENT_ID}/postmortem`);
    view.unmount();
  });

  test('posts the chosen trigger and navigates to the postmortem on 202', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST' ? response({ jobId: 'job-1' }, 202) : response(workspace),
    );
    globalThis.fetch = fetchMock;
    const view = renderIncident();
    await screen.findByText('Incident resolved');
    fireEvent.change(screen.getByLabelText('Postmortem trigger'), {
      target: { value: 'data_loss' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm postmortem generation' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/incidents/${INCIDENT_ID}/postmortem/generate`),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'content-type': 'application/json' }),
          body: JSON.stringify({ trigger: 'data_loss' }),
        }),
      ),
    );
    expect(await screen.findByText('Postmortem page stub')).toBeDefined();
    view.unmount();
  });

  test('explains a refused generation instead of navigating', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? response({ error: 'postmortem already published' }, 409)
        : response(workspace),
    );
    const view = renderIncident();
    await screen.findByText('Incident resolved');
    fireEvent.change(screen.getByLabelText('Postmortem trigger'), {
      target: { value: 'slow_resolution' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm postmortem generation' }));
    expect(await screen.findByText('postmortem already published')).toBeDefined();
    expect(screen.queryByText('Postmortem page stub')).toBeNull();
    view.unmount();
  });

  test('renders the postmortem hub line with a link to the document', async () => {
    wsState.messages = [
      {
        id: 'm-postmortem',
        incidentId: INCIDENT_ID,
        author: 'system',
        kind: 'postmortem',
        content: 'Postmortem draft ready for review.',
        createdAt: '2026-08-18T02:00:00.000Z',
      },
    ];
    globalThis.fetch = vi.fn(async () => response(workspace));
    const view = renderIncident();
    await screen.findByText('Postmortem draft ready for review.');
    const links = screen.getAllByRole('link', { name: 'Open postmortem' });
    // One in the controls, one on the hub line; both point at the same document.
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe(`/w/incidents/${INCIDENT_ID}/postmortem`);
    }
    view.unmount();
  });
});
