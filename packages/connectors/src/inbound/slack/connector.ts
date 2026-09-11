import { createHash } from 'node:crypto';
import type {
  IInboundConnector,
  InboundCandidate,
  InboundContext,
  InboundObservation,
} from '../types';
import { semanticMaterialText } from '../../materiality';

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Slack attachments are legacy, but alert integrations still use them without top-level text. */
function attachmentText(value: unknown): string {
  if (!Array.isArray(value)) return '';

  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (part: string): void => {
    if (!part || seen.has(part)) return;
    seen.add(part);
    parts.push(part);
  };
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const attachment = raw as Record<string, unknown>;
    for (const key of ['fallback', 'pretext']) {
      add(trimmed(attachment[key]));
    }
    const title = trimmed(attachment.title);
    const titleLink = trimmed(attachment.title_link);
    if (title && titleLink) add(`<${titleLink}|${title}>`);
    else add(title);
    add(trimmed(attachment.text));

    if (!Array.isArray(attachment.fields)) continue;
    for (const rawField of attachment.fields) {
      if (typeof rawField !== 'object' || rawField === null) continue;
      const field = rawField as Record<string, unknown>;
      const fieldTitle = trimmed(field.title);
      const fieldValue = trimmed(field.value);
      add(fieldTitle && fieldValue ? `${fieldTitle}: ${fieldValue}` : fieldTitle || fieldValue);
    }
  }

  return parts.join('\n');
}

function attachmentFields(value: unknown): Map<string, string> {
  const fields = new Map<string, string>();
  if (!Array.isArray(value)) return fields;
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const attachment = raw as Record<string, unknown>;
    if (!Array.isArray(attachment.fields)) continue;
    for (const rawField of attachment.fields) {
      if (typeof rawField !== 'object' || rawField === null) continue;
      const field = rawField as Record<string, unknown>;
      const title = trimmed(field.title).toLowerCase();
      const fieldValue = trimmed(field.value);
      if (title && fieldValue) fields.set(title, fieldValue);
    }
  }
  return fields;
}

function attachmentFieldValues(value: unknown, name: string): string[] {
  const values: string[] = [];
  if (!Array.isArray(value)) return values;
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const attachment = raw as Record<string, unknown>;
    if (!Array.isArray(attachment.fields)) continue;
    for (const rawField of attachment.fields) {
      if (typeof rawField !== 'object' || rawField === null) continue;
      const field = rawField as Record<string, unknown>;
      if (trimmed(field.title).toLowerCase() !== name) continue;
      const fieldValue = trimmed(field.value);
      if (fieldValue) values.push(fieldValue);
    }
  }
  return values;
}

function attachmentMetadata(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const attachment = raw as Record<string, unknown>;
    for (const key of ['fallback', 'pretext', 'title', 'text', 'footer', 'author_name']) {
      const part = trimmed(attachment[key]);
      if (part) parts.push(part);
    }
  }
  return parts.join('\n');
}

function firingProviderShape(body: Record<string, unknown>, text: string): boolean {
  const fields = attachmentFields(body.attachments);
  const metadata = [text, attachmentMetadata(body.attachments)].filter(Boolean).join('\n');
  const structuredAlertFields =
    fields.has('severity') &&
    /\b(?:alertmanager|datadog|monitoring|opsgenie|pagerduty|prometheus|statuscake)\b/i.test(
      fields.get('source') ?? '',
    );
  return (
    structuredAlertFields ||
    /\[\s*firing(?:\s*:\s*\d+)?\s*\]|(?:^|\n)\s*\*alert:\*/i.test(metadata) ||
    /\balertmanager\s*:[^\n]*\bfiring\b|(?:^|\n)\s*firing alert\b/i.test(metadata) ||
    /\bwebsite\s*\|[\s\S]*\bwent\s+down\s*\[http\s+\d{3}\]/i.test(metadata) ||
    /\bssl monitoring\b|\bexpiration reminder\b[\s\S]*\bcertificate\b|\bcertificate valid until\b/i.test(
      metadata,
    )
  );
}

function eventBody(event: unknown): Record<string, unknown> | null {
  if (typeof event !== 'object' || event === null) return null;
  const outer = event as Record<string, unknown>;
  return outer.subtype === 'message_changed' && typeof outer.message === 'object' && outer.message
    ? (outer.message as Record<string, unknown>)
    : outer;
}

function providerKey(source: string): string | undefined {
  const key = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return key || undefined;
}

function blockFieldValue(block: string, name: string): string | undefined {
  const match = new RegExp(
    `\\*${name}:\\*\\s*([\\s\\S]*?)(?=\\s*\\*(?:Description|Severity|Source|Alert):\\*|$)`,
    'i',
  ).exec(block);
  return match?.[1]?.trim().replace(/^`|`$/g, '') || undefined;
}

function groupedEventKey(eventKey: string, identity: string): string {
  const producerIndex = eventKey.lastIndexOf(':producer:');
  if (producerIndex < 0) return `${eventKey}:observation:${identity}`;
  return `${eventKey.slice(0, producerIndex)}:observation:${identity}${eventKey.slice(producerIndex)}`;
}

const ALERTMANAGER_GROUP =
  /(?:^|\n)\[\s*(?:firing|resolved)(?:\s*:\s*\d+)?\s*\]\s+([^|\n]+?)\s*\|\s*<([^|>\n]+)(?:\|[^>\n]*)?>/i;

function alertmanagerGroupKey(text: string): string | undefined {
  const match = ALERTMANAGER_GROUP.exec(text);
  if (!match) return undefined;
  const group = match[1]!.trim().replace(/\s+/g, ' ').toLowerCase();
  let source: string;
  try {
    const url = new URL(match[2]!.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    source = `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
  return group && source ? `alertmanager:${source}|${group}` : undefined;
}

function observationMaterial(input: {
  providerGroupKey?: string;
  alertName: string;
  description?: string;
  severity?: string;
  source?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.providerGroupKey ?? '',
        input.alertName.toLowerCase().replace(/\s+/g, ' ').trim(),
        semanticMaterialText(input.description ?? ''),
        input.severity?.toLowerCase().trim() ?? '',
        input.source?.toLowerCase().trim() ?? '',
      ]),
    )
    .digest('hex');
}

interface ProviderAlertBlock {
  raw: string;
  alertName: string;
  description?: string;
  severity?: string;
  source?: string;
}

/**
 * Parses rendered provider alert fields without assigning lifecycle meaning.
 *
 * @param text - Slack text containing zero or more provider alert blocks.
 */
function providerAlertBlocks(text: string): ProviderAlertBlock[] {
  return [...text.matchAll(/\*Alert:\*\s*([\s\S]*?)(?=\s*\*Alert:\*|$)/gi)].map((match) => {
    const raw = match[1]!.trim();
    return {
      raw,
      alertName: raw.split(/\s*\*(?:Description|Severity|Source):\*/i, 1)[0]!.trim(),
      description: blockFieldValue(raw, 'Description'),
      severity: blockFieldValue(raw, 'Severity'),
      source: blockFieldValue(raw, 'Source'),
    };
  });
}

function providerObservations(input: {
  text: string;
  channel: string;
  externalId: string;
  state: InboundObservation['state'];
  eventKey: string;
  eventVersion: string;
  eventAt: string;
}): InboundObservation[] | undefined {
  const blocks = providerAlertBlocks(input.text);
  if (blocks.length === 0) return undefined;
  const providerGroupKey = alertmanagerGroupKey(input.text);
  const occurrences = new Map<string, number>();
  return blocks.map((block) => {
    const { alertName, description, severity, source } = block;
    const summary = [
      alertName,
      description,
      severity ? `Severity: ${severity}` : '',
      source ? `Source: ${source}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const member = block.raw.toLowerCase().replace(/\s+/g, ' ').trim();
    const alertIdentity = alertName.toLowerCase().replace(/\s+/g, ' ').trim();
    const occurrence = occurrences.get(alertIdentity) ?? 0;
    occurrences.set(alertIdentity, occurrence + 1);
    const identity = createHash('sha256')
      .update(`${member}\n${occurrence}`)
      .digest('hex')
      .slice(0, 16);
    const provider = source ? providerKey(source) : undefined;
    const monitorScope = providerGroupKey ?? (provider ? `provider:${provider}` : undefined);
    const monitorKey = monitorScope
      ? `slack:${createHash('sha256')
          .update(`${input.channel}\n${monitorScope}\n${alertIdentity}\n${occurrence}`)
          .digest('hex')}`
      : undefined;
    return {
      externalMessageId: `${input.externalId}#${identity}`,
      state: input.state,
      summary,
      contentHash: createHash('sha256').update(summary).digest('hex'),
      eventKey: groupedEventKey(input.eventKey, identity),
      eventVersion: input.eventVersion,
      eventAt: input.eventAt,
      ...(provider ? { provider } : {}),
      ...(providerGroupKey ? { providerGroupKey } : {}),
      ...(monitorKey ? { monitorKey } : {}),
      ...(alertName ? { alertName } : {}),
      materialHash: observationMaterial({
        providerGroupKey,
        alertName,
        description,
        severity,
        source,
      }),
    };
  });
}

/**
 * Detects an affirmative instruction to route a notification to a null receiver.
 *
 * @param value - Provider-authored routing or description field.
 */
function declaresNullReceiver(value: string | undefined): boolean {
  const clauses = (value ?? '')
    .toLowerCase()
    .split(/[.;\n]+/)
    .map((clause) => clause.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  return clauses.some((clause) =>
    /^(?:(?:this (?:alert|notification)|it)\s+)?(?:(?:should|must|will)\s+(?:be\s+)?|(?:is|was)\s+)?(?:route|routed|routing)\s+(?:to\s+)?(?:a\s+)?null receiver$/i.test(
      clause,
    ),
  );
}

/**
 * Maps Slack-specific provider control semantics to the shared suppression vocabulary.
 *
 * @param event - Untrusted Slack event carrying the provider fields.
 * @param candidateText - Normalized candidate text used when attachments omit fields.
 */
function controlNotificationReason(
  event: unknown,
  candidateText: string,
): 'provider_control_notification' | null {
  const body = eventBody(event);
  if (!body) return null;
  const normalize = (value: string | undefined): string =>
    (value ?? '').trim().replace(/^`|`$/g, '').replace(/\s+/g, ' ').toLowerCase();
  const metadata = [
    candidateText,
    attachmentMetadata(body.attachments),
    attachmentText(body.attachments),
  ]
    .filter(Boolean)
    .join('\n');
  const blocks = providerAlertBlocks(metadata);
  const severities = [
    ...blocks.map((block) => block.severity),
    ...attachmentFieldValues(body.attachments, 'severity'),
  ].filter((severity): severity is string => Boolean(severity));
  if (severities.length === 0 || severities.some((severity) => normalize(severity) !== 'none'))
    return null;

  const sources = blocks.map((block) => normalize(block.source)).filter(Boolean);
  const isAlertmanager =
    sources.some((source) => source.includes('alertmanager')) || ALERTMANAGER_GROUP.test(metadata);
  const infoInhibitor =
    /(?:^|\n)\[\s*(?:firing|resolved)(?:\s*:\s*\d+)?\s*\]\s+infoinhibitor\b/i.test(metadata);
  const receiverValues = attachmentFieldValues(body.attachments, 'receiver').map(normalize);
  const routingValues = attachmentFieldValues(body.attachments, 'routing');
  const structuredNullReceiver =
    receiverValues.length > 0 && receiverValues.every((receiver) => receiver === 'null');
  const structuredNullRouting =
    routingValues.length > 0 && routingValues.every((routing) => normalize(routing) === 'null');
  const proseNullReceiver = [
    ...routingValues,
    ...attachmentFieldValues(body.attachments, 'description'),
    ...blocks.map((block) => block.description).filter((value): value is string => Boolean(value)),
  ].some(declaresNullReceiver);
  const hasExplicitNonNullRoute =
    receiverValues.some((receiver) => receiver !== 'null') ||
    routingValues.some(
      (routing) => normalize(routing) !== 'null' && !declaresNullReceiver(routing),
    );
  const nullReceiver =
    !hasExplicitNonNullRoute &&
    (structuredNullReceiver || structuredNullRouting || proseNullReceiver);
  return (isAlertmanager && infoInhibitor) || nullReceiver ? 'provider_control_notification' : null;
}

const resolvedNotification = (text: string): boolean =>
  /(?:^|\n)(?:(?:<[^|>]+\|)?\[\s*resolved(?:\s*:\s*\d+)?\s*\]|resolved\s*:)/i.test(text);

function slackTimestamp(value: string): { eventAt: string; eventVersion: string } | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  const seconds = BigInt(match[1]!);
  const micros = BigInt((match[2] ?? '').padEnd(6, '0'));
  const observed = new Date(Number(seconds * 1000n + micros / 1000n));
  if (Number.isNaN(observed.getTime())) return null;
  return {
    eventAt: observed.toISOString(),
    eventVersion: String(seconds * 1_000_000n + micros),
  };
}

/**
 * Slack inbound connector. Receives the inner Slack event object and yields a
 * candidate only for top-level channel messages with usable top-level or attachment-derived alert text. Thread replies
 * (thread_ts present) are the resume path, handled elsewhere, so they are dropped here.
 *
 * Bot posts are kept as alert candidates, including a root message posted by an incoming webhook on
 * the connected app itself. The platform only projects messages as thread replies, and the thread gate
 * below rejects those before classification, so bot identity is not a sound root-message loop guard.
 *
 * @param event - Untrusted inner Slack event.
 * @param ctx - Verified identity context for the connected Slack app.
 */
function slackCandidate(event: unknown, ctx: InboundContext): InboundCandidate | null {
  const e = typeof event === 'object' && event !== null ? (event as Record<string, unknown>) : null;
  if (!e) return null;

  if (e.type !== 'message') return null;

  // Slack nests the replacement message under `message` for message_changed. Every other non-alert
  // subtype remains outside the root-signal path.
  const subtype = typeof e.subtype === 'string' ? e.subtype : undefined;
  if (subtype !== undefined && subtype !== 'bot_message' && subtype !== 'message_changed')
    return null;

  const nested =
    subtype === 'message_changed' && typeof e.message === 'object' && e.message !== null
      ? (e.message as Record<string, unknown>)
      : e;

  const attachments = attachmentText(nested.attachments);
  const text = trimmed(nested.text) || attachments;
  if (text === '') return null;

  const channel = typeof e.channel === 'string' ? e.channel : '';
  if (channel === '') return null;

  const ts = typeof nested.ts === 'string' ? nested.ts : '';
  if (ts === '') return null;

  const botId = typeof nested.bot_id === 'string' ? nested.bot_id : undefined;
  const user = typeof nested.user === 'string' ? nested.user : undefined;
  const authoredByBot = botId !== undefined || (user !== undefined && user === ctx.botUserId);
  const producerId = botId ? `bot:${botId}` : user ? `user:${user}` : undefined;
  const producerTag = producerId ? `:producer:${producerId}` : '';
  const editTs =
    typeof nested.edited === 'object' && nested.edited !== null
      ? trimmed((nested.edited as Record<string, unknown>).ts)
      : '';
  const eventTs = editTs || trimmed(e.event_ts) || trimmed(e.ts) || ts;
  const observed = slackTimestamp(eventTs);
  if (!observed) return null;
  const signalState = resolvedNotification(text)
    ? 'resolved'
    : authoredByBot
      ? 'firing'
      : 'unknown';
  const alertKind =
    authoredByBot &&
    signalState === 'firing' &&
    firingProviderShape(nested, [trimmed(nested.text), attachments].join('\n'))
      ? 'firing'
      : undefined;

  // Human replies belong to the conversational resume path. A provider bot may, however, publish
  // the terminal notification inside the original alert thread instead of editing the root or
  // posting a second root. Admit only that exact provider-resolution shape. Platform replies cannot
  // resolve an alert accidentally: they use a different producer identity and the downstream matcher
  // still requires one unique Alertmanager signal identity.
  const isThreadReply =
    nested.thread_ts !== undefined && nested.thread_ts !== null && nested.thread_ts !== nested.ts;
  if (isThreadReply && !(authoredByBot && signalState === 'resolved')) return null;

  const eventKey =
    subtype === 'message_changed'
      ? `slack:${channel}:${ts}:edit:${eventTs}${producerTag}`
      : `slack:${channel}:${ts}${producerTag}`;
  return {
    externalId: ts,
    channel,
    author: authoredByBot ? 'bot' : 'human',
    producerId,
    text,
    raw: event,
    signalState,
    ...(alertKind ? { alertKind } : {}),
    eventKey,
    eventVersion: observed.eventVersion,
    eventAt: observed.eventAt,
    contentHash: createHash('sha256').update(text).digest('hex'),
    isEdit: subtype === 'message_changed',
    observations: providerObservations({
      text: [trimmed(nested.text), attachments].filter(Boolean).join('\n'),
      channel,
      externalId: ts,
      state: signalState,
      eventKey,
      eventVersion: observed.eventVersion,
      eventAt: observed.eventAt,
    }),
  };
}

export const slackInboundConnector: IInboundConnector<'slack'> = {
  surface: 'slack',
  evaluate(event: unknown, ctx: InboundContext) {
    const candidate = slackCandidate(event, ctx);
    if (!candidate) return null;
    const suppressionReason =
      candidate.author === 'bot' ? controlNotificationReason(event, candidate.text) : null;
    return suppressionReason
      ? { disposition: 'suppress', reason: suppressionReason, candidate }
      : { disposition: 'admit', candidate };
  },
};
