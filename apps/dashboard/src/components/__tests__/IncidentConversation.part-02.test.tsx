// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';

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

  test('uses full-width chat lanes with bubbles, avatar-after-name, and a truthful You badge', () => {
    render(
      <ConversationLog
        viewerUserId="11111111-1111-4111-8111-111111111111"
        viewerName="Dev Responder"
        messages={[
          msg({
            id: 'mine',
            author: 'human',
            authorUserId: '11111111-1111-4111-8111-111111111111',
            content: 'I am checking it',
          }),
          msg({
            id: 'other',
            author: 'human',
            authorUserId: '22222222-2222-4222-8222-222222222222',
            originSurface: 'slack',
            content: 'I see the same thing',
          }),
          msg({ id: 'sre', author: 'agent', kind: 'finding', content: 'Pool is saturated' }),
        ]}
      />,
    );

    const name = screen.getByText('Dev Responder');
    expect(name.nextElementSibling?.getAttribute('aria-label')).toBe('Dev Responder avatar');
    expect(screen.getAllByText('You')).toHaveLength(1);
    expect(screen.getByText('Slack responder')).toBeDefined();
    expect(screen.getByLabelText('SRE Platform avatar')).toBeDefined();

    const timeline = screen.getByRole('list', { name: 'Incident timeline' });
    expect(timeline.className).not.toContain('max-w-');

    const humanRow = screen.getByText('I am checking it').closest('li');
    const humanBubble = humanRow?.firstElementChild;
    expect(humanRow?.getAttribute('data-align')).toBe('left');
    expect(humanBubble?.className).toContain('w-full');
    expect(humanBubble?.className).not.toContain('max-w-');
    expect(humanBubble?.className).toContain('rounded-2xl');

    const agentRow = screen.getByText('Pool is saturated').closest('li');
    expect(agentRow?.getAttribute('data-align')).toBe('right');
    expect(agentRow?.firstElementChild?.className).toContain('w-full');
    expect(agentRow?.firstElementChild?.className).toContain('rounded-2xl');
  });

  test('renders responder Markdown safely while preserving system observations as plaintext', () => {
    const { container } = render(
      <ConversationLog
        messages={[
          msg({
            id: 'markdown',
            content:
              '# What happened\n\n**Recovered:** `argocd-server` is ready.[^1]\n\n- Restart count is stable\n\n3. Preserve this step number\n\n| Signal | Value |\n|:---|---:|\n| Restarts | 1 |\n\n```text\nOOMKilled\n```\n\n<script>alert("unsafe")</script>\n\n[unsafe](javascript:alert(1))\n\n[runbook](https://example.com/runbook)\n\n![tracker](https://attacker.example/pixel)\n\n[^1]: Durable evidence.',
          }),
          msg({
            id: 'human-markdown',
            author: 'human',
            content: '**Human Markdown** with a note.[^1]\n\n[^1]: Human evidence.',
          }),
          msg({
            id: 'provider',
            author: 'system',
            content: '**Raw provider observation**',
          }),
        ]}
      />,
    );

    const markdownRow = screen.getByText('What happened').closest('li');
    expect(within(markdownRow as HTMLElement).getByRole('heading', { level: 3 })).toBeDefined();
    expect(markdownRow?.querySelector('strong')?.textContent).toBe('Recovered:');
    expect(markdownRow?.querySelector('code')?.textContent).toBe('argocd-server');
    expect(markdownRow?.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(within(markdownRow as HTMLElement).getByRole('table')).toBeDefined();
    expect(markdownRow?.querySelectorAll('th')[1]?.style.textAlign).toBe('right');
    expect(markdownRow?.querySelector('pre')?.textContent).toContain('OOMKilled');
    expect(markdownRow?.querySelector('script')).toBeNull();
    expect(markdownRow?.textContent).not.toContain('<script>');
    expect(markdownRow?.querySelector('img')).toBeNull();
    expect(
      within(markdownRow as HTMLElement)
        .getByText('unsafe')
        .getAttribute('href'),
    ).toBe('');
    const runbook = within(markdownRow as HTMLElement).getByText('runbook');
    expect(runbook.getAttribute('href')).toBe('https://example.com/runbook');
    expect(runbook.getAttribute('target')).toBe('_blank');
    expect(runbook.getAttribute('rel')).toContain('noopener');
    expect(runbook.getAttribute('rel')).toContain('noreferrer');

    const footnoteReference = markdownRow?.querySelector('a[data-footnote-ref]');
    expect(footnoteReference?.getAttribute('id')).toBe('conversation-markdown-body-fnref-1');
    expect(footnoteReference?.getAttribute('target')).toBeNull();
    const footnoteLabel = markdownRow?.querySelector('#footnote-label');
    expect(footnoteLabel).toBeNull();
    const scopedFootnoteLabel = markdownRow?.querySelector(
      '#conversation-markdown-body-footnote-label',
    );
    expect(scopedFootnoteLabel?.className).toContain('sr-only');
    expect(footnoteReference?.getAttribute('aria-describedby')).toBe(scopedFootnoteLabel?.id);
    const definitionHref = footnoteReference?.getAttribute('href') ?? '';
    expect(markdownRow?.querySelector(definitionHref)).not.toBeNull();
    const backReference = markdownRow?.querySelector('a[data-footnote-backref]');
    expect(backReference?.getAttribute('href')).toBe(`#${footnoteReference?.id}`);
    expect(backReference?.getAttribute('aria-label')).toBe('Back to reference 1');

    const humanMarkdown = screen.getByText('Human Markdown');
    expect(humanMarkdown.tagName).toBe('STRONG');
    const humanRow = humanMarkdown.closest('li');
    const humanFootnoteReference = humanRow?.querySelector('a[data-footnote-ref]');
    expect(humanFootnoteReference?.id).not.toBe(footnoteReference?.id);
    expect(
      humanRow?.querySelector(humanFootnoteReference?.getAttribute('href') ?? ''),
    ).not.toBeNull();

    const provider = screen.getByText('**Raw provider observation**');
    expect(provider.closest('li')?.querySelector('strong')).toBeNull();
    expect(container.querySelectorAll('table')).toHaveLength(1);
  });

  test('groups consecutive low-level activity by default and exposes every row in full audit', () => {
    const messages = [
      msg({ id: 'one', kind: 'text', content: 'Planning log checks' }),
      msg({ id: 'two', kind: 'tool_step', content: 'get_logs {"service":"checkout"}' }),
    ];
    const view = render(<ConversationLog messages={messages} />);
    expect(screen.getByText('Investigation activity')).toBeDefined();
    expect(screen.queryByLabelText('SRE Platform avatar')).toBeNull();

    view.rerender(<ConversationLog messages={messages} fullAudit />);
    expect(screen.getAllByLabelText('SRE Platform avatar')).toHaveLength(2);
  });

  test('keeps key events decision-focused while full audit preserves signal and assessment history', () => {
    const messages = [
      msg({ id: 'signal', author: 'system', kind: 'signal', content: 'FIRING notification' }),
      msg({
        id: 'old-assessment',
        kind: 'finding',
        content: 'Old assessment',
        originMessageId: 'triage-assessment:job-1',
      }),
      msg({
        id: 'recovery',
        kind: 'finding',
        content: 'Recovery not verified',
        originMessageId: 'recovery:job-2',
      }),
      msg({
        id: 'latest-assessment',
        kind: 'finding',
        content: 'Latest assessment',
      }),
    ];
    const view = render(
      <ConversationLog
        messages={messages}
        representedFindings={['Recovery not verified', 'Latest assessment']}
      />,
    );

    expect(screen.getByText(/hides 1 provider notification/)).toBeDefined();
    expect(screen.getByText(/2 automated conclusions/)).toBeDefined();
    expect(screen.queryByText('FIRING notification')).toBeNull();
    expect(screen.getByText('Old assessment')).toBeDefined();
    expect(screen.queryByText('Recovery not verified')).toBeNull();
    expect(screen.queryByText('Latest assessment')).toBeNull();

    view.rerender(<ConversationLog messages={messages} fullAudit />);
    expect(screen.getByText('FIRING notification')).toBeDefined();
    expect(screen.getByText('Old assessment')).toBeDefined();
    expect(screen.getByText('Recovery not verified')).toBeDefined();
    expect(screen.getByText('Latest assessment')).toBeDefined();
  });

  test('labels Slack API acceptance without claiming delivery or read', () => {
    render(
      <ConversationLog
        messages={[
          msg({
            id: 'accepted',
            author: 'human',
            originSurface: 'dashboard',
            content: 'Check database saturation',
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
    expect(screen.getByText('Accepted by Slack')).toBeDefined();
    expect(screen.queryByText(/delivered|read/i)).toBeNull();
  });
});
