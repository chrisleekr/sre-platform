import type { CredentialGetter } from '../../lib/request-credentials';
import { useMemo } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { postmortemPath } from '../../lib/routes';
import { formatAbsoluteTime } from '../../lib/time';
import { summarizeToolProviders } from '../../lib/toolPresentation';
import type {
  Attachment,
  HubMessage,
  IncidentWorkspaceData,
  SurfaceDelivery,
} from '../../lib/types';
import { ConversationMarkdown } from '../ConversationMarkdown';
import { FindingFeedback } from '../FindingFeedback';
import { MessageAttachments, type AttachmentDeps } from '../MessageAttachments';

/**
 * Full-fidelity dashboard rendering of one hub message. Unlike the Slack adapter (one
 * mutable summary post), the dashboard shows every kind and the full `content`.
 */
export function messageText(m: HubMessage): string {
  if (m.kind === 'silent') return '🤫 Considered — nothing to add';
  if (m.kind === 'status') return `${/read/i.test(m.content) ? '📖' : '⏳'} ${m.content}`;
  return m.displayContent ?? m.content;
}

/**
 * Chat alignment for a message author: inbound humans read on the left, the platform/agent on the
 * right, everything else (system notices) centered. Drives both the flex justification and the
 * `data-align` seam the tests assert.
 */
export function alignFor(author: string): 'left' | 'right' | 'center' {
  if (author === 'human') return 'left';
  if (author === 'agent') return 'right';
  return 'center';
}

function messageKind(message: HubMessage): HubMessage['kind'] | 'decision' {
  if (message.kind === 'approval') return 'approval';
  if (message.kind === 'reply' && message.content.startsWith('decided: ')) return 'decision';
  return message.kind;
}

/** Group attachments by the hub message that carried them, for rendering beneath each message. */
export function groupAttachmentsByMessage(attachments: Attachment[]): Record<string, Attachment[]> {
  const byMessage: Record<string, Attachment[]> = {};
  for (const a of attachments) {
    if (!a.messageId) continue;
    (byMessage[a.messageId] ??= []).push(a);
  }
  return byMessage;
}

/**
 * Which approvals have already been decided, mapped to the chosen option id — derived purely from the
 * transcript (no schema change). The decide route appends a `decided: <label>` reply after the
 * approval. Works identically for the live WS stream and a transcript reload, since both carry the
 * approval and its `decided:` reply in `messages`.
 *
 * Correlation: when the decided reply carries `approvalId` (stamped by the decide route), we resolve
 * the chosen option by label WITHIN that exact approval — deterministic even when two concurrently pending
 * approvals share an option label. If the named approval is not in the rendered window we skip gracefully
 * (nothing to lock here). A legacy reply with no `approvalId` falls back to the behaviour: scan
 * BACKWARDS for the nearest preceding approval whose options include the label. That fallback keeps its
 * known cosmetic-only mis-attribution risk under a label collision, but the server CAS remains the real gate.
 */
export function decidedApprovals(messages: HubMessage[]): Map<string, string> {
  const decided = new Map<string, string>();
  messages.forEach((m, i) => {
    if (m.kind !== 'reply') return;
    const label = /^decided: (.+)$/.exec(m.content)?.[1];
    if (!label) return;
    // prefer the explicit link — find the named approval and resolve the option by label within it.
    if (m.approvalId) {
      const target = messages.find((p) => p.kind === 'approval' && p.approval?.id === m.approvalId);
      const opt = target?.approval?.options.find((o) => o.label === label);
      if (opt) decided.set(m.approvalId, opt.id);
      return;
    }
    // Legacy fallback: nearest preceding approval whose options include the label.
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j]!;
      if (prev.kind !== 'approval' || !prev.approval) continue;
      const opt = prev.approval.options.find((o) => o.label === label);
      if (opt) {
        decided.set(prev.approval.id, opt.id);
        break;
      }
    }
  });
  return decided;
}

/**
 * Presentational conversation log; extracted from the WS-bound container so it is unit-testable.
 * When `attachmentDeps` is supplied, any attachments tied to a message are
 * lazy-rendered beneath it. Both attachment props are optional so the plain transcript still renders.
 */
export function ConversationLog({
  messages,
  attachments = [],
  attachmentDeps,
  onZoom,
  onDecide,
  viewerUserId,
  viewerName,
  fullAudit = false,
  representedFindings = [],
  workspace,
  getCredentials,
  onFeedbackChanged,
}: {
  messages: HubMessage[];
  attachments?: Attachment[];
  attachmentDeps?: AttachmentDeps;
  onZoom?: (src: string) => void;
  /** Invoked when an operator clicks an approval option; wired to the authed decide POST. */
  onDecide?: (approvalId: string, optionId: string) => void;
  viewerUserId?: string | null;
  viewerName?: string;
  fullAudit?: boolean;
  representedFindings?: string[];
  workspace?: IncidentWorkspaceData;
  getCredentials?: CredentialGetter;
  onFeedbackChanged?: () => void;
}) {
  // Several transcript tests render the log with no router; a bare <Link> would throw there.
  const inRouter = useInRouterContext();
  const byMessage = useMemo(() => groupAttachmentsByMessage(attachments), [attachments]);
  const decided = useMemo(() => decidedApprovals(messages), [messages]);
  const entries = useMemo(
    () => groupTimeline(messages, fullAudit, representedFindings),
    [fullAudit, messages, representedFindings],
  );
  return (
    <ul className="min-w-0 space-y-2 overflow-x-hidden" aria-label="Incident timeline">
      {entries.map((entry) => {
        if (entry.type === 'filtered') {
          return (
            <li
              key="filtered-audit-summary"
              className="rounded-md border border-line bg-surface-subtle px-3 py-2 text-xs text-ink-muted"
            >
              Key events hides {entry.providerSignals} provider notification
              {entry.providerSignals === 1 ? '' : 's'} already summarized above
              {entry.hiddenAssessments > 0
                ? ` and ${entry.hiddenAssessments} automated conclusion${entry.hiddenAssessments === 1 ? '' : 's'} already summarized in the responder brief`
                : ''}
              . Use Full audit for every durable row.
            </li>
          );
        }
        if (entry.type === 'activity') {
          const first = entry.messages[0]!;
          const last = entry.messages.at(-1)!;
          const tools = entry.messages
            .filter((message) => message.kind === 'tool_step')
            .map((message) => message.content.trim().split(/\s+/)[0])
            .filter((tool): tool is string => Boolean(tool));
          const providerSummary = summarizeToolProviders(tools);
          return (
            <li key={entry.id} className="flex min-w-0 justify-end">
              <details className="w-full min-w-0 rounded-2xl rounded-br-md border border-assessment-line bg-assessment-soft px-4 py-3 text-sm shadow-sm">
                <summary className="cursor-pointer list-none font-medium text-ink-secondary">
                  Investigation activity
                  <span className="ml-2 font-normal text-ink-muted">
                    {entry.messages.length} steps
                    {providerSummary ? ` · ${providerSummary}` : ''} ·{' '}
                    {formatAbsoluteTime(first.createdAt)} to {formatAbsoluteTime(last.createdAt)}
                  </span>
                </summary>
                <div className="mt-3 space-y-2 border-t border-assessment-line pt-3">
                  {entry.messages.map((message) => (
                    <div key={message.id} className="min-w-0 text-xs text-ink-muted">
                      <time dateTime={message.createdAt}>
                        {formatAbsoluteTime(message.createdAt)}
                      </time>
                      <p className="whitespace-pre-wrap break-words">{messageText(message)}</p>
                    </div>
                  ))}
                </div>
              </details>
            </li>
          );
        }
        const m = entry.message;
        const forMessage = byMessage[m.id] ?? [];
        const align = alignFor(m.author);
        const createdAt = formatAbsoluteTime(m.createdAt);
        const attachmentsEl = attachmentDeps && forMessage.length > 0 && (
          <MessageAttachments
            attachments={forMessage}
            deps={attachmentDeps}
            inverted={m.author === 'agent'}
            onZoom={onZoom ?? (() => {})}
          />
        );
        const chosenOptionId =
          m.kind === 'approval' && m.approval ? decided.get(m.approval.id) : undefined;
        const isDecided = chosenOptionId !== undefined;
        const kind = messageKind(m);
        const justify =
          align === 'left' ? 'justify-start' : align === 'right' ? 'justify-end' : 'justify-center';
        const isViewer = m.author === 'human' && !!viewerUserId && m.authorUserId === viewerUserId;
        const authorLabel =
          m.author === 'agent'
            ? 'SRE Platform'
            : m.author === 'system'
              ? 'System'
              : isViewer
                ? (viewerName ?? 'You')
                : m.originSurface === 'slack'
                  ? (m.authorDisplayName ?? 'Slack responder')
                  : 'Dashboard responder';
        const avatar =
          m.author === 'agent' ? 'SRE' : m.author === 'system' ? 'SYS' : initials(authorLabel);
        const approvalEl = m.kind === 'approval' && m.approval && (
          <div className="mt-3">
            <p
              className={`mb-2 text-xs ${
                m.author === 'agent' ? 'text-on-strong-muted' : 'text-ink-muted'
              }`}
            >
              Approval records your decision. It does not execute this action.
            </p>
            <div className="flex flex-wrap gap-2">
              {m.approval.options.map((opt) => {
                const isChosen = chosenOptionId === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={isDecided}
                    aria-pressed={isChosen}
                    onClick={() => {
                      if (isDecided) return;
                      onDecide?.(m.approval!.id, opt.id);
                    }}
                    className={`min-h-11 rounded px-3 py-2 text-sm text-on-strong ${
                      isChosen ? 'bg-success-solid' : 'bg-strong-hover hover:bg-strong-hover'
                    } ${isDecided ? 'cursor-not-allowed opacity-60' : ''}`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
        const conciseFinding =
          !fullAudit && m.kind === 'finding' && m.summary && m.summary !== m.content
            ? m.summary
            : null;
        return (
          <li
            key={m.id}
            data-align={align}
            data-message-kind={kind}
            className={`flex min-w-0 text-sm ${justify}`}
          >
            <div
              className={`w-full min-w-0 break-words rounded-2xl px-4 py-3 shadow-sm ${
                m.author === 'agent'
                  ? 'rounded-br-md bg-strong text-on-strong'
                  : m.author === 'human'
                    ? 'rounded-bl-md border border-info-line bg-surface'
                    : 'border border-line bg-surface-strong'
              } ${kind === 'approval' ? 'ring-2 ring-warning-line' : ''} ${
                kind === 'decision' ? 'border-success-line bg-success-soft' : ''
              }`}
            >
              <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-ink-muted">
                <span
                  className={`font-semibold ${m.author === 'agent' ? 'text-on-strong' : 'text-ink-secondary'}`}
                >
                  {authorLabel}
                </span>
                <span
                  aria-label={`${authorLabel} avatar`}
                  className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    m.author === 'agent'
                      ? 'bg-assessment-solid text-on-strong'
                      : m.author === 'human'
                        ? 'bg-info-solid text-on-strong'
                        : 'bg-strong-hover text-on-strong'
                  }`}
                >
                  {avatar}
                </span>
                {isViewer && (
                  <span className="rounded-full bg-info-muted px-2 py-0.5 font-medium text-info">
                    You
                  </span>
                )}
                {m.originSurface && (
                  <span className={m.author === 'agent' ? 'text-on-strong-muted' : undefined}>
                    via {m.originSurface}
                  </span>
                )}
                {m.finding && (
                  <span
                    className={`rounded-full px-2 py-0.5 font-semibold ${
                      m.finding.promotion === 'trusted_assessment'
                        ? 'bg-success-muted text-success'
                        : m.author === 'agent'
                          ? 'bg-strong-hover text-on-strong-muted'
                          : 'bg-warning-muted text-warning'
                    }`}
                  >
                    {m.finding.promotion === 'trusted_assessment'
                      ? 'Trusted assessment'
                      : m.finding.promotion === 'conversation_only'
                        ? 'Conversation update'
                        : `Not promoted · ${m.finding.promotionReason.replaceAll('_', ' ')}`}
                  </span>
                )}
                <span aria-hidden="true">·</span>
                <time
                  dateTime={m.createdAt}
                  title={createdAt}
                  className={m.author === 'agent' ? 'text-on-strong-muted' : undefined}
                >
                  {createdAt}
                </time>
              </div>
              <div className={m.author === 'agent' ? 'text-on-strong' : 'text-ink'}>
                {m.author === 'agent' || m.author === 'human' ? (
                  <ConversationMarkdown idPrefix={`${m.id}-body`} inverted={m.author === 'agent'}>
                    {conciseFinding ?? messageText(m)}
                  </ConversationMarkdown>
                ) : m.kind === 'postmortem' ? (
                  <p className="whitespace-pre-wrap break-words">
                    {messageText(m)}{' '}
                    {inRouter && (
                      <Link to={postmortemPath(m.incidentId)} className="font-semibold underline">
                        Open postmortem
                      </Link>
                    )}
                  </p>
                ) : (
                  <p className="whitespace-pre-wrap break-words">
                    {conciseFinding ?? messageText(m)}
                  </p>
                )}
              </div>
              {conciseFinding && (
                <details className="mt-3 border-t border-line-strong pt-3 text-xs">
                  <summary className="cursor-pointer font-semibold">
                    Full finding and evidence
                  </summary>
                  <div className="mt-2">
                    <ConversationMarkdown
                      idPrefix={`${m.id}-detail`}
                      inverted={m.author === 'agent'}
                    >
                      {messageText(m)}
                    </ConversationMarkdown>
                  </div>
                </details>
              )}
              {approvalEl}
              {m.finding?.runId &&
                m.finding.outcome === 'conclusive' &&
                workspace &&
                getCredentials &&
                onFeedbackChanged && (
                  <FindingFeedback
                    workspace={workspace}
                    getCredentials={getCredentials}
                    onChanged={onFeedbackChanged}
                    targetId={m.finding.runId}
                    compact
                  />
                )}
              {attachmentsEl}
              <DeliveryBadge message={m} inverted={m.author === 'agent'} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type TimelineEntry =
  | { type: 'message'; message: HubMessage }
  | { type: 'activity'; id: string; messages: HubMessage[] }
  | { type: 'filtered'; providerSignals: number; hiddenAssessments: number };

const ACTIVITY_KINDS = new Set(['text', 'tool_step', 'status', 'silent']);

export function groupTimeline(
  messages: HubMessage[],
  fullAudit: boolean,
  representedFindings: string[] = [],
): TimelineEntry[] {
  if (fullAudit) return messages.map((message) => ({ type: 'message', message }));
  const represented = new Set(representedFindings.map((value) => value.trim()).filter(Boolean));
  let providerSignals = 0;
  let hiddenAssessments = 0;
  const visible = messages.filter((message) => {
    if (message.kind === 'signal') {
      providerSignals += 1;
      return false;
    }
    const findingText = (message.summary ?? message.content).trim();
    if (message.kind === 'finding' && represented.has(findingText)) {
      hiddenAssessments += 1;
      return false;
    }
    return true;
  });
  const entries: TimelineEntry[] = [];
  if (providerSignals > 0 || hiddenAssessments > 0) {
    entries.push({ type: 'filtered', providerSignals, hiddenAssessments });
  }
  let activity: HubMessage[] = [];
  const flush = () => {
    if (activity.length === 1 && visible.length <= 10) {
      entries.push({ type: 'message', message: activity[0]! });
      activity = [];
    } else if (activity.length > 0) {
      entries.push({ type: 'activity', id: `activity:${activity[0]!.id}`, messages: activity });
      activity = [];
    }
  };
  for (const message of visible) {
    if (message.author === 'agent' && ACTIVITY_KINDS.has(message.kind)) activity.push(message);
    else {
      flush();
      entries.push({ type: 'message', message });
    }
  }
  flush();
  return entries;
}

function initials(label: string): string {
  return (
    label
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join('') || 'U'
  );
}

export function deliveryLabel(delivery: SurfaceDelivery | null | undefined): string | null {
  if (!delivery) return null;
  if (delivery.state === 'queued' || delivery.state === 'sending') return 'Waiting for Slack';
  if (delivery.state === 'accepted') return 'Accepted by Slack';
  if (delivery.state === 'rejected') return 'Slack rejected this message';
  if (delivery.state === 'uncertain') return 'Slack acceptance unknown';
  if (delivery.state === 'blocked') return 'Not sent to Slack';
  return null;
}

function DeliveryBadge({ message, inverted }: { message: HubMessage; inverted: boolean }) {
  const deliveries =
    message.slackDeliveries && message.slackDeliveries.length > 0
      ? message.slackDeliveries
      : message.slackDelivery
        ? [message.slackDelivery]
        : [];
  const failed = deliveries.filter((delivery) =>
    ['rejected', 'uncertain', 'blocked'].includes(delivery.state),
  );
  const waitingDeliveries = deliveries.filter(
    (delivery) => delivery.state === 'queued' || delivery.state === 'sending',
  );
  const label =
    deliveries.length > 1
      ? failed.length > 0
        ? `${failed.length} of ${deliveries.length} Slack thread deliveries need attention`
        : waitingDeliveries.length > 0
          ? `Waiting for Slack in ${waitingDeliveries.length} of ${deliveries.length} threads`
          : deliveries.every((delivery) => delivery.state === 'skipped')
            ? `Slack already current in ${deliveries.length} threads`
            : `Accepted by Slack in ${deliveries.length} threads`
      : deliveryLabel(deliveries[0]);
  if (!label) return null;
  const state =
    failed[0]?.state ?? waitingDeliveries[0]?.state ?? deliveries[0]?.state ?? undefined;
  return (
    <p
      className={`mt-2 text-xs font-medium ${
        inverted
          ? 'text-on-strong-muted'
          : state === 'accepted'
            ? 'text-success'
            : state === 'rejected' || state === 'blocked' || state === 'uncertain'
              ? 'text-warning'
              : 'text-ink-muted'
      }`}
    >
      {label}
    </p>
  );
}
