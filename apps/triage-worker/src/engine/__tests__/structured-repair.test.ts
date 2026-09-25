import { describe, expect, test } from 'vitest';
import * as z from 'zod';
import { evidenceSliceSchema, reviewRecoverySchema } from '../evidence-review-contracts';
import { parseWithLengthRepair } from '../structured-repair';

const note = (text: string, evidenceIds = [crypto.randomUUID()]) => ({
  kind: 'observation' as const,
  text,
  evidenceIds,
});

describe('parseWithLengthRepair', () => {
  test('returns valid output unchanged', () => {
    const value = { complete: true, notes: [note('fine')] };
    expect(parseWithLengthRepair(evidenceSliceSchema, value)).toEqual(value);
  });

  test('trims an over-length nested string to the maximum with an ellipsis', () => {
    const raw = { complete: true, notes: [note('ok'), note('x'.repeat(900))] };
    const parsed = parseWithLengthRepair(evidenceSliceSchema, raw);
    expect(parsed.notes[1]!.text).toHaveLength(400);
    expect(parsed.notes[1]!.text.endsWith('…')).toBe(true);
    expect(parsed.notes[0]!.text).toBe('ok');
    // The caller's value is never mutated; only the parsed copy is trimmed.
    expect(raw.notes[1]!.text).toHaveLength(900);
  });

  test('never trims an over-long array, because dropping items drops findings', () => {
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    const raw = {
      complete: true,
      notes: Array.from({ length: 8 }, () => note('y'.repeat(401), ids)),
    };
    expect(() => parseWithLengthRepair(evidenceSliceSchema, raw)).toThrow(z.ZodError);
    const oneTooMany = { complete: true, notes: Array.from({ length: 7 }, () => note('ok')) };
    expect(() => parseWithLengthRepair(evidenceSliceSchema, oneTooMany)).toThrow(z.ZodError);
  });

  test('repairs a field inside a discriminated union branch', () => {
    const base = reviewRecoverySchema.parse({
      outcome: 'recovered',
      recovered: true,
      summary: 'Error rate returned to baseline.',
      evidence: [{ name: 'error rate', before: '12%', now: '0.1%' }],
      evidenceIds: [crypto.randomUUID()],
      unknowns: [],
      nextStep: 'Watch the next deploy.',
      recheckAfterMinutes: null,
      scheduleReason: null,
      questions: [],
    });
    const long = { ...base, nextStep: 'z'.repeat(5_000) };
    expect(() => reviewRecoverySchema.parse(long)).toThrow();
    const parsed = parseWithLengthRepair(reviewRecoverySchema, long);
    expect(parsed.nextStep?.endsWith('…')).toBe(true);
    expect(reviewRecoverySchema.parse(parsed)).toEqual(parsed);
  });

  test('throws the original error when any issue is not an over-length value', () => {
    const raw = { complete: 'yes', notes: [note('x'.repeat(900))] };
    const original = evidenceSliceSchema.safeParse(raw);
    expect(original.success).toBe(false);
    const error = (() => {
      try {
        parseWithLengthRepair(evidenceSliceSchema, raw);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(z.ZodError);
    expect((error as z.ZodError).issues).toEqual(original.error!.issues);
  });

  test('cuts at the last sentence end within the limit and adds no ellipsis', () => {
    const schema = z.object({ summary: z.string().max(100) });
    const first = `${'a'.repeat(40)}. ${'b'.repeat(30)}!`;
    const parsed = parseWithLengthRepair(schema, { summary: `${first} ${'c'.repeat(80)}.` });
    expect(parsed.summary).toBe(first);
  });

  test('cuts at a newline boundary', () => {
    const schema = z.object({ summary: z.string().max(100) });
    const first = `${'a'.repeat(70)}`;
    const parsed = parseWithLengthRepair(schema, { summary: `${first}\n${'b'.repeat(80)}` });
    expect(parsed.summary).toBe(first);
  });

  test('falls back to a hard cut with an ellipsis when the sentence end keeps under 60%', () => {
    const schema = z.object({ summary: z.string().max(100) });
    const parsed = parseWithLengthRepair(schema, {
      summary: `${'a'.repeat(50)}. ${'b'.repeat(120)}`,
    });
    expect(parsed.summary).toHaveLength(100);
    expect(parsed.summary).toBe(`${'a'.repeat(50)}. ${'b'.repeat(47)}…`);
  });

  test('keeps a sentence end exactly at 60% of the limit and hard-cuts one below it', () => {
    const schema = z.object({ summary: z.string().max(100) });
    const kept = `${'a'.repeat(59)}.`;
    expect(parseWithLengthRepair(schema, { summary: `${kept} ${'b'.repeat(80)}` }).summary).toBe(
      kept,
    );
    const below = parseWithLengthRepair(schema, {
      summary: `${'a'.repeat(58)}. ${'b'.repeat(80)}`,
    });
    expect(below.summary).toHaveLength(100);
    expect(below.summary.endsWith('…')).toBe(true);
  });

  test('a limit above 400 always hard-cuts with an ellipsis, even after a sentence end', () => {
    const schema = z.object({ detail: z.string().max(1000) });
    const parsed = parseWithLengthRepair(schema, {
      detail: `${'a'.repeat(899)}. ${'b'.repeat(600)}`,
    });
    expect(parsed.detail).toHaveLength(1000);
    expect(parsed.detail.endsWith('…')).toBe(true);
  });

  test('ignores a period without following whitespace, such as a version or hostname', () => {
    const schema = z.object({ summary: z.string().max(100) });
    const parsed = parseWithLengthRepair(schema, { summary: `v1.2.3 ${'x'.repeat(200)}` });
    expect(parsed.summary.endsWith('…')).toBe(true);
    expect(parsed.summary).toHaveLength(100);
  });

  test('does not repair numeric limits', () => {
    const schema = z.object({ confidence: z.number().max(100) });
    expect(() => parseWithLengthRepair(schema, { confidence: 250 })).toThrow(z.ZodError);
  });
});
