import { vi } from 'vitest';
import { makeRunbookHandler } from '../runbook-consumer';
import type { StructuredGenerator } from '../engine/types';
import type { Job } from '@sre/queue';
import type { LlmRuntimeManager } from '../llm-runtime';
import type {
  Db,
  Embedder,
  KnowledgeSearchResult,
  LearningInput,
  SearchChunksParams,
  UpsertRunbookInput,
} from '@sre/db';
import type { NewMessage } from '@sre/hub';
import type { LearningProvenance } from '@sre/agent-tools';

// Shared setup for the runbook consumer tests. Hermetic: the generator, hub and every repo
// collaborator are spies; the db functions are covered by knowledge-repo.test.ts and
// learning-memory.test.ts.

// The redelivery ceiling for provider outages: well below the queue's retryableMaxAttempts (50) so a
// sustained outage posts "generation failed" and acks BEFORE the queue dead-letters — and NEVER fails
// the incident (C11). Production must pin the same value.
export const FAIL_MAX = 5;

export const stubDb = {} as unknown as Db;
export const stubEmbedder = {} as unknown as Embedder;

export type Incident = {
  id: string;
  tenantId: string;
  service: string;
  severity: string;
  status: string;
  alertSource: string;
  rcaSummary: string | null;
  rankedHypotheses: unknown;
  archivedAt: Date | null;
};

export function makeIncident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    tenantId: 'tenant-1',
    service: 'checkout',
    severity: 'sev2',
    status: 'mitigated',
    alertSource: 'datadog',
    rcaSummary: 'the database connection pool was exhausted',
    rankedHypotheses: [{ hypothesis: 'pool', confidence: 80, evidence: 'metrics' }],
    archivedAt: null,
    ...over,
  };
}

export function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    type: 'runbook.generate',
    attempts: 1,
    payload: { incidentId: 'inc-1', requestedBy: 'u1' },
    ...over,
  };
}

// A shortlisted runbook candidate as searchChunks really returns it. Only `id` and `score` drive the
// assertions below; the rest are filled so the fixture matches the real KnowledgeSearchResult row.
export function makeCandidate(over: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    id: 'rb-1',
    source: 'runbook/a.md',
    title: 'a runbook',
    content: 'a',
    category: 'runbook',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    occurrenceCount: 1,
    verified: false,
    score: 0.5,
    ...over,
  };
}

// The distil (Call 1) discriminated union and the decide (Call 2) union. Domain schemas live in the
// consumer; the fake generator returns scripted objects of these shapes.
export const resolutionDistil = {
  outcome: 'resolution_found',
  title: 'DB pool exhaustion',
  symptoms: 'checkout 500s under load',
  diagnosis: 'connection pool exhausted',
  remediation: 'restart pgbouncer; raise pool size',
};
export const investigationDistil = {
  outcome: 'investigation_worthwhile',
  title: 'DB latency inconclusive',
  checked: 'pool metrics, slow query log',
  ruledOut: 'the recent deploy',
  openQuestions: 'is there a connection leak?',
};
export const nothingDistil = { outcome: 'nothing', reason: 'no reusable knowledge' };

export function setup(opts: {
  distil?: unknown;
  decide?: unknown;
  generateThrows?: Error;
  getIncidentImpl?: (tenantId: string, id: string) => Promise<Incident | null>;
  history?: { author: string; kind: string; content: string; authorUserId?: string | null }[];
  /** The job row's payload when re-read; defaults to the delivered payload. */
  jobPayload?: unknown;
  captured?: { id: string; title: string | null; content: string; category: string };
  searchImpl?: (tenantId: string, params: SearchChunksParams) => Promise<KnowledgeSearchResult[]>;
  llm?: LlmRuntimeManager;
  evidence?: { id: string; tool: string; summary?: string | null }[];
  /** Provenance verdict per fact; the real gate is covered by runbook-consumer.provenance.test.ts. */
  provenance?: LearningProvenance;
}) {
  // Typed signatures so `.mock.calls[i][n]` indexing is well-typed for the assertions below.
  const generate = vi.fn<(prompt: string, schema: unknown) => Promise<unknown>>();
  if (opts.generateThrows) {
    generate.mockRejectedValue(opts.generateThrows);
  } else {
    if (opts.distil !== undefined) generate.mockResolvedValueOnce(opts.distil);
    if (opts.decide !== undefined) generate.mockResolvedValueOnce(opts.decide);
  }
  // The only cast left, and it is confined to this one spy (precedent: classify-consumer.test.ts).
  // `generate<T>(prompt, schema: ZodType<T>): Promise<T>` is parametric: it promises to return
  // whatever the caller's schema parses. A spy returning scripted values cannot honor that for every
  // T, so no non-generic signature is assignable to it. Every other dep below is checked normally.
  const generator = { generate } as unknown as StructuredGenerator;

  const getIncident = vi.fn<(tenantId: string, id: string) => Promise<Incident | null>>(
    opts.getIncidentImpl ?? (async () => makeIncident()),
  );
  const searchChunks = vi.fn<
    (tenantId: string, params: SearchChunksParams) => Promise<KnowledgeSearchResult[]>
  >(opts.searchImpl ?? (async () => []));
  // Pre-bound like every other collaborator: db/embedder are closed over by the consumer's
  // default, so a spy only ever sees (tenantId, input).
  const upsertRunbook = vi.fn<
    (tenantId: string, input: UpsertRunbookInput) => Promise<{ id: string }>
  >(async () => ({ id: 'rb-new' }));
  const recordLearning = vi.fn<(tenantId: string, input: LearningInput) => Promise<unknown>>(
    async () => ({ id: 'fact-1', action: 'created' }),
  );
  const validateProvenance = vi.fn(
    async (): Promise<LearningProvenance> =>
      opts.provenance ?? { ok: true, source: 'message msg-0' },
  );
  const append = vi.fn<
    (tenantId: string, incidentId: string, msg: NewMessage) => Promise<{ id: string }>
  >(async () => ({ id: 'm1' }));
  // Ids by position, so a test can cite the n-th line as `msg-n`.
  const hub = {
    append,
    history: async () => (opts.history ?? []).map((m, i) => ({ id: `msg-${i}`, ...m })),
  };
  const getCapturedKnowledge = vi.fn(
    async (_tenantId: string, _incidentId: string, _since?: Date) => opts.captured ?? null,
  );

  const handler = makeRunbookHandler({
    llm: opts.llm,
    generator,
    hub,
    appDb: stubDb,
    embedder: stubEmbedder,
    getIncident,
    searchChunks,
    upsertRunbook,
    recordLearning,
    listEvidence: async () => opts.evidence ?? [],
    validateProvenance,
    listMemberEmails: async () => ['alice.ops@example.com'],
    getCapturedKnowledge,
    readJobPayload: async (job: Job) => opts.jobPayload ?? job.payload,
    // Silences only a row still automatic, as the conditional write does.
    silenceJob: async (job: Job) =>
      (job.payload as { automatic?: unknown }).automatic === true &&
      ((opts.jobPayload ?? job.payload) as { automatic?: unknown }).automatic === true,
  });

  return {
    handler,
    generate,
    getIncident,
    searchChunks,
    upsertRunbook,
    recordLearning,
    validateProvenance,
    getCapturedKnowledge,
    append,
  };
}
