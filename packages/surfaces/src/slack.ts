// Slack outbound adapter: mirror hub messages to a channel via chat.postMessage,
// and edit/delete the mutable "working post" via chat.update / chat.delete. Slack threads on thread_ts,
// so every mirrored message replies with thread_ts = the binding's thread id, in the binding's channel.
// Managed Socket Mode inbound lands in apps/api. The fetch client here is injected for outbound tests.
import { SLACK_API } from './slack-http';
import type { FetchLike, OutboundMessage, SurfacePoster, SurfaceTarget } from './types';

export { slackChatGetPermalink, slackUsersInfoEmail } from './slack-identity';

const SLACK_TEXT_MAX = 39000; // Slack caps message text near 40k chars; truncate so long briefs still send.
const SLACK_SECTION_TEXT_MAX = 3000;
const SLACK_TAKEAWAY_MAX = 360;
const SLACK_REQUEST_TIMEOUT_MS = 10_000;

export const SLACK_LIFECYCLE_ACTION_PREFIX = 'incident_lifecycle:';

function truncateTakeaway(text: string): string {
  if (text.length <= SLACK_TAKEAWAY_MAX) return text;
  // Zero-width split at every sentence boundary. The previous `[^.!?]+[.!?](?:\s|$)` scan
  // backtracked quadratically over long punctuation-free model output.
  const sentences = text.split(/(?<=[.!?])(?=\s)/);
  let takeaway = '';
  for (const sentence of sentences) {
    if ((takeaway + sentence).trim().length > SLACK_TAKEAWAY_MAX - 40) break;
    takeaway += sentence;
  }
  return takeaway.trim()
    ? `${takeaway.trim()} Full response in the incident.`
    : 'A detailed response is available in the incident. Open it for the full answer and evidence.';
}

type LifecycleStatus = 'open' | 'mitigated' | 'resolved' | 'closed';

const LIFECYCLE_ACTIONS: Record<
  LifecycleStatus,
  Array<{ to: LifecycleStatus; label: string; style?: 'primary' }>
> = {
  open: [],
  mitigated: [
    { to: 'open', label: 'Return to open' },
    { to: 'resolved', label: 'Resolve', style: 'primary' },
  ],
  resolved: [
    { to: 'open', label: 'Reopen' },
    { to: 'closed', label: 'Close' },
  ],
  closed: [{ to: 'open', label: 'Reopen' }],
};

// Slack mrkdwn treats & < > specially; escape them so untrusted text can't inject markup or a fake link.
// & MUST be replaced first, or the < and > passes would re-escape the ampersands this pass just emitted.
// https://docs.slack.dev/messaging/formatting-message-text/#escaping
const escapeSlackText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const deepLink = (url: string, label: string): string => {
  const safeUrl = url
    .replace(/&/g, '&amp;')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/\|/g, '%7C');
  return `<${safeUrl}|${label}>`;
};
const incidentLink = (url: string): string => deepLink(url, 'Open incident');

const isOpeningLifecycle = (msg: OutboundMessage): boolean =>
  msg.kind === 'lifecycle' && msg.lifecycleFrom == null && msg.lifecycleTo === 'open';

/**
 * Render a message for Slack. Prefer the concise `summary` over the full `content`, prefix an
 * author glyph, truncate to the Slack cap, then append the dashboard deep-link when one is supplied
 * (the link is appended AFTER truncation so a long body can't drop it).
 *
 * The body is escaped unless the producer opted out with `preformatted` (see OutboundMessage).
 * chat.postMessage parses `text` as mrkdwn, so an unescaped body lets a dashboard-authored reply or a
 * prompt-injected LLM fire a real `<!channel>` ping or plant a `<url|text>` phishing link in a shared
 * incident channel. Escaping only ever removes raw & < >, so the truncation below cannot reintroduce one:
 * a cut entity degrades to literal text, never to live markup.
 */
function render(msg: OutboundMessage, link?: string | null): string {
  if (isOpeningLifecycle(msg)) {
    return link ? `Incident: ${incidentLink(link)}` : 'Incident opened.';
  }
  const who = msg.author === 'agent' ? '🤖' : msg.author === 'human' ? '👤' : 'ℹ️';
  const takeaway = msg.summary ? truncateTakeaway(msg.summary) : null;
  const findingPrefix = msg.finding
    ? msg.finding.promotion === 'trusted_assessment'
      ? 'Conclusion: '
      : msg.finding.promotionReason === 'investigation_failed' ||
          msg.finding.promotionReason === 'budget_exhausted' ||
          msg.finding.promotionReason === 'missing_capability'
        ? 'Blocked: '
        : 'Update: '
    : '';
  const raw = msg.recovery ? msg.content : `${findingPrefix}${takeaway ?? msg.content}`;
  const body = msg.preformatted ? raw : escapeSlackText(raw);
  // Attribute a human reply synced from the dashboard when a label was resolved: the label is the
  // author's email local-part, never the full address. Falls back to the bare glyph when unresolved.
  const head =
    msg.author === 'human' && msg.authorLabel
      ? `${who} ${escapeSlackText(msg.authorLabel)} (via dashboard): ${body}`
      : `${who} ${body}`;
  const text = head.length > SLACK_TEXT_MAX ? `${head.slice(0, SLACK_TEXT_MAX - 1)}…` : head;
  if (!link) return text;
  // A postmortem line links to the postmortem page; the fan-out supplied that URL, not the incident's.
  return msg.kind === 'postmortem'
    ? `${text}\nPostmortem: ${deepLink(link, 'Open postmortem')}`
    : `${text}\nIncident: ${incidentLink(link)}`;
}

/** Split escaped mrkdwn at Slack's section limit without cutting an escape entity. */
function splitSectionText(text: string): string[] {
  const tokens = text.match(/&(?:amp|lt|gt);|[\s\S]/gu) ?? [];
  const chunks: string[] = [];
  let chunk = '';
  for (const token of tokens) {
    if (chunk.length + token.length > SLACK_SECTION_TEXT_MAX) {
      chunks.push(chunk);
      chunk = token;
    } else {
      chunk += token;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function recoveryBlocks(
  msg: OutboundMessage,
  link?: string | null,
): Record<string, unknown>[] | null {
  const recovery = msg.recovery;
  if (!recovery) return null;
  const outcome = recovery.outcome ?? (recovery.recovered ? 'recovered' : 'needs_human');

  const rawSummary = msg.summary ?? msg.content.split('\n')[1] ?? msg.content;
  const summary = escapeSlackText(truncateTakeaway(rawSummary));
  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text:
          outcome === 'recovered'
            ? '✅ Recovered'
            : outcome === 'recheck'
              ? '🔎 Monitoring recovery'
              : '⚠️ Human review needed',
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
  ];

  if (recovery.checks.length > 0) {
    blocks.push({
      type: 'table',
      column_settings: [{ is_wrapped: true }, { is_wrapped: true }, { is_wrapped: true }],
      rows: [
        ['Check', 'During incident', 'Now'].map((text) => ({ type: 'raw_text', text })),
        ...recovery.checks.map((check) =>
          [check.name, check.before ?? 'Not recorded', check.now].map((text) => ({
            type: 'raw_text',
            text,
          })),
        ),
      ],
    });
  }

  if (recovery.unknowns.length > 0 || recovery.nextStep) {
    const details = [
      ...(recovery.unknowns.length > 0
        ? [
            `*Unknowns*\n${recovery.unknowns.map((item) => `• ${escapeSlackText(item)}`).join('\n')}`,
          ]
        : []),
      ...(recovery.nextStep ? [`*Next*\n${escapeSlackText(recovery.nextStep)}`] : []),
    ];
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: details.join('\n\n') } });
  }

  if (link) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Incident: ${incidentLink(link)}` }],
    });
  }
  return blocks;
}

function interactiveBlocks(
  msg: OutboundMessage,
  text: string,
  link?: string | null,
): Record<string, unknown>[] | null {
  if (isOpeningLifecycle(msg)) return null;
  const recovery = recoveryBlocks(msg, link);
  if (recovery) return recovery;
  const sections = splitSectionText(text).map((section) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: section },
  }));

  if (msg.kind === 'approval' && msg.approval) {
    const approvalId = msg.approval.id;
    return [
      ...sections,
      {
        type: 'actions',
        block_id: approvalId,
        elements: msg.approval.options.map((opt) => ({
          type: 'button',
          action_id: `opt:${opt.id}`,
          text: { type: 'plain_text', text: opt.label },
          value: `${approvalId}:${opt.id}`,
        })),
      },
    ];
  }

  const status = msg.lifecycleTo;
  const version = msg.lifecycleVersion;
  if (
    msg.kind !== 'lifecycle' ||
    !status ||
    !(status in LIFECYCLE_ACTIONS) ||
    version === null ||
    version === undefined
  ) {
    return null;
  }

  const actions = LIFECYCLE_ACTIONS[status as LifecycleStatus];
  if (actions.length === 0) return sections;

  return [
    ...sections,
    {
      type: 'actions',
      // Slack requires a fresh block id whenever chat.update changes the block.
      block_id: `incident-lifecycle:${msg.incidentId}:${version}`,
      elements: actions.map((action) => ({
        type: 'button',
        action_id: `${SLACK_LIFECYCLE_ACTION_PREFIX}${action.to}`,
        text: { type: 'plain_text', text: action.label },
        value: JSON.stringify({
          incidentId: msg.incidentId,
          to: action.to,
          expectedVersion: version,
        }),
        ...(action.style ? { style: action.style } : {}),
      })),
    },
  ];
}

interface SlackResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

/** One Slack Web API write. Ambiguous transport outcomes are never silently retried by callers. */
async function slackApiPost(
  fetchImpl: FetchLike,
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<SlackResult> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SlackApiError('uncertain', 'transport_failure', `slack ${method} request failed`);
  }
  if (res.status === 429)
    throw new SlackApiError(
      'retryable',
      'rate_limited',
      `slack ${method} rate limited`,
      rateLimitDelay(res),
    );
  if (!res.ok)
    throw new SlackApiError('uncertain', 'http_failure', `slack ${method} failed: ${res.status}`);
  try {
    return (await res.json()) as SlackResult;
  } catch {
    throw new SlackApiError(
      'uncertain',
      'invalid_response',
      `slack ${method} returned invalid JSON`,
    );
  }
}

/**
 * Creates a platform-owned Slack alert root and returns its thread timestamp.
 *
 * @param fetchImpl - HTTP implementation used for the Slack request.
 * @param token - Tenant Slack bot token.
 * @param channel - Slack channel that should own the incident thread.
 * @param text - Plain-text incident opener.
 */
export async function slackChatPostAlertRoot(
  fetchImpl: FetchLike,
  token: string,
  channel: string,
  text: string,
): Promise<string> {
  const data = await slackApiPost(fetchImpl, 'chat.postMessage', token, {
    channel,
    text: text.slice(0, SLACK_TEXT_MAX),
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!data.ok)
    throw new SlackApiError(
      'rejected',
      data.error ?? 'unknown',
      `slack chat.postMessage not-ok: ${data.error ?? 'unknown'}`,
    );
  if (!data.ts)
    throw new SlackApiError(
      'uncertain',
      'invalid_response',
      'slack chat.postMessage returned success without a timestamp',
    );
  return data.ts;
}

/** Typed failure so the worker can distinguish a definitive Slack rejection from an ambiguous request. */
export class SlackApiError extends Error {
  constructor(
    readonly certainty: 'rejected' | 'uncertain' | 'retryable',
    readonly code: string,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

/** Slack tolerates these on delete: the message is already gone, so a redelivered delete is a success. */
const DELETE_OK_ERRORS = new Set(['message_not_found', 'already_deleted']);
const DEFAULT_RATE_LIMIT_RETRY_MS = 1_000;
const MAX_RATE_LIMIT_RETRY_MS = 60 * 60 * 1_000;

function rateLimitDelay(response: { headers?: { get(name: string): string | null } }): number {
  const seconds = Number(response.headers?.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RATE_LIMIT_RETRY_MS;
  return Math.min(Math.ceil(seconds * 1_000), MAX_RATE_LIMIT_RETRY_MS);
}

/**
 * Builds the outbound Slack surface adapter.
 *
 * @param fetchImpl - HTTP implementation used for Slack message operations.
 */
export function makeSlackPoster(fetchImpl: FetchLike): SurfacePoster {
  return {
    surface: 'slack',
    async post(
      target: SurfaceTarget,
      threadId: string,
      msg: OutboundMessage,
      link?: string | null,
    ): Promise<string> {
      // threadId IS Slack's root thread_ts, verbatim; the channel that owns it comes from the same
      // binding row via `target`. Every mirrored message replies under the alert's own thread.
      const text = render(msg, link);
      const body: Record<string, unknown> = {
        channel: target.channel,
        thread_ts: threadId,
        text,
      };
      // Keep text as the notification/accessibility fallback while approvals and lifecycle changes get
      // explicit actions. Lifecycle values carry the version rendered to Slack, so a stale message can
      // never overwrite a newer dashboard or verbal transition.
      const blocks = interactiveBlocks(msg, text, link);
      if (blocks) body.blocks = blocks;

      const data = await slackApiPost(fetchImpl, 'chat.postMessage', target.token, body);
      if (!data.ok || !data.ts) {
        throw new SlackApiError(
          'rejected',
          data.error ?? 'unknown',
          `slack chat.postMessage not-ok: ${data.error ?? 'unknown'}`,
        );
      }
      // The posted message's own ts: the caller stores it as the working post so a later
      // update/delete targets this exact message.
      return data.ts;
    },

    async update(
      target: SurfaceTarget,
      messageId: string,
      msg: OutboundMessage,
      link?: string | null,
    ): Promise<void> {
      const text = render(msg, link);
      const body: Record<string, unknown> = {
        channel: target.channel,
        ts: messageId,
        text,
      };
      const blocks = interactiveBlocks(msg, text, link);
      if (blocks) body.blocks = blocks;
      const data = await slackApiPost(fetchImpl, 'chat.update', target.token, body);
      if (!data.ok)
        throw new SlackApiError(
          'rejected',
          data.error ?? 'unknown',
          `slack chat.update not-ok: ${data.error ?? 'unknown'}`,
        );
    },

    async delete(target: SurfaceTarget, messageId: string): Promise<void> {
      const data = await slackApiPost(fetchImpl, 'chat.delete', target.token, {
        channel: target.channel,
        ts: messageId,
      });
      // Already-gone is success: a redelivered delete (or a post the human already removed) is idempotent.
      if (!data.ok && !DELETE_OK_ERRORS.has(data.error ?? '')) {
        throw new SlackApiError(
          'rejected',
          data.error ?? 'unknown',
          `slack chat.delete not-ok: ${data.error ?? 'unknown'}`,
        );
      }
    },
  };
}
