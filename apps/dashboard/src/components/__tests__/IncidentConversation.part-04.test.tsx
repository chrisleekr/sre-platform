// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';

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
  const decidedTranscript = (): HubMessage[] => [
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
    // The decide route appends this reply once a choice is recorded (origin_surface='dashboard').
    msg({ id: 'd', author: 'human', kind: 'reply', content: 'decided: Restart' }),
  ];

  // two concurrently pending approvals can share an option label ('Restart'). The decided reply now
  // carries the approvalId of the approval it settled, so correlation is EXACT — not a backward scan for
  // the nearest approval with a matching option label. The reply names the FARTHER approval (ap1, rendered
  // first) so the legacy nearest-label scan would settle the WRONG one (ap2), which is what makes this RED.
  const twoApprovalsSharedLabel = (): HubMessage[] => [
    msg({
      id: 'ap1',
      author: 'agent',
      kind: 'approval',
      content: 'Approve remediation A?',
      approval: {
        id: 'ap1',
        options: [
          { id: 'r1', label: 'Restart' },
          { id: 'w1', label: 'Wait' },
        ],
      },
    }),
    msg({
      id: 'ap2',
      author: 'agent',
      kind: 'approval',
      content: 'Approve remediation B?',
      approval: {
        id: 'ap2',
        options: [
          { id: 'r2', label: 'Restart' },
          { id: 'w2', label: 'Wait' },
        ],
      },
    }),
    // Settles ap1 specifically via approvalId, even though ap2 is the nearest approval with a 'Restart'
    // option. `approvalId` is not on the HubMessage type until Phase B; the cast keeps the runtime prop.
    {
      ...msg({ id: 'd', author: 'human', kind: 'reply', content: 'decided: Restart' }),
      approvalId: 'ap1',
    } as HubMessage,
  ];

  // Alignment is not the only cue — each row still shows the author label.
  test('shows the author label on each row', () => {
    render(
      <ConversationLog
        messages={[
          msg({ id: 'h', author: 'human', content: 'the api is down' }),
          msg({ id: 'a', author: 'agent', content: 'looking into it' }),
        ]}
      />,
    );
    expect(screen.getByText('Dashboard responder')).toBeDefined();
    expect(screen.getByText('SRE Platform')).toBeDefined();
  });

  // A kind='approval' agent message renders one button per approval.option, inside the
  // agent/right (data-align='right') bubble. Approval carries the options via the msg partial
  // (types.ts gains `approval?` in Phase B).
  test('renders approval options as buttons in the agent (right) bubble', () => {
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
        ]}
      />,
    );
    const restart = screen.getByRole('button', { name: 'Restart' });
    expect(restart).toBeDefined();
    expect(screen.getByRole('button', { name: 'Wait' })).toBeDefined();
    expect(screen.getByText(/Approval records your decision/).className).toContain(
      'text-on-strong-muted',
    );
    // Options live in the agent (right) lane, not the left/center branch.
    expect(restart.closest('[data-align]')?.getAttribute('data-align')).toBe('right');
  });

  // Clicking an option invokes the decide callback with the message's approval id + the
  // clicked option id. `onDecide` is the seam the container wires to an authed POST in Phase B.
  test('clicking an option calls onDecide with the approval id and option id', () => {
    const onDecide = vi.fn();
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
        ]}
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith('ap1', 'restart');
  });

  // Guard: a non-approval message renders no option buttons.
  test('a non-approval message renders no option buttons', () => {
    render(
      <ConversationLog
        messages={[msg({ id: 'a', author: 'agent', kind: 'reply', content: 'looking into it' })]}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  // B7: a decided reply disables every option button for that approval.
  test('a decided approval disables all its option buttons', () => {
    render(<ConversationLog messages={decidedTranscript()} />);
    expect((screen.getByRole('button', { name: 'Restart' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Wait' }) as HTMLButtonElement).disabled).toBe(true);
  });

  // B8: the chosen option (label matches the decided reply) is visibly indicated via aria-pressed.
  test('a decided approval marks the chosen option (aria-pressed) and not the others', () => {
    render(<ConversationLog messages={decidedTranscript()} />);
    expect(screen.getByRole('button', { name: 'Restart' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Wait' }).getAttribute('aria-pressed')).not.toBe(
      'true',
    );
  });

  // B9: a disabled (decided) option does not invoke the decide callback when clicked.
  test('clicking a decided (disabled) option does not call onDecide', () => {
    const onDecide = vi.fn();
    render(<ConversationLog messages={decidedTranscript()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(onDecide).not.toHaveBeenCalled();
  });

  // [RED]: correlation is by approvalId, so ONLY ap1 (the approval the reply names) locks — even
  // though ap2 is the nearer approval sharing the 'Restart' label. RED today: the nearest-label scan in
  // decidedApprovals settles ap2 instead, so ap1 stays live and ap2 wrongly locks.
  test('a decided reply with approvalId locks exactly that approval, not the nearest label match', () => {
    render(<ConversationLog messages={twoApprovalsSharedLabel()} />);
    const ap1Row = screen.getByText('Approve remediation A?').closest('li') as HTMLElement;
    const ap2Row = screen.getByText('Approve remediation B?').closest('li') as HTMLElement;

    // ap1 is the named approval: its options lock and its own 'Restart' (r1) is marked chosen.
    const ap1Restart = within(ap1Row).getByRole('button', { name: 'Restart' }) as HTMLButtonElement;
    expect(ap1Restart.disabled).toBe(true);
    expect(ap1Restart.getAttribute('aria-pressed')).toBe('true');
    expect(
      (within(ap1Row).getByRole('button', { name: 'Wait' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // ap2 shares the 'Restart' label but was NOT named: its buttons stay live and unmarked.
    const ap2Restart = within(ap2Row).getByRole('button', { name: 'Restart' }) as HTMLButtonElement;
    expect(ap2Restart.disabled).toBe(false);
    expect(ap2Restart.getAttribute('aria-pressed')).not.toBe('true');
  });

  // skip branch: a decided reply that carries an approvalId (a -era reply) but names an approval
  // NOT in the rendered window must lock NOTHING — it must NOT fall back to the nearest-label scan, which
  // would re-introduce the mis-attribution fixes. Every rendered approval button stays live.
  test('a decided reply whose approvalId matches no rendered approval locks nothing (skip)', () => {
    const messages: HubMessage[] = [
      msg({
        id: 'ap1',
        author: 'agent',
        kind: 'approval',
        content: 'Approve remediation A?',
        approval: {
          id: 'ap1',
          options: [
            { id: 'r1', label: 'Restart' },
            { id: 'w1', label: 'Wait' },
          ],
        },
      }),
      msg({
        id: 'ap2',
        author: 'agent',
        kind: 'approval',
        content: 'Approve remediation B?',
        approval: {
          id: 'ap2',
          options: [
            { id: 'r2', label: 'Restart' },
            { id: 'w2', label: 'Wait' },
          ],
        },
      }),
      // Names an approval not in this window (e.g. paged out); the label still collides with both.
      {
        ...msg({ id: 'd', author: 'human', kind: 'reply', content: 'decided: Restart' }),
        approvalId: 'ghost',
      } as HubMessage,
    ];
    render(<ConversationLog messages={messages} />);
    for (const b of screen.getAllByRole('button')) {
      expect((b as HTMLButtonElement).disabled).toBe(false);
      expect(b.getAttribute('aria-pressed')).not.toBe('true');
    }
  });

  // skip branch (variant): approvalId names a rendered approval, but the decided label matches no
  // option within it (e.g. option renamed). Locks nothing — no fallback to the nearest-label scan.
  test('a decided reply whose label matches no option in the named approval locks nothing (skip)', () => {
    const messages: HubMessage[] = [
      msg({
        id: 'ap1',
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
      {
        ...msg({ id: 'd', author: 'human', kind: 'reply', content: 'decided: Rollback' }),
        approvalId: 'ap1',
      } as HubMessage,
    ];
    render(<ConversationLog messages={messages} />);
    for (const b of screen.getAllByRole('button')) {
      expect((b as HTMLButtonElement).disabled).toBe(false);
      expect(b.getAttribute('aria-pressed')).not.toBe('true');
    }
  });
});
