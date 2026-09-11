import { describe, expect, test, vi } from 'vitest';
import type { Db, ModelGradeInput } from '@sre/db';
import type { PostmortemDetail } from '@sre/contracts';
import { RetryableError, type Job } from '@sre/queue';
import { ProviderUnavailableError, type StructuredGenerator } from '../engine/types';
import { makeGradeHandler, type GradedRun } from '../grade-consumer';
import type { LlmRuntimeManager } from '../llm-runtime';
import { INTERNAL_REFERENCE } from './internal-reference.fixture';

// the assessment-grade consumer. Grades only a published postmortem against a pinned run that
// claimed a confidence; a model verdict lands on the grade row and nothing else changes. Hermetic
// stub-unit like runbook-consumer.test.ts.
const FAIL_MAX = 5;
const stubDb = {} as unknown as Db;

const detail = (status: 'draft' | 'published' = 'published'): PostmortemDetail => ({
  postmortem: {
    id: 'pm-1',
    incidentId: 'inc-1',
    status,
    trigger: 'slow_resolution',
    revision: 1,
    assessmentRunId: 'run-1',
    requestedByUserId: null,
    publishedByUserId: status === 'published' ? 'u1' : null,
    publishedAt: status === 'published' ? '2026-09-01T12:00:00Z' : null,
    createdAt: '2026-09-01T11:00:00Z',
    updatedAt: '2026-09-01T12:00:00Z',
    summary: 'Checkout degraded.',
    impact: 'Payments failed.',
    contributingCauses: [{ cause: 'Pool undersized.', evidenceIds: [] }],
    triggerNarrative: 'Traffic spike.',
    resolution: 'Pool raised.',
    detection: 'Monitor.',
    lessons: { wentWell: [], wentWrong: [], lucky: [] },
    timeline: [],
    supportingInformation: null,
  },
  actionItems: [],
  grade: null,
});

const run = (over: Partial<GradedRun> = {}): GradedRun => ({
  id: 'run-1',
  incidentId: 'inc-1',
  result: {
    summary: 'pool exhausted',
    confidence: 85,
    rankedHypotheses: [{ hypothesis: 'pool exhaustion', confidence: 85 }],
  },
  ...over,
});

const job = (over: Partial<Job> = {}): Job => ({
  id: 'job-9',
  tenantId: 'tenant-1',
  type: 'assessment.grade',
  attempts: 1,
  payload: { incidentId: 'inc-1', runId: 'run-1' },
  ...over,
});

function setup(opts: {
  verdict?: { verdict: string; rationale: string };
  generateThrows?: Error;
  detail?: PostmortemDetail | null;
  run?: GradedRun | null;
  memberEmails?: string[];
  llm?: LlmRuntimeManager;
}) {
  const generate = vi.fn<(prompt: string, schema: unknown) => Promise<unknown>>();
  if (opts.generateThrows) generate.mockRejectedValue(opts.generateThrows);
  else
    generate.mockResolvedValue(
      opts.verdict ?? { verdict: 'correct', rationale: `Matches ${INTERNAL_REFERENCE} cause.` },
    );
  // The single generator-spy cast (precedent: runbook-consumer.test.ts).
  const generator = { generate } as unknown as StructuredGenerator;
  const upsertModelGrade = vi.fn<(tenantId: string, input: ModelGradeInput) => Promise<boolean>>(
    async () => true,
  );
  const handler = makeGradeHandler({
    llm: opts.llm,
    generator,
    appDb: stubDb,
    getPostmortemDetail: async () => (opts.detail === undefined ? detail() : opts.detail),
    getInvestigationRunById: async () => (opts.run === undefined ? run() : opts.run),
    upsertModelGrade,
    listMemberEmails: async () => opts.memberEmails ?? [],
  });
  return { handler, generate, upsertModelGrade };
}

describe('makeGradeHandler', () => {
  test('passes the attempt signal to the runtime and rethrows an aborted provider call', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const execute = vi.fn(async (meta, run) => {
      expect(meta.signal).toBe(controller.signal);
      controller.abort(reason);
      return run({
        generator: {
          generate: vi.fn(async () => {
            throw reason;
          }),
        },
      } as never);
    });
    const { handler, upsertModelGrade } = setup({
      llm: { execute } as unknown as LlmRuntimeManager,
    });

    await expect(handler(job(), { signal: controller.signal })).rejects.toBe(reason);
    expect(upsertModelGrade).not.toHaveBeenCalled();
  });

  test('grades a published postmortem and upserts only the model verdict, rationale made public', async () => {
    const { handler, generate, upsertModelGrade } = setup({});
    await expect(handler(job())).resolves.toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toContain('Pool undersized.');
    expect(generate.mock.calls[0]![0]).toContain('pool exhaustion');
    expect(upsertModelGrade).toHaveBeenCalledWith('tenant-1', {
      incidentId: 'inc-1',
      runId: 'run-1',
      verdict: 'correct',
      rationale: `Matches ${INTERNAL_REFERENCE} cause.`,
    });
  });

  test('a partial verdict flows through, and the rationale never names a person the prompt showed', async () => {
    const { handler, upsertModelGrade } = setup({
      memberEmails: ['alice@example.com'],
      run: run({
        result: {
          summary: 'alice@example.com said the pool was exhausted; bob@vendor.com disagreed',
          confidence: 85,
          rankedHypotheses: [{ hypothesis: 'pool exhaustion', confidence: 85 }],
        },
      }),
      verdict: {
        verdict: 'partial',
        rationale:
          'Alice and alice@example.com blamed the pool; bob@vendor.com had the real cause.',
      },
    });
    await expect(handler(job())).resolves.toBeUndefined();
    const input = upsertModelGrade.mock.calls[0]![1];
    expect(input.verdict).toBe('partial');
    expect(input.rationale).not.toMatch(/alice|bob/iu);
    expect(input.rationale).toBe(
      'a responder and a responder blamed the pool; a responder had the real cause.',
    );
  });

  test('is a no-op for a draft or missing postmortem, a foreign run, or a run with no confidence', async () => {
    for (const opts of [
      { detail: detail('draft') },
      { detail: null },
      { run: null },
      { run: run({ incidentId: 'inc-2' }) },
      { run: run({ result: { summary: 'reply only' } }) },
    ]) {
      const { handler, generate, upsertModelGrade } = setup(opts);
      await expect(handler(job())).resolves.toBeUndefined();
      expect(generate).not.toHaveBeenCalled();
      expect(upsertModelGrade).not.toHaveBeenCalled();
    }
  });

  test('a provider outage redelivers below FAIL_MAX and then stops: no grade, no hub post, one operator warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const outage = setup({ generateThrows: new ProviderUnavailableError('down') });
      await expect(outage.handler(job({ attempts: FAIL_MAX - 1 }))).rejects.toBeInstanceOf(
        RetryableError,
      );
      expect(warn).not.toHaveBeenCalled();
      await expect(outage.handler(job({ attempts: FAIL_MAX }))).resolves.toBeUndefined();
      expect(outage.upsertModelGrade).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      // One structured JSON line carrying the error name only: a parse error's message can embed raw
      // model text, which must never reach the operator log.
      expect(warn.mock.calls[0]).toHaveLength(1);
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
        level: 'warn',
        app: 'triage-worker',
        event: 'assessment_grade.abandoned',
        jobId: 'job-9',
        incidentId: 'inc-1',
        runId: 'run-1',
        error: 'ProviderUnavailableError',
      });
      expect(warn.mock.calls[0]![0]).not.toContain('down');
      const broken = setup({
        generateThrows: new SyntaxError('Unexpected token in "raw model text"'),
      });
      await expect(broken.handler(job())).resolves.toBeUndefined();
      expect(broken.upsertModelGrade).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(JSON.parse(warn.mock.calls[1]![0] as string).error).toBe('SyntaxError');
      expect(warn.mock.calls[1]![0]).not.toContain('raw model text');
    } finally {
      warn.mockRestore();
    }
  });

  test('type guard: a non-grade job is ignored', async () => {
    const { handler, generate } = setup({});
    await expect(handler(job({ type: 'postmortem.generate' }))).resolves.toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });
});
