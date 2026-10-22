export type IncidentTitleSource =
  'stored' | 'linked_alert' | 'opening_request' | 'opening_context' | 'missing' | 'unavailable';
export interface IncidentTitlePresentation {
  displayTitle: string;
  titleSource: IncidentTitleSource;
}

const MAX_TITLE_INPUT = 4_000;

/** Keep a symptom or diagnostic request, not provider addressing or transport labels.
 * @param value - Untrusted stored title or bounded opening request.
 */
export function meaningfulIncidentTitle(value: string | null | undefined): string | null {
  if (!value) return null;
  // The markup patterns below rescan from every '<' on unclosed input, so bound the work. A title
  // keeps at most 160 code points, which this prefix always covers.
  const clean = value
    .slice(0, MAX_TITLE_INPUT)
    // A mention label excludes '<' (Slack escapes it as &lt;), so a run of unclosed `<@x|` fails at
    // the next '<' instead of rescanning to the end of untrusted text.
    .replace(/<@[A-Z0-9]+(?:\|[^<>]+)?>/gi, '')
    .replace(/<![^>]+>/g, '')
    .replace(/<https?:\/\/[^>|]+\|([^>]+)>/g, '$1')
    // Keep a separator so removing markup cannot join surrounding text into a new token.
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, '')
    .split('\n')
    .filter(
      (line) =>
        !/^(?:hi|hello|hey)(?:[ ,]+(?:team|all|everyone|folks))?[!., ]*$/i.test(line.trim()),
    )
    .join('\n')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    !/[\p{L}\p{N}]/u.test(clean) ||
    /^(?:investigation requested in slack|human-initiated via @mention\.?|slack:[^ ]+|issue not described|opening context unavailable)$/i.test(
      clean,
    )
  )
    return null;
  const points = [...clean];
  return points.length > 160 ? `${points.slice(0, 159).join('').trimEnd()}…` : clean;
}

/** Derive a bounded task excerpt from an attributable opener and its earlier thread.
 * @param request - The incident-opening message, not a later responder reply.
 * @param priorThread - Earlier thread rendered with bracketed user attribution.
 */
export function openingIncidentTitle(request: string, priorThread = ''): IncidentTitlePresentation {
  const direct = meaningfulIncidentTitle(request);
  if (direct) return { displayTitle: direct, titleSource: 'opening_request' };
  const start = priorThread.search(/^\[[^\]\n]+\]:/m);
  const root = start < 0 ? '' : priorThread.slice(start).split(/\n(?=\[[^\]\n]+\]:)/, 1)[0];
  const excerpt = root ? meaningfulIncidentTitle(root.replace(/^\[[^\]\n]+\]:\s*/, '')) : null;
  if (excerpt) return { displayTitle: excerpt, titleSource: 'opening_context' };
  return { displayTitle: 'Issue not described', titleSource: 'missing' };
}
