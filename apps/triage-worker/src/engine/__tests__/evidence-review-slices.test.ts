import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { ZodType } from 'zod';
import { evidenceReviewSchema, reviewInvestigation } from '../evidence-review';
import { ProviderRateLimitError, type StructuredGenerator, type TriageResult } from '../types';

const evidenceId = randomUUID();
const candidate: TriageResult = {
  provider: 'fake',
  sessionId: 'slice-review',
  outcome: 'conclusive',
  disposition: 'reply',
  turnBudget: 1,
  summary: 'The observed service state is understood.',
  confidence: 70,
};
const source = {
  id: evidenceId,
  tool: 'query_metrics',
  input: {},
  outcome: 'data',
  createdAt: new Date('2026-09-20T01:00:00Z'),
  output: 'x'.repeat(240_000),
};
const finalReview = {
  supported: true,
  summary: 'All admitted observations were reviewed.',
  reason: 'The observations support the candidate.',
  evidenceIds: [evidenceId],
};
const note = (text = 'At 01:00 UTC the observed latency was 40 ms.') => ({
  kind: 'observation',
  text,
  evidenceIds: [evidenceId],
});
const compact = { complete: true, notes: [note()] };
const generatorFor = (
  script: (prompt: string, schema: ZodType, system: string) => unknown,
): StructuredGenerator => ({
  async generate(prompt, schema, options) {
    return schema.parse(script(prompt, schema, options?.system ?? ''));
  },
});

test('schema-valid final-style slice output is replaced by compact notes before final synthesis', async () => {
  const schemas: ZodType[] = [];
  const sliceInstructions: string[] = [];
  const admittedNotes: unknown[] = [];
  let synthesized = false;
  expect(
    evidenceReviewSchema.safeParse({ ...finalReview, detail: 'd'.repeat(5_000) }).success,
  ).toBe(true);
  const result = await reviewInvestigation(
    generatorFor((prompt, schema, system) => {
      const payload = JSON.parse(prompt);
      if (payload.evidenceSlices) {
        schemas.push(schema);
        sliceInstructions.push(system);
        if (!schema.safeParse(compact).success)
          return { ...finalReview, detail: 'd'.repeat(5_000) };
        const response = {
          complete: true,
          notes: [note(`Slice ${schemas.length} records 01:00 UTC, 40 ms.`)],
        };
        admittedNotes.push(response);
        return response;
      }
      synthesized = true;
      expect(payload.reviewedEvidence.map((item: { review: unknown }) => item.review)).toEqual(
        admittedNotes,
      );
      expect(schema.safeParse({ ...finalReview, detail: 'd'.repeat(5_000) }).success).toBe(true);
      return finalReview;
    }),
    candidate,
    [source],
    new AbortController().signal,
  );
  expect(result.outcome).toBe('conclusive');
  expect(synthesized).toBe(true);
  expect(schemas.length).toBeGreaterThan(1);
  expect(schemas.every((schema) => schema.safeParse(compact).success)).toBe(true);
  expect(
    schemas.every((schema) => !schema.safeParse({ ...compact, supported: true }).success),
  ).toBe(true);
  expect(
    schemas.every((schema) => !schema.safeParse({ ...compact, correctedRecovery: {} }).success),
  ).toBe(true);
  expect(
    sliceInstructions.every(
      (instruction) => !instruction.includes('Return correctedRecovery only'),
    ),
  ).toBe(true);
});

test('six ordinary maximum-length notes and citations reach synthesis without relaxing field bounds', async () => {
  let captured: ZodType | undefined;
  const maximum = {
    complete: true,
    notes: Array.from({ length: 6 }, () => ({
      ...note('a'.repeat(400)),
      evidenceIds: [evidenceId, evidenceId, evidenceId],
    })),
  };
  expect(JSON.stringify(maximum).length).toBeLessThanOrEqual(4_000);
  const result = await reviewInvestigation(
    generatorFor((prompt, schema) => {
      if (JSON.parse(prompt).evidenceSlices) {
        captured = schema;
        return maximum;
      }
      return finalReview;
    }),
    candidate,
    [source],
    new AbortController().signal,
  );
  expect(result.outcome).toBe('conclusive');
  expect(captured).toBeDefined();
  for (const invalid of [
    { ...maximum, notes: [...maximum.notes, note()] },
    { complete: true, notes: [note('a'.repeat(401))] },
    { complete: true, notes: [note('')] },
    { complete: true, notes: [{ ...note(), kind: 'verdict' }] },
    { complete: true, notes: [{ ...note(), evidenceIds: [] }] },
    { complete: true, notes: [{ ...note(), evidenceIds: Array(4).fill(evidenceId) }] },
    { complete: true, notes: [{ ...note(), evidenceIds: ['fabricated'] }] },
  ])
    expect(captured!.safeParse(invalid).success).toBe(false);
});

test.each(['"', '\\', '\n', '\r', '\t', '\b', '\f', '\u0000'])(
  'rejects field-valid notes whose %j escapes exceed the serialized cap without truncation or synthesis',
  async (escape) => {
    const response = {
      complete: true,
      notes: Array.from({ length: 6 }, () => note(escape.repeat(400))),
    };
    const serialized = JSON.stringify(response);
    expect(serialized.length).toBeGreaterThan(4_000);
    let calls = 0;
    let fieldValid = false;
    const result = await reviewInvestigation(
      generatorFor((_prompt, schema) => {
        calls++;
        fieldValid = schema.safeParse(response).success;
        return response;
      }),
      candidate,
      [source],
      new AbortController().signal,
    );
    expect(fieldValid).toBe(true);
    expect(calls).toBe(1);
    expect(result.outcome).toBe('inconclusive');
    expect(JSON.stringify(response)).toBe(serialized);
    const diagnostic = result.unknowns?.at(-1)?.question ?? '';
    expect(diagnostic).toMatch(/slice/i);
    expect(diagnostic).toContain(String(serialized.length));
    expect(diagnostic).toContain('4000');
  },
);

test.each(['incomplete', 'foreign', 'final verdict'])(
  'does not synthesize a slice that is %s',
  async (failure) => {
    let calls = 0;
    const response =
      failure === 'incomplete'
        ? { ...compact, complete: false }
        : failure === 'foreign'
          ? { complete: true, notes: [{ ...note(), evidenceIds: [randomUUID()] }] }
          : { ...compact, supported: true };
    const result = await reviewInvestigation(
      generatorFor(() => {
        calls++;
        return response;
      }),
      candidate,
      [source],
      new AbortController().signal,
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({ outcome: 'inconclusive', confidence: 0 });
    expect(result.unknowns?.at(-1)?.question).toMatch(/slice/i);
  },
);

test('single-call review retains the complete final schema', async () => {
  let calls = 0;
  let fullAccepted = false;
  let compactAccepted = true;
  const result = await reviewInvestigation(
    generatorFor((_prompt, schema) => {
      calls++;
      fullAccepted = schema.safeParse({ ...finalReview, detail: 'd'.repeat(5_000) }).success;
      compactAccepted = schema.safeParse(compact).success;
      return finalReview;
    }),
    candidate,
    [{ ...source, output: 'Current latency is 40 ms.' }],
    new AbortController().signal,
  );
  expect(result.outcome).toBe('conclusive');
  expect(calls).toBe(1);
  expect(fullAccepted).toBe(true);
  expect(compactAccepted).toBe(false);
});

test.each(['slice', 'synthesis'] as const)(
  'propagates rate limits at %s without retries',
  async (stage) => {
    let calls = 0;
    let slices = 0;
    await expect(
      reviewInvestigation(
        generatorFor((prompt, schema) => {
          calls++;
          const isSlice = Boolean(JSON.parse(prompt).evidenceSlices);
          if (isSlice) slices++;
          if ((stage === 'slice' && isSlice) || (stage === 'synthesis' && !isSlice))
            throw new ProviderRateLimitError();
          return schema.safeParse(compact).success ? compact : finalReview;
        }),
        candidate,
        [source],
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(calls).toBe(stage === 'slice' ? 1 : slices + 1);
    expect(calls).toBeLessThanOrEqual(7);
  },
);

test.each(['before', 'slice', 'synthesis'] as const)(
  'honors the shared abort at %s without another call',
  async (stage) => {
    const controller = new AbortController();
    const reason = new Error('shared deadline');
    let calls = 0;
    let slices = 0;
    let identicalSignal = true;
    const generator: StructuredGenerator = {
      async generate(prompt, schema, options) {
        calls++;
        identicalSignal &&= options?.signal === controller.signal;
        const isSlice = Boolean(JSON.parse(prompt).evidenceSlices);
        if (isSlice) slices++;
        if ((stage === 'slice' && isSlice) || (stage === 'synthesis' && !isSlice))
          controller.abort(reason);
        return schema.parse(schema.safeParse(compact).success ? compact : finalReview);
      },
    };
    if (stage === 'before') controller.abort(reason);
    await expect(
      reviewInvestigation(generator, candidate, [source], controller.signal),
    ).rejects.toBe(reason);
    expect(calls).toBe(stage === 'before' ? 0 : stage === 'slice' ? 1 : slices + 1);
    expect(identicalSignal).toBe(true);
  },
);
