import { randomUUID } from 'node:crypto';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { expect, test } from 'vitest';
import * as z from 'zod';
import { makeAgentSdkGenerator } from '../agent-sdk';
import {
  EVIDENCE_REVIEW_INSTRUCTION,
  evidenceReviewSchema,
  reviewInvestigation,
} from '../evidence-review';
import { makeFakeGenerator } from '../fake';
import type { TriageResult } from '../types';
import { createFixture } from './agent-sdk.fixture';

const fixture = createFixture();
const id = randomUUID();
const evidence = {
  id,
  tool: 'query_metrics',
  input: {},
  output: 'Current latency 40 ms.',
  outcome: 'data',
  createdAt: new Date(),
};
const candidate: TriageResult = {
  provider: 'fake',
  sessionId: 'final-review',
  outcome: 'conclusive',
  disposition: 'recovery',
  turnBudget: 1,
  summary: 'Current health requires review.',
  confidence: 0,
};
const blocker = {
  question: 'Is the configured recovery window healthy?',
  category: 'partial_evidence',
  evidenceKind: 'metrics',
  attemptedEvidenceIds: [id],
  resolutionRelevance: 'blocking',
  nextAction: 'Check the complete configured recovery window.',
};
const correction = (outcome: 'recovered' | 'recheck' | 'needs_human') => ({
  outcome,
  recovered: outcome === 'recovered',
  summary: 'Current service observations reviewed.',
  evidence: [{ name: 'Current latency', before: null, now: '40 ms' }],
  evidenceIds: [id],
  questions: outcome === 'needs_human' ? [blocker] : [],
  unknowns: [],
  nextStep: null,
  recheckAfterMinutes: outcome === 'recheck' ? 5 : null,
  scheduleReason: outcome === 'recheck' ? 'Observe the configured recovery window.' : null,
});
const response = {
  supported: false,
  summary: 'The configured recovery window has not been verified.',
  rejection: 'insufficient_evidence',
  evidenceIds: [id],
};
const sdkGenerator = (value: unknown, capture: (options: Options | undefined) => void = () => {}) =>
  makeAgentSdkGenerator({
    runtime: fixture.runtime,
    credential: 'test-key',
    query: fixture.scriptedQuery(
      [fixture.result({ structured_output: { result: value } })],
      capture,
    ),
  });

type Schema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  $ref?: string;
  [key: string]: unknown;
};
const resolve = (node: Schema, root: Schema): Schema => {
  if (!node.$ref) return node;
  expect(node.$ref.startsWith('#/')).toBe(true);
  return node.$ref
    .slice(2)
    .split('/')
    .reduce((value, key) => value[key.replaceAll('~1', '/').replaceAll('~0', '~')] as Schema, root);
};
const branches = (node: Schema, root: Schema): Schema[] => {
  const current = resolve(node, root);
  return (current.anyOf ?? current.oneOf)?.flatMap((item) => branches(item, root)) ?? [current];
};

test('actual Agent SDK final output format excludes reason and accepts a summary-only response', async () => {
  let options: Options | undefined;
  const output = sdkGenerator(response, (value) => {
    options = value;
  }).generate('Review current evidence.', evidenceReviewSchema, {
    system: EVIDENCE_REVIEW_INSTRUCTION,
  });
  await expect(output).resolves.toEqual(response);
  const schema = options!.outputFormat!.schema as Schema;
  const result = resolve(schema.properties!.result!, schema);
  expect(result.properties).not.toHaveProperty('reason');
  expect(result.required).toEqual(expect.arrayContaining(['supported', 'summary', 'evidenceIds']));
  expect(result.required).not.toContain('reason');
});

test('actual provider corrected recovery branches bind outcome to null or nonnull scheduling', async () => {
  let options: Options | undefined;
  await sdkGenerator(
    { ...response, reason: 'Compatibility input is not the requested contract.' },
    (value) => {
      options = value;
    },
  ).generate('Review.', evidenceReviewSchema);
  const schema = options!.outputFormat!.schema as Schema;
  const final = resolve(schema.properties!.result!, schema);
  const reports = branches(final.properties!.correctedRecovery!, schema);
  const matrix = reports.flatMap((report) => {
    const outcome = resolve(report.properties!.outcome!, schema);
    const values = outcome.enum ?? (Object.hasOwn(outcome, 'const') ? [outcome.const] : []);
    return values.map((value) => ({
      value,
      delay: resolve(report.properties!.recheckAfterMinutes!, schema).type,
      reason: resolve(report.properties!.scheduleReason!, schema).type,
      required: report.required,
    }));
  });
  expect(matrix).toEqual(
    expect.arrayContaining([
      {
        value: 'recovered',
        delay: 'null',
        reason: 'null',
        required: expect.arrayContaining(['outcome', 'recheckAfterMinutes', 'scheduleReason']),
      },
      {
        value: 'needs_human',
        delay: 'null',
        reason: 'null',
        required: expect.arrayContaining(['outcome', 'recheckAfterMinutes', 'scheduleReason']),
      },
      {
        value: 'recheck',
        delay: 'integer',
        reason: 'string',
        required: expect.arrayContaining(['outcome', 'recheckAfterMinutes', 'scheduleReason']),
      },
    ]),
  );
  expect(JSON.stringify(schema)).not.toMatch(/"(?:minimum|maximum|minLength|maxLength)":/);
});

test('Agent SDK preserves scalar discriminators through nested items and recursive schema references', async () => {
  type Item = { kind: 'leaf'; state: 'healthy' | 'unknown' } | { kind: 'branch'; children: Item[] };
  const item: z.ZodType<Item> = z.lazy(() =>
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('leaf'), state: z.enum(['healthy', 'unknown']) }),
      z.object({ kind: z.literal('branch'), children: z.array(item) }),
    ]),
  );
  let options: Options | undefined;
  const value = { kind: 'branch', children: [{ kind: 'leaf', state: 'healthy' }] };
  await expect(
    sdkGenerator(value, (captured) => {
      options = captured;
    }).generate('Structured tree.', item),
  ).resolves.toEqual(value);
  const schema = options!.outputFormat!.schema as Schema;
  const variants = branches(schema.properties!.result!, schema);
  const leaf = variants.find(
    (variant) => resolve(variant.properties!.kind!, schema).const === 'leaf',
  );
  const branch = variants.find(
    (variant) => resolve(variant.properties!.kind!, schema).const === 'branch',
  );
  expect(leaf).toBeDefined();
  expect(branch).toBeDefined();
  expect(resolve(leaf!.properties!.state!, schema).enum).toEqual(['healthy', 'unknown']);
  const child = resolve(branch!.properties!.children!, schema).items!;
  expect(child.$ref).toBeDefined();
  expect(branches(child, schema)).toEqual(variants);
});

test.each(['single', 'synthesis'] as const)(
  '%s unsupported summary is kept as the answer and never recorded as an open question',
  async (stage) => {
    for (const rejection of ['insufficient_evidence', 'contradictory_evidence']) {
      const summary = `${'Current observations are incomplete. '.repeat(7)}The configured recovery criterion remains unverified.`;
      expect(summary.length).toBeGreaterThan(240);
      expect(summary.length).toBeLessThanOrEqual(360);
      const result = await reviewInvestigation(
        makeFakeGenerator((prompt) =>
          JSON.parse(prompt).evidenceSlices
            ? {
                complete: true,
                notes: [
                  {
                    kind: 'uncertainty',
                    text: 'The recovery window is incomplete.',
                    evidenceIds: [id],
                  },
                ],
              }
            : { ...response, summary, rejection },
        ),
        candidate,
        [{ ...evidence, output: stage === 'single' ? 'Healthy sample.' : 'x'.repeat(240_000) }],
        new AbortController().signal,
        undefined,
        new Set([id]),
      );
      const question =
        rejection === 'contradictory_evidence'
          ? 'Evidence review found an unresolved contradiction but named no specific check.'
          : 'Evidence review found the conclusion unsupported but named no specific missing proof.';
      expect(result).toMatchObject({
        outcome: 'inconclusive',
        summary,
        evidenceIds: [id],
        recovery: {
          outcome: 'needs_human',
          recovered: false,
          unknowns: [question],
          questions: [
            {
              question,
              attemptedEvidenceIds: [id],
              category:
                rejection === 'contradictory_evidence'
                  ? 'contradictory_evidence'
                  : 'partial_evidence',
            },
          ],
        },
      });
    }
  },
);

test.each(['recovered', 'recheck', 'needs_human'] as const)(
  'accepts a complete corrected %s report without reason',
  async (outcome) => {
    const report = correction(outcome);
    const { summary, ...recovery } = report;
    const result = await reviewInvestigation(
      sdkGenerator({ ...response, correctedRecovery: report }),
      candidate,
      [evidence],
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      outcome: 'conclusive',
      summary,
      recovery: {
        ...recovery,
        unknowns: report.questions.map((question) => question.question),
      },
    });
  },
);

test('supported review and complete corrected reply do not depend on a redundant rationale', async () => {
  const reply = { ...candidate, disposition: 'reply' as const, detail: 'An unchecked claim.' };
  expect(
    await reviewInvestigation(
      sdkGenerator({ supported: true, summary: 'Supported.', evidenceIds: [id] }),
      reply,
      [evidence],
      new AbortController().signal,
    ),
  ).toEqual(reply);
  const detail = `# Read-only diagnostic guide\n${'Compare the configured recovery window and preserve uncertainty.\n'.repeat(40)}`;
  const result = await reviewInvestigation(
    sdkGenerator({ ...response, detail }),
    reply,
    [evidence],
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    outcome: 'inconclusive',
    summary: response.summary,
    detail,
    evidenceIds: [id],
  });
});

test('an unsolicited obsolete reason is ignored rather than validated or persisted', async () => {
  const value = { ...response, reason: 'obsolete rationale '.repeat(200) };
  await expect(sdkGenerator(value).generate('Review.', evidenceReviewSchema)).resolves.toEqual(
    response,
  );
});

test.each([360, 361])(
  'Agent SDK retains local summary validation at %i characters',
  async (length) => {
    const summary = 's'.repeat(length);
    const result = sdkGenerator({ ...response, summary, reason: 'Compatibility input.' }).generate(
      'Review.',
      evidenceReviewSchema,
    );
    if (length === 360) await expect(result).resolves.toMatchObject({ summary });
    else
      await expect(result).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'too_big', path: ['result', 'summary'] }),
        ]),
      });
  },
);

test('corrected recovery keeps semantic and scheduling rejection even with an otherwise valid summary', () => {
  const full = (report: unknown) => ({
    ...response,
    reason: 'Compatibility input.',
    correctedRecovery: report,
  });
  for (const outcome of ['recovered', 'needs_human'] as const) {
    expect(evidenceReviewSchema.safeParse(full(correction(outcome))).success).toBe(true);
    for (const schedule of [{ recheckAfterMinutes: 5 }, { scheduleReason: 'Invalid scheduling.' }])
      expect(
        evidenceReviewSchema.safeParse(full({ ...correction(outcome), ...schedule })).success,
      ).toBe(false);
  }
  for (const delay of [1, 60])
    expect(
      evidenceReviewSchema.safeParse(full({ ...correction('recheck'), recheckAfterMinutes: delay }))
        .success,
    ).toBe(true);
  for (const invalid of [
    { ...correction('recheck'), recheckAfterMinutes: null },
    { ...correction('recheck'), scheduleReason: null },
    { ...correction('recheck'), recheckAfterMinutes: undefined },
    { ...correction('recheck'), scheduleReason: undefined },
    { ...correction('recheck'), recheckAfterMinutes: 0 },
    { ...correction('recheck'), recheckAfterMinutes: 61 },
    { ...correction('recheck'), scheduleReason: '' },
    { ...correction('recheck'), scheduleReason: 'x'.repeat(241) },
    { ...correction('recovered'), questions: [blocker] },
    { ...correction('needs_human'), questions: [] },
    { ...correction('recovered'), recovered: false },
  ])
    expect(evidenceReviewSchema.safeParse(full(invalid)).success).toBe(false);
});

test.each(['foreign', 'unavailable'] as const)(
  'a valid corrected recovery cannot promote %s evidence',
  async (kind) => {
    const report = {
      ...correction('recovered'),
      evidenceIds: [kind === 'foreign' ? randomUUID() : id],
    };
    const result = await reviewInvestigation(
      sdkGenerator({ ...response, reason: 'Compatibility input.', correctedRecovery: report }),
      candidate,
      [{ ...evidence, outcome: kind === 'unavailable' ? 'error' : 'data' }],
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      outcome: 'inconclusive',
      recovery: { outcome: 'needs_human', recovered: false },
    });
    expect(result.recovery?.questions?.[0]?.question).toMatch(/foreign|unavailable/);
  },
);

test('a recovery rejection keeps reviewer gaps as blocking questions and uses its next step', async () => {
  const result = await reviewInvestigation(
    makeFakeGenerator(() => ({
      ...response,
      rejection: 'contradictory_evidence',
      gaps: ['Reconcile the 40 ms reading with the 09:30Z timeout.', 'Confirm error rate.'],
      nextStep: 'Query the error rate over the configured recovery window.',
    })),
    candidate,
    [evidence],
    new AbortController().signal,
    undefined,
    new Set([id]),
  );
  expect(result.recovery).toMatchObject({
    outcome: 'needs_human',
    unknowns: ['Reconcile the 40 ms reading with the 09:30Z timeout.', 'Confirm error rate.'],
    nextStep: 'Query the error rate over the configured recovery window.',
  });
  expect(result.recovery?.questions).toEqual(
    ['Reconcile the 40 ms reading with the 09:30Z timeout.', 'Confirm error rate.'].map(
      (question) => ({
        question,
        category: 'contradictory_evidence',
        evidenceKind: null,
        attemptedEvidenceIds: [id],
        resolutionRelevance: 'blocking',
        nextAction: 'Query the error rate over the configured recovery window.',
      }),
    ),
  );
});
