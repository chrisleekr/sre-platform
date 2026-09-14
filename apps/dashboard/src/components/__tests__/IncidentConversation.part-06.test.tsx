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
  test.each([
    [403, 'Platform-operator access is required to correct provider state.'],
    [409, 'Signal state changed. Review the latest provider record and try again.'],
  ])('explains a %s signal-correction refusal and refreshes conflicts', async (status, message) => {
    const workspace = {
      incident: detail({ status: 'resolved', investigationStatus: 'assessed' }),
      viewerUserId: '11111111-1111-4111-8111-111111111111',
      progress: { total: 1, successful: 1, failed: 0, lastRecordedAt: null },
      signals: [
        {
          id: 'signal-active',
          surface: 'slack',
          channel: 'C07EWAS8132',
          state: 'firing',
          summary: 'checkout.example.com is down',
          lastEventType: 'opened',
          version: 1,
          lastSeenAt: '2026-08-21T00:00:00Z',
        },
      ],
    };
    let postAttempts = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postAttempts += 1;
        return status === 409 && postAttempts > 1
          ? response({ correction: { outcome: 'applied', signalId: 'signal-active', version: 3 } })
          : response({ error: status === 403 ? 'forbidden' : 'stale' }, status);
      }
      return response(
        status === 409 && postAttempts > 0
          ? {
              ...workspace,
              signals: [{ ...workspace.signals[0], version: 2 }],
            }
          : workspace,
      );
    });
    globalThis.fetch = fetchMock;

    const view = renderIncident();
    await screen.findByText('Incident resolved');
    fireEvent.click(screen.getByRole('button', { name: 'Review signal state' }));
    fireEvent.change(screen.getByLabelText('Correction reason'), {
      target: { value: 'Verified against the provider.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark selected signal cleared' }));

    expect(await screen.findByText(message)).toBeDefined();
    if (status === 409) {
      await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2),
      );
      expect(
        await screen.findByText(
          'This provider record changed. Select the current record before correcting it.',
        ),
      ).toBeDefined();
      expect(
        (screen.getByRole('button', { name: 'Mark selected signal cleared' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      fireEvent.change(screen.getByLabelText('Provider record'), {
        target: { value: 'signal-active' },
      });
      expect(
        screen.queryByText(
          'This provider record changed. Select the current record before correcting it.',
        ),
      ).toBeNull();
      expect(
        (screen.getByRole('button', { name: 'Mark selected signal cleared' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Mark selected signal cleared' }));
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('/signals/signal-active/correct'),
          expect.objectContaining({ body: expect.stringContaining('"expectedVersion":2') }),
        ),
      );
    }
    view.unmount();
  });

  test('keeps the triage preview and conversation together with context in a disclosure', async () => {
    globalThis.fetch = vi.fn(async () => response(detail()));

    renderIncident();

    const responseState = await screen.findByRole('heading', { name: 'Current response state' });
    const conversation = screen.getByRole('heading', { name: 'Incident conversation' });
    const evidence = screen.getByRole('heading', { name: 'Supporting evidence' });

    expect(responseState).toBeDefined();
    expect(
      evidence.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('Supporting context, relationships and signals')).toBeDefined();
    expect(screen.getByRole('button', { name: /All evidence/ })).toBeDefined();
  });

  test('shows captured/current platform provenance, source link, and recurrence without legacy noise', async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        incident: detail(),
        viewerUserId: null,
        progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
        signals: [],
        investigationSubject: {
          kind: 'infrastructure_resource',
          sourceId: '00000000-0000-4000-8000-000000000281',
          subjectId: 'argocd/argocd-server',
          sourcePath: '/infrastructure',
          capturedState: 'firing',
          capturedSummary: 'One OOM-killed container',
          observedAt: '2026-08-28T01:00:00.000Z',
          currentState: 'resolved',
          currentSummary: 'Resource is healthy',
          lastSyncedAt: '2026-08-28T01:05:00.000Z',
        },
        relations: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            sourceIncidentId: detail().id,
            targetIncidentId: '22222222-2222-4222-8222-222222222222',
            type: 'recurrence_of',
            rationale: 'Same platform subject, later episode.',
            evidence: ['platform:subject'],
            decidedBy: 'system',
            decidedByUserId: null,
            createdAt: '2026-08-28T01:00:00.000Z',
          },
        ],
      }),
    );

    const view = renderIncident();

    expect(await screen.findByRole('heading', { name: 'Investigation source' })).toBeDefined();
    expect(screen.getByText('One OOM-killed container')).toBeDefined();
    expect(screen.getByText('Resource is healthy')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open source page' }).getAttribute('href')).toBe(
      '/infrastructure',
    );
    expect(screen.getByRole('button', { name: 'Open previous episode' })).toBeDefined();
    view.unmount();

    globalThis.fetch = vi.fn(async () => response(detail()));
    const legacy = renderIncident();
    expect(await screen.findByText('checkout')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Investigation source' })).toBeNull();
    legacy.unmount();
  });

  test('shows relation evidence and records an evidence-backed unrelated decision', async () => {
    const otherIncidentId = '22222222-2222-4222-8222-222222222222';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ relation: { type: 'unrelated' } });
      return response({
        incident: detail(),
        viewerUserId: '11111111-1111-4111-8111-111111111111',
        progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
        signals: [],
        relations: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            sourceIncidentId: detail().id,
            targetIncidentId: otherIncidentId,
            type: 'possible_related',
            rationale: 'The alerts arrived in the same provider burst window.',
            evidence: ['cohort:44444444-4444-4444-8444-444444444444'],
            decidedBy: 'system',
            decidedByUserId: null,
            createdAt: '2026-08-26T01:00:00.000Z',
            targetIncident: {
              id: otherIncidentId,
              title: 'Database saturation',
              service: 'postgres',
              severity: 'sev2',
              status: 'open',
              investigationStatus: 'assessed',
              rcaSummary: 'Database connections were exhausted after the last deployment.',
              confidence: 82,
              createdAt: '2026-08-26T00:59:00.000Z',
            },
          },
        ],
      });
    });
    globalThis.fetch = fetchMock;

    const view = renderIncident();
    const relationships = await screen.findByRole('heading', {
      name: 'Incident graph',
    });
    expect(relationships.closest('section')?.className).toContain('@container');
    expect(screen.getByLabelText('Correction reason').closest('div')?.className).toContain(
      '@xl:grid-cols-2',
    );
    expect(screen.getByRole('link', { name: 'Database saturation' })).toBeDefined();
    expect(screen.getByText(/postgres · sev2 · open · assessed/)).toBeDefined();
    expect(
      screen
        .getByText(/Database connections were exhausted after the last deployment\./)
        .closest('p')?.textContent,
    ).toMatch(/Prior recorded assessment, reference only:.*82% confidence/);
    expect(screen.getByText('cohort:44444444-4444-4444-8444-444444444444')).toBeDefined();
    const unrelated = screen.getByRole('button', { name: 'Mark unrelated' });
    expect((unrelated as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Correction reason'), {
      target: { value: 'Different services and independent failure windows.' },
    });
    fireEvent.change(screen.getByLabelText('Evidence, one fact per line'), {
      target: { value: 'trace:checkout-only\ndeployment:none' },
    });
    fireEvent.click(unrelated);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/incidents/${detail().id}/unrelated`),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            targetIncidentId: otherIncidentId,
            rationale: 'Different services and independent failure windows.',
            evidence: ['trace:checkout-only', 'deployment:none'],
          }),
        }),
      ),
    );
    view.unmount();
  });
});
