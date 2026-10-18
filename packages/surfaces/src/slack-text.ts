// Slack mrkdwn text helpers shared by the outbound adapter: escaping, links, and finding lines.
import { linkableMentions } from '@sre/contracts';
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
  // Never end on the first half of a surrogate pair, which Slack renders as a replacement glyph.
  const cut = line.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, '');
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
    const isSha = item.kind === 'commit';
    if (!item.url.startsWith('https://') || (isSha && !/^[0-9a-f]{8}$/.test(item.label))) continue;
    // Not inside an existing link or URL path, and not part of a longer word. A name may not follow
    // a dot, so a hostname or file name never links, nor `&`, so it cannot match inside an escape
    // entity such as `&lt;`, nor `=`, `?` or `#`, so a value inside a cited URL stays as written.
    const pattern = isSha
      ? undefined
      : new RegExp(
          `(?<![\\w./|=?#&-])${item.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-]|\\.\\w)`,
          'g',
        );
    // Escaping turns every model `<` into `&lt;`, so each `<…>` left is a link inserted above.
    const inserted = [...out.matchAll(/<[^>]*>/g)].map(
      (link) => [link.index, link.index + link[0].length] as const,
    );
    // A mention of this commit: another SHA can share the 7-character prefix, so a mention that
    // matches all 8 label characters wins over an earlier 7-character one.
    const candidates = linkableMentions(out, pattern).filter(
      (candidate) =>
        !inserted.some(([from, to]) => candidate.start < to && candidate.end > from) &&
        (!isSha ||
          (candidate.token.startsWith(item.label.slice(0, 7)) &&
            item.label.startsWith(candidate.token.slice(0, 8)))),
    );
    const match = candidates.find((candidate) => candidate.token.length >= 8) ?? candidates[0];
    if (match) {
      out = `${out.slice(0, match.start)}${deepLink(item.url, match.token)}${out.slice(match.end)}`;
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
 * @param showGaps - Whether the finding's gaps are open checks: an inconclusive result, or a blocked
 * one whose gaps name the data no connected tool can read.
 */
export function findingLines(finding: Finding, trusted: boolean, showGaps: boolean): string[] {
  if (finding.promotion === 'conversation_only') return [];
  return [
    ...(finding.likelyCause
      ? [`${trusted ? 'Cause' : 'Likely cause'}: ${clip(finding.likelyCause, LINE_MAX)}`]
      : []),
    ...(finding.impact ? [`Impact: ${clip(finding.impact, LINE_MAX)}`] : []),
    ...(finding.nextStep ? [`Do: ${clip(finding.nextStep, NEXT_STEP_MAX)}`] : []),
    ...(showGaps && finding.gaps?.length
      ? [
          `Verify: ${finding.gaps
            .slice(0, 3)
            .map((gap) => clip(gap, GAP_MAX))
            .join(' · ')}`,
        ]
      : []),
  ];
}
