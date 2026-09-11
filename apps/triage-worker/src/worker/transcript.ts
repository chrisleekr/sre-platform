import type { HubMessage } from '@sre/hub';
import type { ResumeInput } from '../engine/types';

export const TRANSCRIPT_MAX_ROWS = 500;
const DEFAULT_TRANSCRIPT_BUDGET_CHARS = 24000;
/** Keep current-request and conversation-history size checks consistent.
 * @param content - Stored responder text before transport serialization.
 */
export function responderMessageWithinBudget(content: string): boolean {
  return JSON.stringify({ currentResponderMessage: content }).length <= 24_000;
}

const fitsHumanMessage = (message: HubMessage): boolean =>
  message.author !== 'human' ||
  message.kind !== 'text' ||
  responderMessageWithinBudget(message.content);
const PRIOR_EXCLUDED_KINDS: ReadonlySet<string> = new Set(['status', 'silent']);
const isPriorContext = (message: HubMessage): boolean =>
  !PRIOR_EXCLUDED_KINDS.has(message.kind) ||
  (message.author === 'system' && message.originMessageId?.startsWith('thread-context:') === true);

/** Resolve the model transcript character budget from process configuration. */
export const transcriptBudgetChars = (): number => {
  const value = Number(process.env.TRANSCRIPT_BUDGET_CHARS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TRANSCRIPT_BUDGET_CHARS;
};

/** Synthetic entry used when older transcript messages are omitted. */
export const ELISION_MARKER = {
  author: 'system',
  kind: 'text',
  content: '[… earlier messages elided …]',
} as const;

const toPriorEntry = (message: HubMessage) => ({
  author: message.author,
  kind: message.kind,
  content: message.content,
});

export function modelPrior(history: HubMessage[]): ResumeInput['prior'] {
  const relevant = history.filter(isPriorContext);
  return [
    ...(relevant.some((message) => !fitsHumanMessage(message)) ? [{ ...ELISION_MARKER }] : []),
    ...relevant.filter(fitsHumanMessage).map(toPriorEntry),
  ];
}

/**
 * Split a resume transcript into the triggering human message and prior context.
 *
 * @param history - Ordered durable conversation messages.
 * @param humanMessageId - Message that triggered the resume job.
 * @param opts - Optional opener pinning and transcript bounds.
 */
export function splitResumeInput(
  history: HubMessage[],
  humanMessageId: string,
  opts: {
    opener?: HubMessage | null;
    budget?: number;
    truncated?: boolean;
    currentMessage?: { id: string; content: string };
  } = {},
): { humanMessage: string; prior: ResumeInput['prior'] } | null {
  const target =
    history.find((message) => message.id === humanMessageId) ??
    (opts.currentMessage?.id === humanMessageId ? opts.currentMessage : undefined);
  if (!target) return null;
  const budget = opts.budget ?? transcriptBudgetChars();
  const filtered = history.filter((message) => message.id !== target.id && isPriorContext(message));
  const opener =
    opts.opener &&
    opts.opener.id !== target.id &&
    isPriorContext(opts.opener) &&
    fitsHumanMessage(opts.opener) &&
    opts.opener.content.length <= budget
      ? opts.opener
      : null;
  let remaining = budget - (opener ? opener.content.length : 0);
  const shown = new Set<string>();
  const tail: ResumeInput['prior'] = [];
  for (let index = filtered.length - 1; index >= 0; index--) {
    const message = filtered[index]!;
    if (opener && message.id === opener.id) continue;
    if (!fitsHumanMessage(message)) continue;
    if (message.content.length > remaining) break;
    remaining -= message.content.length;
    shown.add(message.id);
    tail.unshift(toPriorEntry(message));
  }
  const windowOmitted = filtered.some(
    (message) => message.id !== opener?.id && !shown.has(message.id),
  );
  const openerGap = Boolean(
    opts.opener &&
    opts.opener.id !== target.id &&
    isPriorContext(opts.opener) &&
    (!opener || (history.length > 0 && history[0]!.id !== opener.id)),
  );
  const prior: ResumeInput['prior'] = [];
  if (opener) prior.push(toPriorEntry(opener));
  if (windowOmitted || openerGap || opts.truncated) prior.push({ ...ELISION_MARKER });
  prior.push(...tail);
  return { humanMessage: target.content, prior };
}
