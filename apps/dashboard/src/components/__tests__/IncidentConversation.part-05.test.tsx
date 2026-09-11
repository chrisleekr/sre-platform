// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HubMessage } from '../../lib/types';

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

  // back-compat [stays GREEN through Phase B]: a legacy decided reply with NO approvalId still locks
  // the single preceding approval via the option-label fallback. Guards the fallback path.
  test('a decided reply without approvalId still locks the single preceding approval (label fallback)', () => {
    render(
      <ConversationLog
        messages={[
          msg({
            id: 'ap',
            author: 'agent',
            kind: 'approval',
            content: 'Approve remediation?',
            approval: {
              id: 'ap1',
              options: [
                { id: 'restart', label: 'Restart' },
                { id: 'wait', label: 'Wait' },
              ],
            },
          }),
          msg({ id: 'd', author: 'human', kind: 'reply', content: 'decided: Restart' }),
        ]}
      />,
    );
    const restart = screen.getByRole('button', { name: 'Restart' }) as HTMLButtonElement;
    expect(restart.disabled).toBe(true);
    expect(restart.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('button', { name: 'Wait' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('conversation presentation', () => {
  test('renders semantic timestamps without truncating transcript content', () => {
    const content =
      'The checkout database connection pool is exhausted. Restart only after the traffic shift completes.';
    const createdAt = '2026-08-18T01:05:00.000Z';
    const { container } = render(
      <ConversationLog messages={[msg({ id: 'full', content, createdAt })]} />,
    );

    expect(screen.getByText(content)).toBeDefined();
    const time = container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(createdAt);
    expect(time?.textContent).not.toBe('');
  });

  test('marks an approval request and its recorded decision as distinct transcript events', () => {
    render(
      <ConversationLog
        messages={[
          msg({
            id: 'approval',
            kind: 'approval',
            content: 'Restart checkout?',
            approval: {
              id: 'ap258',
              options: [{ id: 'restart', label: 'Restart' }],
            },
          }),
          msg({
            id: 'decision',
            author: 'human',
            kind: 'reply',
            content: 'decided: Restart',
            approvalId: 'ap258',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Restart checkout?').closest('li')?.dataset.messageKind).toBe(
      'approval',
    );
    expect(screen.getByText('decided: Restart').closest('li')?.dataset.messageKind).toBe(
      'decision',
    );
    expect((screen.getByRole('button', { name: 'Restart' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test('wraps long message and approval content instead of requiring horizontal scrolling', () => {
    const content = 'x'.repeat(180);
    const { container } = render(
      <ConversationLog
        messages={[
          msg({
            id: 'long',
            kind: 'approval',
            content,
            approval: {
              id: 'ap-long',
              options: [
                {
                  id: 'restart-with-a-long-id',
                  label: 'Restart checkout after the drain completes',
                },
              ],
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText(content).className).toMatch(/break-words|break-all/);
    expect(container.querySelector('ul')?.className).toMatch(/min-w-0|overflow-x-hidden/);
    expect(container.querySelector('.overflow-x-auto')).toBeNull();
  });
});
