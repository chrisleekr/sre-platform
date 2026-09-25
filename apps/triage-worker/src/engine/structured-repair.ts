import type { ZodType } from 'zod';
import type { StructuredGenerationOptions } from './types';

/** Arrays and objects share property-key access, so one record view covers both containers on the path. */
function container(value: unknown): Record<PropertyKey, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<PropertyKey, unknown>)
    : null;
}

/** Longest limit treated as a short responder-facing field, such as a summary, gap or next step. */
const SENTENCE_CUT_MAX = 400;

/**
 * Cuts text to at most `max` characters. For a short field (`max` of at most 400) it prefers the
 * last complete sentence (ending in ". ", "! ", "? " or a newline) when that keeps at least 60% of
 * `max`, because a responder-facing line cut mid-sentence reads as a broken claim. Longer fields,
 * and short ones without such a boundary, cut hard and mark the cut with an ellipsis so it is
 * visible.
 */
function trimToLength(value: string, max: number): string {
  if (max > SENTENCE_CUT_MAX) return `${value.slice(0, Math.max(0, max - 1))}…`;
  const window = value.slice(0, max + 1);
  let end = -1;
  for (const match of window.matchAll(/[.!?](?=\s)|\n/g)) {
    const cut = match[0] === '\n' ? match.index : match.index + 1;
    if (cut <= max) end = cut;
  }
  if (end >= Math.ceil(max * 0.6)) return value.slice(0, end).trimEnd();
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Parses provider output; when every issue is an over-length string, trims those strings to the
 * schema maximum and parses once more. For limits of at most 400 characters a trim keeps whole
 * sentences when the last sentence end within the limit keeps at least 60% of it; otherwise, and
 * for every longer limit, it cuts hard with a trailing ellipsis.
 * Providers do not enforce length limits (strict tools drop them), and a long note is not evidence
 * against a conclusion. Over-length arrays are never trimmed: dropping items silently drops
 * findings such as a contradiction note. Any other issue, or a value that still fails after
 * trimming, throws the original validation error.
 *
 * @param schema - Caller's zod schema, the only authority on the accepted shape.
 * @param raw - Untrusted provider output.
 */
export function parseWithLengthRepair<T>(schema: ZodType<T>, raw: unknown): T {
  const first = schema.safeParse(raw);
  if (first.success) return first.data;
  const trims = first.error.issues.flatMap((issue) =>
    issue.code === 'too_big' &&
    issue.origin === 'string' &&
    typeof issue.maximum === 'number' &&
    issue.path.length > 0
      ? [{ path: issue.path, max: issue.maximum }]
      : [],
  );
  if (trims.length === 0 || trims.length !== first.error.issues.length) throw first.error;
  const copy: unknown = structuredClone(raw);
  for (const { path, max } of trims) {
    let parent = container(copy);
    for (const key of path.slice(0, -1)) parent = container(parent?.[key]);
    if (!parent) continue;
    const key = path.at(-1)!;
    const value = parent[key];
    if (typeof value === 'string') parent[key] = trimToLength(value, max);
  }
  const repaired = schema.safeParse(copy);
  if (repaired.success) return repaired.data;
  throw first.error;
}

/**
 * Parses generator output, trimming over-length strings only when the caller opted in.
 *
 * @param schema - Caller's zod schema.
 * @param raw - Untrusted provider output.
 * @param options - Generation options; `repairOverlength` selects the repairing parse.
 */
export function parseStructuredOutput<T>(
  schema: ZodType<T>,
  raw: unknown,
  options?: StructuredGenerationOptions,
): T {
  return options?.repairOverlength ? parseWithLengthRepair(schema, raw) : schema.parse(raw);
}
