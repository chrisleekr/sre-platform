// Slack mrkdwn text helpers shared by the outbound adapter: escaping, links, and finding lines.
import type { OutboundMessage } from './types';

type Finding = NonNullable<OutboundMessage['finding']>;

// Slack mrkdwn treats & < > specially; escape them so untrusted text can't inject markup or a fake link.
// & MUST be replaced first, or the < and > passes would re-escape the ampersands this pass just emitted.
// https://docs.slack.dev/messaging/formatting-message-text/#escaping
export const escapeSlackText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const deepLink = (url: string, label: string): string => {
  const safeUrl = url
    .replace(/&/g, '&amp;')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/\|/g, '%7C');
  return `<${safeUrl}|${label}>`;
};
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

type FindingLink = NonNullable<Finding['links']>[number];

const LINE_MAX = 300;
const NEXT_STEP_MAX = 400;
const GAP_MAX = 160;
const LINKS_MAX = 4;

/** Flattens model text to one line and cuts it at a word boundary. */
function clip(text: string, max: number): string {
  const line = oneLine(text);
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * Links the first mention of each platform-built link label in escaped text. A commit label matches
 * the same SHA written at any length from 7 characters, so `3391576` and the full SHA both link. A
 * commit the text never names is dropped: the run reads many commits, and listing them buries the
 * one that matters. Any other unmentioned label, such as the Argo CD application, goes on a Links
 * line. Labels contain no Slack control characters, so matching in escaped text is exact.
 */
export function linkify(text: string, links: readonly FindingLink[] | undefined): string {
  if (!links?.length) return text;
  let out = text;
  const unmatched: FindingLink[] = [];
  for (const item of links) {
    // The payload is stored JSON: re-check what the builder guaranteed before rendering it.
    if (!item.url.startsWith('https://')) continue;
    const isSha = /^[0-9a-f]{8}$/.test(item.label);
    const token = isSha
      ? `${item.label.slice(0, 7)}[0-9a-f]{0,33}`
      : item.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Not inside an existing link or URL path, and not part of a longer word. A SHA may follow a
    // range dot (`a..b`); a name may not, so a hostname or file name never links.
    const pattern = isSha
      ? new RegExp(`(?<![\\w/|-])(${token})(?![\\w/-])`)
      : new RegExp(`(?<![\\w./|-])(${token})(?![\\w/-]|\\.\\w)`);
    const match = pattern.exec(out);
    if (match && (!isSha || item.label.startsWith(match[1]!.slice(0, 8)))) {
      out = `${out.slice(0, match.index)}${deepLink(item.url, match[1]!)}${out.slice(match.index + match[1]!.length)}`;
    } else if (!isSha) unmatched.push(item);
  }
  if (unmatched.length === 0) return out;
  return `${out}\nLinks: ${unmatched
    .slice(0, LINKS_MAX)
    .map((item) => deepLink(item.url, escapeSlackText(item.label)))
    .join(' · ')}`;
}

/**
 * One labelled line per question a responder asks: why, how bad, what to do, what is still open.
 * Model text is flattened so it cannot forge a line such as an incident link. An untrusted cause
 * always reads as likely. A responder reply is a chat answer, not an assessment, so it gets none.
 * @param finding - Finding provenance carried by the hub message.
 * @param trusted - Whether the finding is the trusted assessment.
 * @param unverified - Whether the finding is an inconclusive investigation result.
 */
export function findingLines(finding: Finding, trusted: boolean, unverified: boolean): string[] {
  if (finding.promotion === 'conversation_only') return [];
  return [
    ...(finding.likelyCause
      ? [`${trusted ? 'Cause' : 'Likely cause'}: ${clip(finding.likelyCause, LINE_MAX)}`]
      : []),
    ...(finding.impact ? [`Impact: ${clip(finding.impact, LINE_MAX)}`] : []),
    ...(finding.nextStep ? [`Do: ${clip(finding.nextStep, NEXT_STEP_MAX)}`] : []),
    ...(unverified && finding.gaps?.length
      ? [
          `Verify: ${finding.gaps
            .slice(0, 3)
            .map((gap) => clip(gap, GAP_MAX))
            .join(' · ')}`,
        ]
      : []),
  ];
}
