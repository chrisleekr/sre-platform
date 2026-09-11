// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Attachment, HubMessage } from '../../lib/types';

import type { WsRefusalCode } from '../../lib/useWsStream';

import { ConversationLog } from '../IncidentConversation';

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

const imageAttachment = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'att1',
  fileId: 'f1',
  name: 'screenshot.png',
  mimetype: 'image/png',
  permalink: null,
  interpretation: null,
  messageId: 'a',
  ...over,
});

const attachmentDeps = {
  incidentId: 'i1',
  apiBaseUrl: 'http://x',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 't' }),
};

const msg = (over: Partial<HubMessage> = {}): HubMessage => ({
  id: 'm1',
  incidentId: 'i1',
  author: 'agent',
  kind: 'text',
  content: 'looking into it',
  createdAt: 't',
  ...over,
});

describe('ConversationLog', () => {
  // once an approval is decided, its option buttons must be disabled and the chosen option marked,
  // so an operator cannot fire a second decision. The decided state is derived (no schema change) from a
  // `decided: <label>` reply that follows the approval in the transcript — the decide route appends exactly
  // that. RED today: ConversationLog renders every option as a live, clickable, unmarked button regardless
  // of any decided reply.

  // two concurrently pending approvals can share an option label ('Restart'). The decided reply now
  // carries the approvalId of the approval it settled, so correlation is EXACT — not a backward scan for
  // the nearest approval with a matching option label. The reply names the FARTHER approval (ap1, rendered
  // first) so the legacy nearest-label scan would settle the WRONG one (ap2), which is what makes this RED.

  test('keeps delivery state legible in an agent bubble', () => {
    render(
      <ConversationLog
        messages={[
          msg({
            id: 'accepted',
            author: 'agent',
            content: 'Investigation complete',
            slackDelivery: {
              messageId: 'accepted',
              surface: 'slack',
              state: 'accepted',
              operation: 'post',
              remoteMessageId: '1.1',
              reasonCode: null,
              attemptedAt: '2026-08-21T00:00:00Z',
              completedAt: '2026-08-21T00:00:01Z',
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText('Accepted by Slack').className).toContain('text-on-strong-muted');
  });

  test('does not invent a Slack delivery state for a dashboard-only message', () => {
    render(
      <ConversationLog
        messages={[
          msg({
            id: 'local-only',
            author: 'human',
            originSurface: 'dashboard',
            content: 'Investigate this platform observation',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Investigate this platform observation')).toBeDefined();
    expect(screen.queryByText(/Slack/)).toBeNull();
  });

  test('shows binding-scoped Slack delivery failures instead of collapsing linked threads', () => {
    const receipt = (bindingId: string, state: 'accepted' | 'blocked') => ({
      messageId: 'relationship',
      bindingId,
      surface: 'slack',
      state,
      operation: 'post' as const,
      remoteMessageId: state === 'accepted' ? '1.1' : null,
      reasonCode: state === 'blocked' ? 'missing_binding' : null,
      attemptedAt: '2026-08-21T00:00:00Z',
      completedAt: '2026-08-21T00:00:01Z',
    });
    render(
      <ConversationLog
        messages={[
          msg({
            id: 'relationship',
            author: 'system',
            kind: 'relationship',
            content: 'A related alert was joined.',
            slackDeliveries: [receipt('primary', 'accepted'), receipt('source', 'blocked')],
          }),
        ]}
      />,
    );

    expect(screen.getByText('1 of 2 Slack thread deliveries need attention')).toBeDefined();
  });

  test('shows message provenance and preserves multiline alert context', () => {
    render(
      <ConversationLog
        messages={[
          msg({
            author: 'system',
            originSurface: 'slack',
            content: 'System saturated.\nSeverity: warning',
          }),
        ]}
      />,
    );

    expect(screen.getByText('System')).toBeDefined();
    expect(screen.getByText('via slack')).toBeDefined();
    expect(screen.getByText(/System saturated/).className).toContain('whitespace-pre-wrap');
  });

  test('renders status, reply, and silent kinds and full content over summary', () => {
    render(
      <ConversationLog
        messages={[
          msg({ id: 'a', kind: 'status', content: 'Reading logs' }),
          msg({ id: 'b', kind: 'reply', content: 'restarting the pool' }),
          msg({ id: 'c', kind: 'silent', content: '' }),
          msg({ id: 'd', kind: 'finding', content: 'full detail here', summary: 'short' }),
        ]}
      />,
    );
    expect(screen.getByText(/Reading logs/)).toBeDefined();
    expect(screen.getByText(/restarting the pool/)).toBeDefined();
    expect(screen.getByText(/Considered — nothing to add/)).toBeDefined();
    expect(screen.getByText(/full detail here/)).toBeDefined();
  });

  // Attachments render beneath their message — in both the bubble and centered branches.
  test('renders an attachment beneath its message (bubble and centered)', () => {
    const { rerender } = render(
      <ConversationLog
        messages={[msg({ id: 'a', author: 'agent', content: 'see attached' })]}
        attachments={[imageAttachment({ messageId: 'a' })]}
        attachmentDeps={attachmentDeps}
      />,
    );
    const bubbleRow = screen.getByText(/see attached/).closest('[data-align]');
    expect(bubbleRow?.getAttribute('data-align')).toBe('right');
    expect(bubbleRow?.querySelector('[data-testid="attachment-img-f1"]')).not.toBeNull();

    // Same wiring on the centered (system) branch.
    rerender(
      <ConversationLog
        messages={[msg({ id: 'a', author: 'system', kind: 'status', content: 'diagnostics' })]}
        attachments={[imageAttachment({ messageId: 'a' })]}
        attachmentDeps={attachmentDeps}
      />,
    );
    const centerRow = screen.getByText(/diagnostics/).closest('[data-align]');
    expect(centerRow?.getAttribute('data-align')).toBe('center');
    expect(centerRow?.querySelector('[data-testid="attachment-img-f1"]')).not.toBeNull();
  });

  test('keeps attachment metadata and actions legible in an agent bubble', () => {
    render(
      <ConversationLog
        messages={[msg({ id: 'a', author: 'agent', content: 'see trace' })]}
        attachments={[
          imageAttachment({
            messageId: 'a',
            mimetype: 'text/plain',
            name: 'trace.log',
            interpretation: 'The request timed out.',
          }),
        ]}
        attachmentDeps={attachmentDeps}
      />,
    );

    expect(screen.getByText(/trace\.log/).className).toContain('text-on-strong-muted');
    expect(screen.getByText('The request timed out.').className).toContain('text-on-strong-muted');
    expect(screen.getByRole('button', { name: 'Download' }).className).toContain(
      'text-on-strong-link',
    );
  });

  // Inbound/human messages sit on the left.
  test('aligns a human message to the left', () => {
    render(
      <ConversationLog
        messages={[msg({ id: 'h', author: 'human', content: 'the api is down' })]}
      />,
    );
    const row = screen.getByText(/the api is down/).closest('[data-align]');
    expect(row?.getAttribute('data-align')).toBe('left');
  });

  // Agent/platform messages sit on the right.
  test('aligns an agent message to the right', () => {
    render(
      <ConversationLog
        messages={[msg({ id: 'a', author: 'agent', content: 'looking into it' })]}
      />,
    );
    const row = screen.getByText(/looking into it/).closest('[data-align]');
    expect(row?.getAttribute('data-align')).toBe('right');
  });

  // System messages are centered and distinct from left/right.
  test('centers a system message, distinct from human and agent', () => {
    render(
      <ConversationLog
        messages={[
          msg({ id: 'h', author: 'human', content: 'the api is down' }),
          msg({ id: 's', author: 'system', content: 'incident opened' }),
          msg({ id: 'a', author: 'agent', content: 'looking into it' }),
        ]}
      />,
    );
    const systemAlign = screen
      .getByText(/incident opened/)
      .closest('[data-align]')
      ?.getAttribute('data-align');
    expect(systemAlign).toBe('center');
    expect(systemAlign).not.toBe('left');
    expect(systemAlign).not.toBe('right');
  });

  // A message with a non-null summary still renders full content, not the summary.
  test('keeps a concise finding in key events and exposes full content on demand', () => {
    render(
      <ConversationLog
        messages={[
          msg({
            id: 'f',
            kind: 'finding',
            content: '**full detail here**',
            summary: '*short*',
          }),
        ]}
      />,
    );
    expect(screen.getByText(/^short$/).tagName).toBe('EM');
    expect(screen.getByText(/full detail here/).tagName).toBe('STRONG');
    expect(screen.getByText('Full finding and evidence')).toBeDefined();
  });
});
