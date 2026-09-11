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
  test('joins a closed historical incident into the related active incident', async () => {
    const currentIncident = detail({ status: 'closed', investigationStatus: 'assessed' });
    const activeIncidentId = '22222222-2222-4222-8222-222222222222';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ relation: { type: 'merged_into' } });
      return response({
        incident: currentIncident,
        viewerUserId: '11111111-1111-4111-8111-111111111111',
        progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
        signals: [],
        relations: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            sourceIncidentId: currentIncident.id,
            targetIncidentId: activeIncidentId,
            type: 'recurrence_of',
            rationale: 'Alertmanager reported a new episode for the same provider fingerprint.',
            evidence: ['provider_fingerprint:abc'],
            decidedBy: 'system',
            decidedByUserId: null,
            createdAt: '2026-08-26T01:00:00.000Z',
            targetIncident: {
              id: activeIncidentId,
              title: 'New checkout latency firing',
              service: 'checkout',
              severity: 'sev2',
              status: 'open',
              investigationStatus: 'assessed',
              createdAt: '2026-08-26T00:59:00.000Z',
            },
          },
        ],
      });
    });
    globalThis.fetch = fetchMock;

    const view = renderIncident();
    const merge = await screen.findByRole('button', {
      name: 'Join this incident into active incident',
    });
    expect(screen.getByRole('button', { name: 'Record different cause' })).toBeDefined();
    fireEvent.change(screen.getByLabelText('Correction reason'), {
      target: { value: 'Both investigations found the same failing deployment.' },
    });
    fireEvent.change(screen.getByLabelText('Evidence, one fact per line'), {
      target: { value: 'deployment:abc123' },
    });
    fireEvent.click(merge);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/incidents/${currentIncident.id}/merge`),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            targetIncidentId: activeIncidentId,
            rationale: 'Both investigations found the same failing deployment.',
            evidence: ['deployment:abc123'],
          }),
        }),
      ),
    );
    view.unmount();
  });

  test('splits a merged incident with the responder evidence and refreshes the workspace', async () => {
    const targetIncidentId = '22222222-2222-4222-8222-222222222222';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ relation: { type: 'split_from' } });
      return response({
        incident: detail({ status: 'closed', investigationStatus: 'assessed' }),
        viewerUserId: '11111111-1111-4111-8111-111111111111',
        progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
        signals: [],
        relations: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            sourceIncidentId: detail().id,
            targetIncidentId,
            type: 'merged_into',
            rationale: 'Initially appeared to share a database failure.',
            evidence: ['trace:initial'],
            decidedBy: 'human',
            decidedByUserId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-08-26T01:00:00.000Z',
          },
        ],
      });
    });
    globalThis.fetch = fetchMock;

    const view = renderIncident();
    const split = await screen.findByRole('button', { name: 'Split back out' });
    expect((split as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Correction reason'), {
      target: { value: 'The new trace proves an independent firing cause.' },
    });
    fireEvent.change(screen.getByLabelText('Evidence, one fact per line'), {
      target: { value: 'trace:source-only\ndeployment:different' },
    });
    const readsBeforeSplit = fetchMock.mock.calls.filter(([, init]) => !init?.method).length;
    fireEvent.click(split);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/incidents/${detail().id}/split`),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            targetIncidentId,
            rationale: 'The new trace proves an independent firing cause.',
            evidence: ['trace:source-only', 'deployment:different'],
          }),
        }),
      ),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => !init?.method).length).toBeGreaterThan(
        readsBeforeSplit,
      ),
    );
    view.unmount();
  });

  test('directs conversation and lifecycle work to the active incident after a merge', async () => {
    const targetIncidentId = '22222222-2222-4222-8222-222222222222';
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail({ status: 'closed', lifecycleVersion: 2 }),
        viewerUserId: '11111111-1111-4111-8111-111111111111',
        progress: { total: 1, successful: 1, failed: 0, lastRecordedAt: null },
        signals: [],
        relations: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            sourceIncidentId: detail().id,
            targetIncidentId,
            type: 'merged_into',
            rationale: 'Both investigations proved the same database failure.',
            evidence: ['trace:shared'],
            decidedBy: 'human',
            decidedByUserId: '11111111-1111-4111-8111-111111111111',
            createdAt: '2026-08-26T01:00:00.000Z',
          },
        ],
      }),
    );

    const view = renderIncident();
    expect(
      await screen.findByText('This alert was joined into another investigation.'),
    ).toBeDefined();
    expect(screen.getByRole('link', { name: 'the active incident' }).getAttribute('href')).toBe(
      `/w/incidents/${targetIncidentId}`,
    );
    expect((screen.getByLabelText('Lifecycle change reason') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByLabelText('Continue in the joined incident') as HTMLTextAreaElement).disabled,
    ).toBe(true);
    view.unmount();
  });

  test('shows incident-scoped model spend, token volume, and an explicit unpriced warning', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail(),
        assessmentState: 'pending',
        viewerUserId: null,
        progress: { total: 2, successful: 2, failed: 0, lastRecordedAt: null },
        signals: [],
        llmUsage: {
          incidentId: detail().id,
          invocations: 3,
          configuredCostUsd: 0.125,
          providerEstimatedCostUsd: 0.12,
          unpriced: 1,
          missingUsage: 0,
          tokens: { input: 1_000, output: 200, cacheRead: 300, cacheWrite: 0 },
        },
      }),
    );

    const { unmount } = renderIncident();
    expect(
      await screen.findByText((_, element) => element?.textContent === '$0.13 configured cost'),
    ).toBeDefined();
    expect(screen.getByTitle('Exact configured value: $0.125')).toBeDefined();
    expect(screen.getByText(/3 invocations · 1.5K tokens/i)).toBeDefined();
    expect(screen.getByText(/1 unpriced/i)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Set model pricing' }).getAttribute('href')).toBe(
      '/w/settings',
    );
    unmount();
  });
});
