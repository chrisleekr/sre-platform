// Blameless by construction (Google SRE Ch 15): a generated postmortem never names a human as a
// cause. The prompt forbids it; this guard enforces it over the identifiers the platform can actually
// know, plus any email-shaped token at all. Honest limit: a bare first name typed in chat that is not
// a member email local-part is not catchable here, and the prompt is the only defence for it.

/** Trusted instruction for postmortem generation; the transcript is untrusted data in the prompt. */
export const BLAMELESS_SYSTEM_PROMPT = [
  'You write blameless incident postmortems in the style of the Google SRE book, chapter 15.',
  'Never name, identify or allude to an individual person as a cause, contributor or actor: no names,',
  'no email addresses, no chat handles, no mentions, no roles that identify one person. Refer to people',
  'only as "a responder", "the on-call engineer" or "the team". Contributing causes are systemic:',
  'processes, tooling, monitoring, capacity, design and change management. Action items are typed',
  'prevent (stop recurrence), mitigate (shrink blast radius) or process (change how people work).',
  'Do not invent facts absent from the material; when something is unknown, say so.',
].join(' ');

const REPLACEMENT = 'a responder';
const MIN_LOCAL_PART = 3;
// Includes the labelled form `<@U123|alice>` so the label never survives as residue; group 1 is the
// label. The label excludes `<`, `>`, `|` and newlines and is length-bounded so a stray `<@X|`
// opener can neither swallow text up to an unrelated `>` nor make the scan quadratic (CWE-1333).
const SLACK_MENTION = /<@[A-Z0-9]+(?:\|([^<>|\n]{0,256}))?>/gu;
// Any email, member or not (a vendor contact in the transcript is still a person). Local part
// bounded to 64 octets (RFC 5321 section 4.5.3.1), each domain label to 63 octets (RFC 1035 section
// 2.3.4); the label count is a local backtracking bound, not an RFC limit (CWE-1333).
const EMAIL = /\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}\b/gu;
// A handle is a bare @token; an email's domain half never matches because emails are removed first.
// The lookbehind admits `<`, so the `@U123` inside `<@U123>` also matches. Intended: a model that
// echoes the id without brackets is still caught.
const HANDLE = /(?<![\w.])@[\w][\w.-]*/gu;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds the identifier set a transcript can leak: member emails, their local parts, and every
 * mention token seen in the material. Longest first so an email is removed before its local part.
 *
 * @param memberEmails - Emails of the tenant's members.
 * @param material - Transcript and incident text the generator saw.
 */
export function collectHumanIdentifiers(memberEmails: string[], material: string): string[] {
  const found = new Set<string>();
  for (const email of memberEmails) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) continue;
    found.add(normalized);
    const local = normalized.split('@')[0] ?? '';
    if (local.length >= MIN_LOCAL_PART) found.add(local);
  }
  for (const mention of material.matchAll(SLACK_MENTION)) {
    found.add(mention[0]);
    // The readable name after the pipe is a human identifier the platform can see.
    const label = mention[1]?.trim().toLowerCase() ?? '';
    if (label.length >= MIN_LOCAL_PART) found.add(label);
  }
  for (const token of material.match(HANDLE) ?? []) found.add(token.toLowerCase());
  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * Replaces every known human identifier, every email and every mention token in generated prose
 * with a neutral noun. Case-insensitive and bounded so "alice" is caught but "malice" is not.
 *
 * @param text - Generated prose.
 * @param identifiers - Output of collectHumanIdentifiers.
 */
export function stripHumanIdentifiers(text: string, identifiers: readonly string[]): string {
  // Mentions go first: the identifier loop would otherwise strip the `@U123` inside a labelled
  // mention the material never showed, leaving `<a responder|alice>` with the label intact.
  let result = text.replace(SLACK_MENTION, REPLACEMENT);
  for (const identifier of identifiers) {
    const pattern = new RegExp(`(?<![\\w.-])${escapeRegExp(identifier)}(?![\\w-])`, 'giu');
    result = result.replace(pattern, REPLACEMENT);
  }
  return result.replace(EMAIL, REPLACEMENT).replace(HANDLE, REPLACEMENT);
}
