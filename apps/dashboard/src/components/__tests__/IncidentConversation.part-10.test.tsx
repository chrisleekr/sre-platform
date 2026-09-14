// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HubMessage } from '../../lib/types';

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
  test('keeps long legacy assessments concise and comparison responsive without losing detail', async () => {
    const supportId = '11111111-1111-4111-8111-111111111111';
    const contradictId = '22222222-2222-4222-8222-222222222222';
    const longRca =
      `Full legacy assessment ${'with complete diagnostic context '.repeat(40)}`.trim();
    const longLeading =
      `Legacy database pressure ${'explains the observed saturation '.repeat(30)}`.trim();
    const longAlternative =
      `A deployment regression ${'remains plausible but unconfirmed '.repeat(30)}`.trim();
    const longState = `Degraded ${'with a very long operational qualifier '.repeat(20)}`.trim();
    const longImpact = `Checkout impact ${'across a large customer cohort '.repeat(30)}`.trim();
    const longNextStep =
      `Compare current telemetry ${'before making a lifecycle decision '.repeat(40)}`.trim();
    const longUnknowns = Array.from({ length: 5 }, (_, index) =>
      `Unknown ${index + 1} ${'with detailed diagnostic context '.repeat(20)}`.trim(),
    );
    const loadDetail = vi.fn();
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
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
          rcaSummary: longRca,
          confidence: 74,
          currentState: longState,
          impact: longImpact,
          nextStep: longNextStep,
          unknowns: longUnknowns,
          assessmentEvidenceIds: [supportId],
          rankedHypotheses: [
            {
              hypothesis: longLeading,
              confidence: 74,
              evidence: `Complete supporting explanation ${'from legacy evidence '.repeat(25)}`,
              state: 'leading',
              supportingEvidenceIds: [supportId],
              contradictingEvidenceIds: [contradictId],
            },
            {
              hypothesis: longAlternative,
              confidence: 38,
              evidence: `Complete alternative explanation ${'from legacy evidence '.repeat(25)}`,
              state: 'plausible',
              supportingEvidenceIds: [contradictId],
              contradictingEvidenceIds: [],
            },
          ],
        } as never),
        viewerUserId: null,
        progress: { total: 2, successful: 2, failed: 0, lastRecordedAt: null },
        signals: [],
      }),
    );

    const { unmount } = renderIncident();
    const brief = (await screen.findByText('Responder brief')).closest('section')!;
    await waitFor(() => expect(loadDetail).toHaveBeenCalledWith(supportId));
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect([...(within(brief).getByRole('heading', { level: 2 }).textContent ?? '')]).toHaveLength(
      120,
    );
    expect(within(brief).getByText('Full operational state').closest('details')?.open).toBe(false);
    const impact = within(brief).getByText('Impact').nextElementSibling!;
    expect([...(impact.textContent ?? '')]).toHaveLength(240);
    expect(within(brief).getByText('Full impact').closest('details')?.open).toBe(false);
    const nextStep = within(brief).getByText('Next diagnostic step').nextElementSibling!;
    expect([...(nextStep.textContent ?? '')]).toHaveLength(240);
    expect(within(brief).getByText('Full next step').closest('details')?.open).toBe(false);
    expect(within(brief).getByText('Evidence gaps')).toBeDefined();
    expect(within(brief).getAllByText('Partial evidence')).toHaveLength(5);
    const takeaway = within(brief).getByText('Leading hypothesis').nextElementSibling!;
    expect(takeaway.textContent).toContain('Legacy database pressure');
    expect([...(takeaway.textContent ?? '')]).toHaveLength(240);
    expect(takeaway.textContent?.endsWith('…')).toBe(true);

    const fullAssessment = within(brief).getByText('Full assessment').closest('details')!;
    expect(fullAssessment.hasAttribute('open')).toBe(false);
    expect(within(fullAssessment).getByText(longRca)).toBeDefined();
    fireEvent.click(within(fullAssessment).getByText('Full assessment'));
    expect(fullAssessment.hasAttribute('open')).toBe(true);

    const comparison = within(brief).getByText('Compare 2 hypotheses').closest('details')!;
    expect(comparison.hasAttribute('open')).toBe(false);
    expect(within(comparison).getAllByText(longLeading)).toHaveLength(2);
    expect(within(comparison).getAllByText(longAlternative)).toHaveLength(2);
    const cards = comparison.querySelector('[data-hypothesis-layout="cards"]')!;
    const table = comparison.querySelector('[data-hypothesis-layout="table"]')!;
    expect(cards.className).toContain('lg:hidden');
    const hypothesisCards = within(cards as HTMLElement).getAllByRole('article');
    expect(hypothesisCards).toHaveLength(2);
    expect(within(hypothesisCards[0]!).getByText('leading')).toBeDefined();
    expect(within(hypothesisCards[0]!).getByText('74/100')).toBeDefined();
    expect(
      within(hypothesisCards[0]!).getByRole('link', { name: `Open evidence ${supportId}` }),
    ).toBeDefined();
    expect(
      within(hypothesisCards[0]!).getByRole('link', { name: `Open evidence ${contradictId}` }),
    ).toBeDefined();
    expect(within(hypothesisCards[1]!).getByText('plausible')).toBeDefined();
    expect(within(hypothesisCards[1]!).getByText('38/100')).toBeDefined();
    expect(within(hypothesisCards[1]!).getByText('None cited')).toBeDefined();
    expect(table.tagName).toBe('TABLE');
    expect(table.className).toMatch(/table-fixed.*lg:table/);
    expect(comparison.querySelector('[class*="min-w-"]')).toBeNull();
    expect(comparison.querySelector('[class*="overflow-x-auto"]')).toBeNull();
    fireEvent.click(within(comparison).getByText('Compare 2 hypotheses'));
    expect(comparison.hasAttribute('open')).toBe(true);
    const hypothesisRows = within(table as HTMLElement).getAllByRole('row');
    expect(within(hypothesisRows[1]!).getByText('leading')).toBeDefined();
    expect(within(hypothesisRows[1]!).getByText('74/100')).toBeDefined();
    expect(
      within(hypothesisRows[1]!).getByRole('link', { name: `Open evidence ${supportId}` }),
    ).toBeDefined();
    expect(
      within(hypothesisRows[1]!).getByRole('link', { name: `Open evidence ${contradictId}` }),
    ).toBeDefined();
    expect(within(hypothesisRows[2]!).getByText('plausible')).toBeDefined();
    expect(within(hypothesisRows[2]!).getByText('38/100')).toBeDefined();

    expect(
      within(comparison).getAllByRole('link', { name: `Open evidence ${supportId}` }),
    ).toHaveLength(2);
    loadDetail.mockClear();
    fireEvent.click(screen.getAllByRole('link', { name: `Open evidence ${supportId}` })[0]!);
    expect(loadDetail).toHaveBeenCalledWith(supportId);
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(scrollIntoView).not.toHaveBeenCalled();
    unmount();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });
});
