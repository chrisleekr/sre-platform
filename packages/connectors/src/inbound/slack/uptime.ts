import { createHash } from 'node:crypto';
import type { InboundObservation } from '../types';

/** Reads lifecycle and full monitor scope from the provider's uptime template. */
export function uptimeNotification(
  text: string,
): { state: 'firing' | 'resolved'; url?: string } | null {
  // StatusCake appends zero or more bracketed reasons, such as [HTTP 522] [Unexpected Status Code]
  // or [Timeout / Connection Refused]. Identity comes from the URL only, never from the reasons.
  const notices = [
    ...text.matchAll(
      /(?:^|\n)Website \| Your site '([^'\n]*)'(?: \(([^)\n]+)\))? went (Up|Down)(?: \[[^\]\n]+\])*(?=\s|$)/g,
    ),
  ];
  if (notices.length === 0) return null;
  const urls = notices.map((notice) => {
    const reference = notice[2] ?? notice[1]!;
    const href = /^<([^|>]+)(?:\|[^>]*)?>$/.exec(reference)?.[1] ?? reference;
    try {
      const url = new URL(href);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        ? url.href
        : null;
    } catch {
      return null;
    }
  });
  // Conflicting notices remain recoveries without authority to mutate any monitor.
  const state = notices.some((notice) => notice[3] === 'Up') ? 'resolved' : 'firing';
  const consistent = notices.every((notice) => notice[3] === notices[0]![3]);
  const url =
    consistent && urls[0] && urls.every((value) => value === urls[0]) ? urls[0] : undefined;
  return { state, ...(url ? { url } : {}) };
}

/** Builds one normalized observation while retaining ambiguous recovery notifications. */
export function uptimeObservation(
  uptime: NonNullable<ReturnType<typeof uptimeNotification>>,
  input: {
    text: string;
    channel: string;
    externalId: string;
    eventKey: string;
    eventVersion: string;
    eventAt: string;
  },
): InboundObservation {
  return {
    externalMessageId: input.externalId,
    state: uptime.state,
    summary: input.text,
    contentHash: createHash('sha256').update(input.text).digest('hex'),
    eventKey: input.eventKey,
    eventVersion: input.eventVersion,
    eventAt: input.eventAt,
    provider: 'statuscake',
    ...(uptime.url
      ? {
          providerGroupKey: `statuscake:uptime:${uptime.url}`,
          monitorKey: `slack:${createHash('sha256').update(`${input.channel}\nstatuscake:uptime:${uptime.url}`).digest('hex')}`,
          alertName: `Website availability: ${uptime.url}`,
        }
      : {}),
  };
}
