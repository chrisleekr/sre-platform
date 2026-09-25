import * as z from 'zod';
import type { IncidentSummary } from '@sre/db';

const RESOLUTION_SUMMARY_MAX_CHARACTERS = 1_000;
const RESOLUTION_IDENTITY_STOP_WORDS = new Set([
  'alertmanager',
  'connection',
  'critical',
  'firing',
  'healthy',
  'monitoring',
  'prometheus',
  'recovered',
  'resolved',
  'statuscake',
  'successful',
  'unexpected',
  'warning',
  'website',
]);

/**
 * The in-context correlation verdict. The classifier/characterizer SELECTS a decision
 * over a SHOWN candidate list, it never invents an incident id: `belongs_to` carries an opaque 1-based
 * `index` into the rendered candidate block, resolved to a real id here (an out-of-range index is a
 * hallucination and falls back to new_incident). `new_incident` proposes the routable fields; the
 * structural per-message content-hash fingerprint (idempotency) is computed by the consumer, not here.
 * `not_worthy` (push only) drops chatter. Discriminated on `decision` so a malformed shape fails parse.
 */
// The two correlated verdicts are shared by both paths; only not_worthy is push-exclusive. Defined
// once so the push (correlation) and mention schemas cannot drift apart.
const belongsToVerdict = z.object({ decision: z.literal('belongs_to'), index: z.number().int() });
const resolvesSignalVerdict = z.object({
  decision: z.literal('resolves_signal'),
  signalIndex: z.number().int(),
});
const newIncidentVerdict = z.object({
  decision: z.literal('new_incident'),
  service: z.string(),
  severity: z.enum(['sev1', 'sev2', 'sev3']),
  title: z.string(),
  purpose: z.enum(['incident', 'health_check']).optional(),
});

export const correlationVerdictSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('not_worthy') }),
  belongsToVerdict,
  resolvesSignalVerdict,
  newIncidentVerdict,
]);

export type CorrelationVerdict = z.infer<typeof correlationVerdictSchema>;

/** An unresolved signal the classifier may select without ever seeing its durable IDs. */
export interface ResolutionCandidate {
  id: string;
  incidentId: string;
  externalMessageId: string;
  channel: string;
  summary: string;
  service: string;
  title: string | null;
  severity: string;
  alertName?: string | null;
  providerGroupKey?: string | null;
  monitorKey?: string | null;
}

/** The mention pull path has no not_worthy verdict (a human is the gate): belongs_to | new_incident. */
export const mentionVerdictSchema = z.discriminatedUnion('decision', [
  belongsToVerdict,
  newIncidentVerdict,
]);

export type MentionVerdict = z.infer<typeof mentionVerdictSchema>;

/**
 * Render the candidate open incidents as opaque, 1-based `[n] service · severity · title` lines for the
 * LLM to select from. The incident id is deliberately NOT shown — the model returns the index, we
 * resolve the id (so a hallucinated id is structurally impossible; only an out-of-range index can
 * happen, guarded by resolveBelongsTo). An empty list renders as an empty string.
 */
export function buildCandidateBlock(candidates: IncidentSummary[]): string {
  return candidates
    .map(
      // Collapse whitespace in the (attacker-influenced) title to a single line so a title containing
      // a newline cannot forge an extra `[n]` row and misalign the index the model returns.
      (c, i) =>
        `[${i + 1}] ${c.service} · ${c.severity} · ${(c.title ?? '(untitled)').replace(/\s+/g, ' ')}`,
    )
    .join('\n');
}

/** Render only server-authorized recovery targets as opaque 1-based positions. */
export function buildResolutionCandidateBlock(candidates: ResolutionCandidate[]): string {
  return candidates
    .map((candidate, index) => {
      const summary = candidate.summary
        .replace(/\s+/g, ' ')
        .slice(0, RESOLUTION_SUMMARY_MAX_CHARACTERS);
      return `[${index + 1}] ${candidate.service} · ${candidate.severity} · ${(candidate.title ?? '(untitled)').replace(/\s+/g, ' ')} · ${summary}`;
    })
    .join('\n');
}

/**
 * Resolve a 1-based `belongs_to` index to the candidate's incident id, or null when the index is out
 * of range (a hallucinated selection ∉ the shown set) — the caller then treats it as new_incident.
 */
export function resolveBelongsTo(index: number, candidates: IncidentSummary[]): string | null {
  if (!Number.isInteger(index) || index < 1 || index > candidates.length) return null;
  return candidates[index - 1]!.id;
}

/** Resolve a recovery target inside the exact candidate list shown to the model. */
export function resolveSignalSelection<T extends ResolutionCandidate>(
  index: number,
  candidates: T[],
): T | null {
  if (!Number.isInteger(index) || index < 1 || index > candidates.length) return null;
  return candidates[index - 1]!;
}

function resolutionIdentityTokens(text: string): Set<string> {
  const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9._:/-]{5,}/g) ?? [];
  return new Set(
    tokens
      .map((token) =>
        token
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/^www\./, '')
          .replace(/[./:_-]+$/, ''),
      )
      .filter(
        (token) =>
          token.length >= 6 && !RESOLUTION_IDENTITY_STOP_WORDS.has(token) && !/^\d+$/.test(token),
      ),
  );
}

/** Require message-derived identity overlap before a model-selected signal may be mutated. */
export function resolutionSelectionSupported(
  message: string,
  candidate: ResolutionCandidate,
  candidates: ResolutionCandidate[],
): boolean {
  const messageTokens = resolutionIdentityTokens(message);
  if (messageTokens.size === 0) return false;
  const candidateTokens = resolutionIdentityTokens(
    `${candidate.service}\n${candidate.title ?? ''}\n${candidate.summary}`,
  );
  const otherTokens = new Set(
    candidates
      .filter((other) => other.id !== candidate.id)
      .flatMap((other) => [
        ...resolutionIdentityTokens(`${other.service}\n${other.title ?? ''}\n${other.summary}`),
      ]),
  );
  return [...messageTokens].some((token) => candidateTokens.has(token) && !otherTokens.has(token));
}

/** Require provider-neutral recovery wording and reject messages that explicitly say a signal persists. */
export function resolutionIntentSupported(message: string): boolean {
  const normalized = message.toLowerCase().replace(/[\s_-]+/g, ' ');
  const negatedRecovery =
    /\b(?:not|never)\b.{0,20}\b(?:healthy|resolved|recovered|restored|cleared)\b/.test(
      normalized,
    ) ||
    /\b(?:has|have|had|is|are|was|were|did)\s*n['’]?t\b.{0,20}\b(?:healthy|resolve(?:d)?|recover(?:ed)?|restore(?:d)?|clear(?:ed)?)\b/.test(
      normalized,
    ) ||
    /\b(?:failed|unable)\s+to\s+(?:resolve|recover|restore|clear)\b/.test(normalized) ||
    /\bdid\s+not\s+(?:resolve|recover|restore|clear)\b/.test(normalized);
  if (negatedRecovery) return false;
  const ongoing =
    /\b(?:still|remains?|continu(?:es|ing)|currently)\b.{0,24}\b(?:down|firing|failing|unhealthy|degraded|unavailable|critical)\b/.test(
      normalized,
    ) ||
    /\b(?:is|are)\b.{0,12}\b(?:still )?(?:down|firing|failing|unhealthy|degraded|unavailable|critical)\b/.test(
      normalized,
    );
  if (ongoing) return false;
  return /\b(?:resolved|recovered|restored|cleared|healthy|back (?:up|online|to normal)|went up|returned to normal)\b/.test(
    normalized,
  );
}
