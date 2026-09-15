// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EvidenceDetail, HubMessage } from '../../lib/types';
import { IncidentConversation } from '../IncidentConversation';

const hooks = vi.hoisted(() => ({
  getCredentials: vi.fn(async () => ({ kind: 'bearer' as const, token: 'jwt' })),
  stream: vi.fn(),
  evidence: vi.fn(),
  history: vi.fn(),
}));
vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: hooks.getCredentials, user: { name: 'Responder' } }),
}));
vi.mock('../../lib/useWsStream', () => ({ useWsStream: hooks.stream }));
vi.mock('../../lib/useIncidentEvidence', () => ({ useIncidentEvidence: hooks.evidence }));
vi.mock('../../lib/useIncidentHistory', () => ({ useIncidentHistory: hooks.history }));
vi.mock('../../lib/useAttachments', () => ({ useAttachments: () => ({ attachments: [] }) }));
vi.mock('../../lib/useSlackPermalink', () => ({
  useSlackPermalink: () => ({ permalink: null, loading: false, error: false }),
}));

const incidentId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const originalFetch = globalThis.fetch;
const loadDetail = vi.fn();
const refresh = vi.fn();
const send = vi.fn(() => true);
let status: 'open' | 'closed';
let messages: HubMessage[];

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: incidentId,
    service: 'checkout',
    severity: 'sev2',
    status: 'open',
    investigationStatus: 'gathering',
    lifecycleVersion: 1,
    alertSource: 'datadog',
    title: 'Checkout requests timing out',
    rcaSummary: null,
    confidence: null,
    recoveryState: null,
    pendingAutomation: null,
    latestInvestigationRun: null,
    createdAt: '2026-09-14T00:00:00Z',
    ...overrides,
  };
}

const evidence: EvidenceDetail = {
  id: evidenceId,
  tool: 'prometheus_primary_query_range',
  outcome: 'data',
  latencyMs: 12,
  recordedAt: '2026-09-14T00:01:00Z',
  hasOutput: true,
  input: { query: 'checkout_errors_total' },
  output: { status: 'success' },
  projection: { kind: 'facts', columns: ['result'], rows: [{ result: 'Diagnostic value 42' }] },
  referenceUrl: null,
};

function renderWorkspace(
  incidentOverrides: Record<string, unknown> = {},
  workspaceOverrides: Record<string, unknown> = {},
) {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          incident: incident(incidentOverrides),
          viewerUserId: null,
          progress: { total: 1, successful: 1, failed: 0, lastRecordedAt: evidence.recordedAt },
          signals: [],
          ...workspaceOverrides,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  return render(
    <MemoryRouter initialEntries={[`/incidents/${incidentId}`]}>
      <Routes>
        <Route path="/incidents/:id" element={<IncidentConversation />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  status = 'open';
  messages = [];
  hooks.stream.mockImplementation(() => ({
    messages,
    status,
    error: null,
    errorCode: null,
    connectionError: status === 'closed' ? 'Connection lost. Reconnecting.' : null,
    postState: null,
    send,
    retry: vi.fn(),
  }));
  hooks.history.mockImplementation(() => ({
    messages,
    hasOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    refresh,
  }));
  hooks.evidence.mockReturnValue({
    evidence: [evidence],
    nextCursor: null,
    details: { [evidenceId]: evidence },
    loading: false,
    error: false,
    paginationError: false,
    detailErrors: {},
    loadDetail,
    loadOlder: vi.fn(),
    refresh,
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState(null, '', '/');
});

describe('incident-time triage workspace', () => {
  test('cleared notifications do not invent queued recovery work', async () => {
    renderWorkspace(
      {},
      {
        signals: [
          {
            id: 'signal-1',
            surface: 'slack',
            channel: 'channel',
            externalMessageId: 'message',
            state: 'resolved',
            summary: 'Checkout errors cleared',
            version: 1,
            firstSeenAt: '2026-09-14T00:00:00Z',
            lastSeenAt: '2026-09-14T00:01:00Z',
            resolvedAt: '2026-09-14T00:01:00Z',
          },
        ],
      },
    );
    await screen.findByRole('heading', { name: 'Checkout requests timing out' });
    expect(screen.queryByText('Signals cleared; recovery verification is queued.')).toBeNull();
    expect(screen.getByText(/recovery not verified/i)).toBeDefined();
    expect(screen.getAllByText(/no active automation recorded/i).length).toBeGreaterThan(0);
  });

  test('a missing diagnosis and legacy gathering status do not imply active work', async () => {
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Checkout requests timing out' });
    expect(
      screen.queryByText('No diagnosis yet. Evidence gathering is still in progress.'),
    ).toBeNull();
    expect(screen.queryByText('Investigation in progress')).toBeNull();
    expect(screen.getByText(/no diagnosis established/i)).toBeDefined();
  });

  test('policy metadata without pending work does not claim the platform is handling the incident', async () => {
    renderWorkspace(
      {},
      {
        attention: null,
        automation: {
          nextAction: null,
          currentBudget: null,
          episodeExpiresAt: null,
        },
      },
    );
    await screen.findByRole('heading', { name: 'Checkout requests timing out' });
    expect(screen.queryByText('SRE Platform handling')).toBeNull();
    expect(screen.getAllByText(/no active automation recorded/i).length).toBeGreaterThan(0);
  });

  test('an interrupted connection leaves the draft editable but cannot deliver it', async () => {
    status = 'closed';
    renderWorkspace();
    await screen.findByRole('heading', { name: 'Checkout requests timing out' });
    const composer = screen.getByLabelText('Ask the SRE') as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
    fireEvent.change(composer, { target: { value: 'Compare checkout errors before the rollout' } });
    expect(composer.value).toBe('Compare checkout errors before the rollout');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  test('a citation opens exact evidence explicitly without discarding the draft', async () => {
    renderWorkspace({ assessmentEvidenceIds: [evidenceId] });
    await screen.findByRole('heading', { name: 'Checkout requests timing out' });
    await waitFor(() => expect(loadDetail).toHaveBeenCalledWith(evidenceId));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByLabelText('Ask the SRE'), {
      target: { value: 'Keep this question' },
    });
    fireEvent.click(screen.getAllByRole('link', { name: `Open evidence ${evidenceId}` })[0]!);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Diagnostic value 42')).toBeDefined();
    expect((screen.getByLabelText('Ask the SRE') as HTMLTextAreaElement).value).toBe(
      'Keep this question',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText('Ask the SRE') as HTMLTextAreaElement).value).toBe(
      'Keep this question',
    );
  });

  test('the service team is not presented as a personal incident assignment', async () => {
    renderWorkspace(
      { impact: 'Checkout requests time out', nextStep: 'Compare rollout timing' },
      {
        attention: {
          decision: 'Compare rollout timing',
          owner: 'Payments team',
          nextAutomation: null,
        },
      },
    );
    await screen.findByRole('heading', { name: 'Checkout requests timing out' });
    expect(screen.getByText('Service team')).toBeDefined();
    expect(screen.getByText('Payments team')).toBeDefined();
    expect(screen.queryByText('Responsible owner')).toBeNull();
    expect(screen.getByText('Checkout requests time out')).toBeDefined();
    expect(screen.getByLabelText('Ask the SRE')).toBeDefined();
  });

  test('contradicting evidence is identified without expanding a hypothesis comparison', async () => {
    renderWorkspace({
      impact: 'Checkout requests time out',
      nextStep: 'Compare database pressure with errors',
      rankedHypotheses: [
        {
          hypothesis: 'Database saturation may explain the timeouts',
          state: 'leading',
          confidence: 60,
          supportingEvidenceIds: ['33333333-3333-4333-8333-333333333333'],
          contradictingEvidenceIds: [evidenceId],
        },
      ],
    });
    await screen.findByRole('heading', { name: 'Checkout requests timing out' });
    const exposed = screen
      .queryAllByText(/contradict/i)
      .filter((element) => !element.closest('details:not([open])'));
    expect(exposed.length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('Database saturation may explain the timeouts').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Compare database pressure with errors')).toBeDefined();
    expect(screen.getByLabelText('Ask the SRE')).toBeDefined();
  });
});
