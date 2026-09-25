import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import * as z from 'zod';
import { reviewInvestigation } from '../evidence-review';
import type { StructuredGenerator, TriageResult } from '../types';

test.each(['single', 'slice', 'synthesis'] as const)(
  '%s validation failures expose bounded structural diagnostics without untrusted content',
  async (stage) => {
    const id = randomUUID();
    const secret = 'hostile-provider-payload-do-not-persist';
    const candidate: TriageResult = {
      provider: 'fake',
      sessionId: 'diagnostic',
      outcome: 'conclusive',
      disposition: 'recovery',
      turnBudget: 1,
      summary: 'Recovery requires verification.',
      confidence: 0,
    };
    const full = {
      supported: true,
      summary: 'Reviewed.',
      reason: 'Recorded evidence.',
      evidenceIds: [id],
    };
    const compact = {
      complete: true,
      notes: [{ kind: 'observation', text: 'Current check completed.', evidenceIds: [id] }],
    };
    const knownPath = stage === 'slice' ? ['notes', 0, 'text'] : ['supported'];
    let reached = false;
    const generator: StructuredGenerator = {
      async generate(prompt, schema) {
        const input = JSON.parse(prompt);
        const current = input.evidenceSlices
          ? 'slice'
          : input.reviewedEvidence
            ? 'synthesis'
            : 'single';
        if (current === stage) {
          reached = true;
          throw new z.ZodError([
            {
              code: 'invalid_type',
              expected: 'string',
              path: ['result', ...knownPath],
              message: secret,
            },
            { code: 'unrecognized_keys', keys: [secret], path: [secret], message: secret },
          ]);
        }
        return schema.parse(schema.safeParse(compact).success ? compact : full);
      },
    };
    const result = await reviewInvestigation(
      generator,
      candidate,
      [
        {
          id,
          tool: 'query_metrics',
          input: {},
          outcome: 'data',
          createdAt: new Date(),
          output: stage === 'single' ? 'Current check completed.' : 'x'.repeat(240_000),
        },
      ],
      new AbortController().signal,
      undefined,
      new Set([id]),
    );
    expect(reached).toBe(true);
    expect(result).toMatchObject({
      outcome: 'inconclusive',
      recovery: { outcome: 'needs_human', recovered: false },
    });
    const question = result.recovery!.questions![0]!;
    expect(question).toMatchObject({ attemptedEvidenceIds: [id], resolutionRelevance: 'blocking' });
    expect(question.nextAction.length).toBeGreaterThan(0);
    expect(question.question.length).toBeLessThanOrEqual(240);
    expect(question.question).toContain(stage);
    expect(question.question).toMatch(/schema/i);
    expect(question.question).toContain('invalid_type');
    expect(question.question).toContain(stage === 'slice' ? 'notes[].text' : 'supported');
    expect(JSON.stringify(result)).not.toContain(secret);
  },
);
