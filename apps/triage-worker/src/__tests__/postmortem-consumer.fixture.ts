import { vi } from 'vitest';
import type { Db, GeneratedPostmortemInput } from '@sre/db';
import type { NewMessage } from '@sre/hub';
import type { Job } from '@sre/queue';
import type { StructuredGenerator } from '../engine/types';
import { makePostmortemHandler, type IncidentForPostmortem } from '../postmortem-consumer';
import type { LlmRuntimeManager } from '../llm-runtime';

// Hermetic stub-unit fixture for the postmortem consumer (mirrors runbook-consumer.test.ts): the
// generator, hub and every repo collaborator are injected spies, so no live Postgres/Valkey.
export function createFixture() {
  const stubDb = {} as unknown as Db;

  const makeIncident = (over: Partial<IncidentForPostmortem> = {}): IncidentForPostmortem => ({
    service: 'checkout',
    severity: 'sev2',
    status: 'resolved',
    title: 'Checkout errors',
    rcaSummary: 'the database connection pool was exhausted',
    confidence: 80,
    rankedHypotheses: [{ hypothesis: 'pool', confidence: 80, evidence: 'metrics' }],
    assessmentEvidenceIds: ['0d2f1c3e-6f3a-4b2a-9c1d-1b2c3d4e5f60'],
    trustedAssessmentRunId: 'run-1',
    deployCorrelated: false,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    mitigatedAt: new Date('2026-09-01T10:30:00Z'),
    resolvedAt: new Date('2026-09-01T10:40:00Z'),
    archivedAt: null,
    ...over,
  });

  const makeJob = (over: Partial<Job> = {}): Job => ({
    id: 'job-1',
    tenantId: 'tenant-1',
    type: 'postmortem.generate',
    attempts: 1,
    payload: {
      incidentId: 'inc-1',
      trigger: 'slow_resolution',
      requestedByUserId: '7b1d9c2e-4a5f-4c6d-8e9f-0a1b2c3d4e5f',
    },
    ...over,
  });

  // What a well-behaved model returns; the blameless tests corrupt it on purpose.
  const draft = (over: Record<string, unknown> = {}) => ({
    summary: 'Checkout degraded for 40 minutes.',
    impact: 'Payments failed for a subset of customers.',
    contributingCauses: [
      {
        cause: 'The pool was sized for last year’s traffic.',
        evidenceIds: ['0d2f1c3e-6f3a-4b2a-9c1d-1b2c3d4e5f60', 'not-an-allowed-id'],
      },
    ],
    triggerNarrative: 'A traffic spike exhausted the pool.',
    resolution: 'Pool size raised.',
    detection: 'Error-rate monitor.',
    lessons: { wentWell: ['Monitor fired fast'], wentWrong: ['No pool alert'], lucky: [] },
    timeline: [{ at: '2026-09-01T10:00:00Z', event: 'Monitor fired' }],
    supportingInformation: null,
    actionItems: [{ type: 'prevent', title: 'Add a pool saturation alert' }],
    ...over,
  });

  function setup(opts: {
    draft?: unknown;
    // A real generator (makeFakeGenerator) applies schema.parse; the spy below never does.
    generator?: StructuredGenerator;
    generateThrows?: Error;
    incident?: IncidentForPostmortem | null;
    status?: { status: 'draft' | 'published' } | null;
    saveResult?: 'saved' | 'published';
    memberEmails?: string[];
    transcript?: { author: string; kind: string; content: string }[];
    llm?: LlmRuntimeManager;
  }) {
    const generate =
      vi.fn<(prompt: string, schema: unknown, options?: { system?: string }) => Promise<unknown>>();
    if (opts.generateThrows) generate.mockRejectedValue(opts.generateThrows);
    else generate.mockResolvedValue(opts.draft ?? draft());
    // The only cast: the generic generate<T> cannot be honoured by a scripted spy (precedent:
    // classify-consumer.test.ts, runbook-consumer.test.ts).
    const generator = opts.generator ?? ({ generate } as unknown as StructuredGenerator);

    const getIncident = vi.fn(async () =>
      opts.incident === undefined ? makeIncident() : opts.incident,
    );
    const getPostmortemStatus = vi.fn(async () => opts.status ?? null);
    const listMemberEmails = vi.fn(async () => opts.memberEmails ?? []);
    const saveGeneratedPostmortem = vi.fn<
      (
        tenantId: string,
        incidentId: string,
        input: GeneratedPostmortemInput,
      ) => Promise<'saved' | 'published'>
    >(async () => opts.saveResult ?? 'saved');
    const append = vi.fn<
      (tenantId: string, incidentId: string, msg: NewMessage) => Promise<{ id: string }>
    >(async () => ({ id: 'm1' }));
    const history = vi.fn(async () => opts.transcript ?? []);

    const handler = makePostmortemHandler({
      llm: opts.llm,
      generator,
      hub: { append, history },
      appDb: stubDb,
      getIncident,
      getPostmortemStatus,
      listMemberEmails,
      saveGeneratedPostmortem,
    });
    return { handler, generate, getIncident, saveGeneratedPostmortem, append, history };
  }

  return { makeIncident, makeJob, draft, setup };
}
