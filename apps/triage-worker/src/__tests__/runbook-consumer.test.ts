import { describe, expect, test, vi } from 'vitest';
import { makeRunbookHandler } from '../runbook-consumer';
import { ProviderUnavailableError, type StructuredGenerator } from '../engine/types';
import { RetryableError, type Job } from '@sre/queue';
import type { LlmRuntimeManager } from '../llm-runtime';
import type {
  Db,
  Embedder,
  InvestigationNoteInput,
  KnowledgeSearchResult,
  SearchChunksParams,
  UpsertRunbookInput,
} from '@sre/db';
import type { NewMessage } from '@sre/hub';
import { INTERNAL_REFERENCE } from './internal-reference.fixture';

// the runbook-generation consumer on the `sre:runbook` stream, invoked by a human
// command (POST /incidents/:id/generate-runbook). It distils ONLY the triggered incident via the
// deployment's single StructuredGenerator, then either produces a runbook (Call 2 decides refine vs
// new), an investigation note, or nothing — always posting a system message to the incident's hub.
//
// Hermetic stub-unit (mirrors classify-consumer.test.ts): the generator, hub, and every repo
// collaborator are injected spies, so these behavior tests need no live Postgres/Valkey. The db
// functions themselves are covered by knowledge-repo.test.ts. RED now: makeRunbookHandler does not
// exist, so the module fails to load.

// The redelivery ceiling for provider outages: well below the queue's retryableMaxAttempts (50) so a
// sustained outage posts "generation failed" and acks BEFORE the queue dead-letters — and NEVER fails
// the incident (C11). Production must pin the same value.
const FAIL_MAX = 5;

const stubDb = {} as unknown as Db;
const stubEmbedder = {} as unknown as Embedder;

type Incident = {
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

function makeIncident(over: Partial<Incident> = {}): Incident {
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

function makeJob(over: Partial<Job> = {}): Job {
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
function makeCandidate(over: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    id: 'rb-1',
    source: 'runbook/a.md',
    title: 'a runbook',
    content: 'a',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    occurrenceCount: 1,
    verified: false,
    score: 0.5,
    ...over,
  };
}

// The distil (Call 1) discriminated union and the decide (Call 2) union. Domain schemas live in the
// consumer; the fake generator returns scripted objects of these shapes.
const resolutionDistil = {
  outcome: 'resolution_found',
  title: 'DB pool exhaustion',
  symptoms: 'checkout 500s under load',
  diagnosis: 'connection pool exhausted',
  remediation: 'restart pgbouncer; raise pool size',
};
const investigationDistil = {
  outcome: 'investigation_worthwhile',
  title: 'DB latency inconclusive',
  checked: 'pool metrics, slow query log',
  ruledOut: 'the recent deploy',
  openQuestions: 'is there a connection leak?',
};
const nothingDistil = { outcome: 'nothing', reason: 'no reusable knowledge' };

function setup(opts: {
  distil?: unknown;
  decide?: unknown;
  generateThrows?: Error;
  getIncidentImpl?: (tenantId: string, id: string) => Promise<Incident | null>;
  linkImpl?: (tenantId: string, incidentId: string) => Promise<boolean>;
  searchImpl?: (tenantId: string, params: SearchChunksParams) => Promise<KnowledgeSearchResult[]>;
  llm?: LlmRuntimeManager;
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
  const findChunkLinkingIncident = vi.fn<
    (tenantId: string, incidentId: string) => Promise<boolean>
  >(opts.linkImpl ?? (async () => false));
  const searchChunks = vi.fn<
    (tenantId: string, params: SearchChunksParams) => Promise<KnowledgeSearchResult[]>
  >(opts.searchImpl ?? (async () => []));
  // Pre-bound like every other collaborator: db/embedder are closed over by the consumer's
  // default, so a spy only ever sees (tenantId, input).
  const upsertRunbook = vi.fn<
    (tenantId: string, input: UpsertRunbookInput) => Promise<{ id: string }>
  >(async () => ({ id: 'rb-new' }));
  const insertInvestigationNote = vi.fn<
    (tenantId: string, input: InvestigationNoteInput) => Promise<{ id: string }>
  >(async () => ({ id: 'note-1' }));
  const append = vi.fn<
    (tenantId: string, incidentId: string, msg: NewMessage) => Promise<{ id: string }>
  >(async () => ({ id: 'm1' }));
  const hub = { append };

  const handler = makeRunbookHandler({
    llm: opts.llm,
    generator,
    hub,
    appDb: stubDb,
    embedder: stubEmbedder,
    getIncident,
    findChunkLinkingIncident,
    searchChunks,
    upsertRunbook,
    insertInvestigationNote,
    getCapturedKnowledge: async () => null,
  });

  return {
    handler,
    generate,
    getIncident,
    findChunkLinkingIncident,
    searchChunks,
    upsertRunbook,
    insertInvestigationNote,
    append,
  };
}

describe('makeRunbookHandler', () => {
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
    const { handler, append } = setup({ llm: { execute } as unknown as LlmRuntimeManager });

    await expect(handler(makeJob(), { signal: controller.signal })).rejects.toBe(reason);
    expect(append).not.toHaveBeenCalled();
  });

  test('type guard: a non-runbook.generate job is ignored — no fetch, no generate', async () => {
    const { handler, generate, getIncident } = setup({ distil: nothingDistil });
    await expect(handler(makeJob({ type: 'triage' }))).resolves.toBeUndefined();
    expect(getIncident).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  test('a deleted incident is rejected before history, idempotency, model, or hub work', async () => {
    const { handler, generate, findChunkLinkingIncident, append } = setup({
      distil: nothingDistil,
      getIncidentImpl: async () => makeIncident({ archivedAt: new Date() }),
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(findChunkLinkingIncident).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  test('C3/C6 resolution_found with no candidates → decide "new" → upsertRunbook with no id + hub post', async () => {
    const { handler, generate, searchChunks, upsertRunbook, insertInvestigationNote, append } =
      setup({
        distil: resolutionDistil,
        decide: {
          action: 'new',
          runbook: { title: 'DB pool exhaustion', content: 'restart pgbouncer' },
        },
        searchImpl: async () => [],
      });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    // Two generator calls: distil, then decide.
    expect(generate).toHaveBeenCalledTimes(2);
    // Shortlist scoped to the runbook category.
    expect(searchChunks).toHaveBeenCalledTimes(1);
    expect(searchChunks.mock.calls[0]![1]).toMatchObject({ category: 'runbook' });
    // A NEW runbook: upsert with no id, provenance = the triggered incident.
    expect(upsertRunbook).toHaveBeenCalledTimes(1);
    const arg = upsertRunbook.mock.calls[0]![1];
    expect(arg.id).toBeUndefined();
    expect(arg.sourceIncidentId).toBe('inc-1');
    expect(insertInvestigationNote).not.toHaveBeenCalled();
    // A system message was posted to the hub for the triggered incident.
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![0]).toBe('tenant-1');
    expect(append.mock.calls[0]![1]).toBe('inc-1');
  });

  test('normalizes model-authored runbook fields before persistence and posting', async () => {
    const { handler, upsertRunbook, append } = setup({
      distil: resolutionDistil,
      decide: {
        action: 'new',
        runbook: {
          title: 'ConversationHub.finalizeRecovery() response',
          content: `Run report_recovery per ${INTERNAL_REFERENCE}.`,
        },
      },
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(upsertRunbook.mock.calls[0]![1]).toMatchObject({
      title: 'ConversationHub.finalizeRecovery() response',
      content: `Run report_recovery per ${INTERNAL_REFERENCE}.`,
    });
    expect(append.mock.calls[0]![2].summary).toContain(
      'Runbook created: ConversationHub.finalizeRecovery() response',
    );
  });

  test('normalizes model-authored investigation notes before persistence and posting', async () => {
    const { handler, insertInvestigationNote, append } = setup({
      distil: {
        outcome: 'investigation_worthwhile',
        title: `${INTERNAL_REFERENCE} follow-up`,
        checked: 'ConversationHub',
        ruledOut: 'packages/hub/src/hub.ts',
        openQuestions: 'Can report_findings explain it?',
      },
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(insertInvestigationNote.mock.calls[0]![1]).toMatchObject({
      title: `${INTERNAL_REFERENCE} follow-up`,
      content:
        'Checked: ConversationHub\nRuled out: packages/hub/src/hub.ts\nOpen questions: Can report_findings explain it?',
    });
    expect(append.mock.calls[0]![2].content).toContain(`# ${INTERNAL_REFERENCE} follow-up`);
  });

  test('normalizes a model-authored no-result reason before posting', async () => {
    const { handler, append } = setup({
      distil: { outcome: 'nothing', reason: 'See RFC#0042 and call search_runbooks.' },
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(append.mock.calls[0]![2].content).toBe(
      'No reusable runbook or note produced: See RFC#0042 and call search_runbooks.',
    );
  });

  test('C6 refine vs new is the Call-2 decision, NOT a cosine pick', async () => {
    // The highest-cosine candidate is rb-hot, but the LLM chose rb-target; upsert must follow the
    // LLM's targetId, proving the merge is model-decided, not a score threshold.
    const { handler, upsertRunbook, generate, append } = setup({
      distil: resolutionDistil,
      decide: { action: 'refine', targetId: 'rb-target', runbook: { title: 'RB', content: 'v2' } },
      searchImpl: async () => [
        makeCandidate({
          id: 'rb-hot',
          source: 'runbook/a.md',
          title: 'connection pool sizing guide',
          content: 'a',
          score: 0.95,
        }),
        makeCandidate({
          id: 'rb-target',
          source: 'runbook/b.md',
          title: 'pgbouncer saturation playbook',
          content: 'b',
          score: 0.1,
        }),
      ],
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(generate).toHaveBeenCalledTimes(2);
    // Call 2 can only weigh root-cause equivalence against what the prompt actually carries, so pin
    // each candidate's id AND title. JSON.stringify omits undefined keys, so a field dropped from the
    // candidate mapping vanishes from the prompt silently and every assertion below still passes.
    const decidePrompt = String(generate.mock.calls[1]![0]);
    expect(decidePrompt).toContain('rb-hot');
    expect(decidePrompt).toContain('rb-target');
    expect(decidePrompt).toContain('connection pool sizing guide');
    expect(decidePrompt).toContain('pgbouncer saturation playbook');
    const arg = upsertRunbook.mock.calls[0]![1];
    expect(arg.id).toBe('rb-target'); // the LLM's pick, not rb-hot (the cosine-nearest)
    // The hub message reflects the true action: refined (targetId is a real candidate).
    expect(String(append.mock.calls[0]![2].content)).toMatch(/refined/i);
  });

  test('FIX 2: a refine targetId NOT in the shortlist → new runbook (id undefined) + hub "created"', async () => {
    // A hallucinated targetId must not be trusted: upsert gets no id (so it inserts a NEW runbook via
    // the not-found path) and the hub must say "created", never falsely "refined".
    const { handler, upsertRunbook, append } = setup({
      distil: resolutionDistil,
      decide: {
        action: 'refine',
        targetId: 'rb-hallucinated',
        runbook: { title: 'RB', content: 'v2' },
      },
      searchImpl: async () => [
        makeCandidate({ id: 'rb-real', source: 'runbook/a.md', content: 'a', score: 0.9 }),
      ],
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    const arg = upsertRunbook.mock.calls[0]![1];
    expect(arg.id).toBeUndefined(); // targetId not among candidates → treated as new
    expect(String(append.mock.calls[0]![2].content)).toMatch(/created/i);
    expect(String(append.mock.calls[0]![2].content)).not.toMatch(/refined/i);
  });

  test('C4 investigation_worthwhile → insertInvestigationNote, no runbook, no Call 2, hub post', async () => {
    const { handler, generate, searchChunks, upsertRunbook, insertInvestigationNote, append } =
      setup({ distil: investigationDistil });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    // A note is a single-call outcome: no shortlist, no decide call.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(searchChunks).not.toHaveBeenCalled();
    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(insertInvestigationNote).toHaveBeenCalledTimes(1);
    const arg = insertInvestigationNote.mock.calls[0]![1];
    expect(arg.sourceIncidentId).toBe('inc-1');
    expect(append).toHaveBeenCalledTimes(1);
  });

  test('C5 nothing → no write of any kind, but still a hub post', async () => {
    const { handler, generate, upsertRunbook, insertInvestigationNote, searchChunks, append } =
      setup({ distil: nothingDistil });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(searchChunks).not.toHaveBeenCalled();
    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(insertInvestigationNote).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
  });

  test('C7 idempotent redelivery: an incident already linked → generator NEVER called, hub "already captured"', async () => {
    const {
      handler,
      generate,
      findChunkLinkingIncident,
      upsertRunbook,
      insertInvestigationNote,
      append,
    } = setup({ distil: resolutionDistil, linkImpl: async () => true });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(findChunkLinkingIncident).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled(); // short-circuit BEFORE any LLM call
    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(insertInvestigationNote).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(String(append.mock.calls[0]![2].content)).toMatch(/already captured/i);
  });

  test('C12 empty incident (no rca, no hypotheses) → still distils (no precondition) → nothing outcome', async () => {
    const { handler, generate, upsertRunbook, insertInvestigationNote } = setup({
      distil: nothingDistil,
      getIncidentImpl: async () => makeIncident({ rcaSummary: null, rankedHypotheses: null }),
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    // No status='resolved'/rcaSummary gate: the generator is still invoked on an empty incident.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(insertInvestigationNote).not.toHaveBeenCalled();
  });

  test('C2 distils ONLY the triggered incident, and its data reaches the distil prompt', async () => {
    const { handler, getIncident, generate } = setup({
      distil: resolutionDistil,
      decide: { action: 'new', runbook: { title: 'RB', content: 'x' } },
    });

    await expect(handler(makeJob({ tenantId: 'tenant-1' }))).resolves.toBeUndefined();

    // Exactly the one triggered incident is fetched, tenant-scoped.
    expect(getIncident).toHaveBeenCalledTimes(1);
    expect(getIncident.mock.calls[0]![0]).toBe('tenant-1');
    expect(getIncident.mock.calls[0]![1]).toBe('inc-1');
    // The distil prompt (Call 1's first arg) carries this incident's data.
    const distilPrompt = String(generate.mock.calls[0]![0]);
    expect(distilPrompt).toContain('checkout'); // service
    expect(distilPrompt).toContain('the database connection pool was exhausted'); // rcaSummary
  });

  test('C11 provider outage below the fail-open ceiling → RetryableError, incident untouched', async () => {
    const { handler, upsertRunbook, insertInvestigationNote, append } = setup({
      generateThrows: new ProviderUnavailableError('anthropic 529 overloaded'),
    });

    await expect(handler(makeJob({ attempts: FAIL_MAX - 1 }))).rejects.toBeInstanceOf(
      RetryableError,
    );

    // Nothing was written and no "failed" message posted yet — the job simply redelivers.
    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(insertInvestigationNote).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  test('C11 terminal provider outage (ceiling reached) → acks with a "generation failed" hub post, never fails the incident', async () => {
    const { handler, upsertRunbook, insertInvestigationNote, append } = setup({
      generateThrows: new ProviderUnavailableError('anthropic 529 overloaded'),
    });

    // At the ceiling the handler must NOT throw (so the job acks, not dead-letters into a failed
    // incident), and must post a terminal "generation failed" system message.
    await expect(handler(makeJob({ attempts: FAIL_MAX }))).resolves.toBeUndefined();

    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(insertInvestigationNote).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(String(append.mock.calls[0]![2].content)).toMatch(/generation failed/i);
  });

  test('FIX 3: a hard/parse error (non-provider) is terminal at any attempt → acks with "generation failed", incident untouched', async () => {
    // A ZodError / sanitized hard error is not transient: attempt count is irrelevant, so even at
    // attempts=1 (below FAIL_MAX) the handler must ack (not throw) and post "generation failed".
    const { handler, upsertRunbook, insertInvestigationNote, append } = setup({
      generateThrows: new Error('malformed output'),
    });

    await expect(handler(makeJob({ attempts: 1 }))).resolves.toBeUndefined();

    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(insertInvestigationNote).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(String(append.mock.calls[0]![2].content)).toMatch(/generation failed/i);
  });
});
