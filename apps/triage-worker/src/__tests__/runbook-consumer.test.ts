import { describe, expect, test, vi } from 'vitest';
import { ProviderUnavailableError } from '../engine/types';
import { RetryableError } from '@sre/queue';
import type { LlmRuntimeManager } from '../llm-runtime';
import { INTERNAL_REFERENCE } from './internal-reference.fixture';
import {
  FAIL_MAX,
  investigationDistil,
  makeCandidate,
  makeIncident,
  makeJob,
  nothingDistil,
  resolutionDistil,
  setup,
} from './runbook-consumer.fixture';

// The knowledge-capture consumer on the `sre:runbook` stream, run on request or automatically after
// a resolve. It distils ONLY the triggered incident into a runbook or note (Call 2 decides refine vs
// new), learnings, or nothing. Hermetic: the generator, hub and every repo collaborator are spies;
// the db functions are covered by knowledge-repo.test.ts and learning-memory.test.ts.

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
    const { handler, generate, searchChunks, append } = setup({
      distil: nothingDistil,
      getIncidentImpl: async () => makeIncident({ archivedAt: new Date() }),
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(searchChunks).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  test('C3/C6 resolution_found with no candidates → decide "new" → upsertRunbook with no id + hub post', async () => {
    const { handler, generate, searchChunks, upsertRunbook, append } = setup({
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
    expect(arg.category).toBe('runbook');
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
    const { handler, upsertRunbook, append } = setup({
      distil: {
        outcome: 'investigation_worthwhile',
        title: `${INTERNAL_REFERENCE} follow-up`,
        checked: 'ConversationHub',
        ruledOut: 'packages/hub/src/hub.ts',
        openQuestions: 'Can report_findings explain it?',
      },
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(upsertRunbook.mock.calls[0]![1]).toMatchObject({
      category: 'investigation',
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

  test('C4 investigation_worthwhile with no similar note → saved as new without a decide call', async () => {
    const { handler, generate, searchChunks, upsertRunbook, append } = setup({
      distil: investigationDistil,
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(searchChunks.mock.calls[0]![1]).toMatchObject({ category: 'investigation' });
    expect(upsertRunbook).toHaveBeenCalledTimes(1);
    const arg = upsertRunbook.mock.calls[0]![1];
    expect(arg).toMatchObject({
      id: undefined,
      category: 'investigation',
      sourceIncidentId: 'inc-1',
    });
    expect(append).toHaveBeenCalledTimes(1);
  });

  test('an investigation note refines the matching note the model picks, keeping its category', async () => {
    const { handler, generate, upsertRunbook, append } = setup({
      distil: investigationDistil,
      decide: {
        action: 'refine',
        targetId: 'note-old',
        runbook: { title: 'DB latency', content: 'merged note' },
      },
      searchImpl: async () => [makeCandidate({ id: 'note-old', category: 'investigation' })],
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(generate).toHaveBeenCalledTimes(2);
    expect(String(generate.mock.calls[1]![0])).toContain('investigation note');
    expect(upsertRunbook.mock.calls[0]![1]).toMatchObject({
      id: 'note-old',
      category: 'investigation',
      content: 'merged note',
    });
    expect(String(append.mock.calls[0]![2].content)).toContain('merged note');
  });

  test('C5 nothing → no write of any kind, but still a hub post', async () => {
    const { handler, generate, upsertRunbook, recordLearning, searchChunks, append } = setup({
      distil: nothingDistil,
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(searchChunks).not.toHaveBeenCalled();
    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(recordLearning).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
  });

  test('an automatic pass that finds nothing saves nothing and posts nothing', async () => {
    const { handler, generate, upsertRunbook, recordLearning, append } = setup({
      distil: nothingDistil,
    });

    await expect(
      handler(makeJob({ payload: { incidentId: 'inc-1', automatic: true } })),
    ).resolves.toBeUndefined();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(String(generate.mock.calls[0]![0])).toContain('ran automatically');
    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(recordLearning).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  test('an automatic pass that fails terminally stays silent', async () => {
    const { handler, append } = setup({ generateThrows: new Error('malformed output') });

    await expect(
      handler(makeJob({ payload: { incidentId: 'inc-1', automatic: true } })),
    ).resolves.toBeUndefined();

    expect(append).not.toHaveBeenCalled();
  });

  test('environment facts are saved as per-topic learnings, stripped of member identifiers', async () => {
    const { handler, recordLearning, upsertRunbook } = setup({
      distil: {
        ...investigationDistil,
        environmentFacts: [
          {
            topic: 'etcd data disk on 192.168.1.202',
            statement:
              'alice.ops confirmed /var/lib/etcd is on /dev/nvme0n1p3; sda is only /mnt/exthdd',
            basis: 'responder',
            messageIds: ['msg-0'],
          },
        ],
      },
    });

    await expect(
      handler(makeJob({ payload: { incidentId: 'inc-1', automatic: true } })),
    ).resolves.toBeUndefined();

    expect(recordLearning).toHaveBeenCalledTimes(1);
    expect(recordLearning.mock.calls[0]![1]).toEqual({
      topic: 'etcd data disk on 192.168.1.202',
      statement:
        'a responder confirmed /var/lib/etcd is on /dev/nvme0n1p3; sda is only /mnt/exthdd',
      basis: 'responder',
      source: 'message msg-0',
      sourceIncidentId: 'inc-1',
    });
    // The note is still saved alongside the fact.
    expect(upsertRunbook).toHaveBeenCalledTimes(1);
  });

  test('the distil prompt carries the assessment and the responder messages', async () => {
    const { handler, generate } = setup({
      distil: nothingDistil,
      getIncidentImpl: async () => ({
        ...makeIncident(),
        currentState: 'etcd healthy after compaction',
        unknowns: [{ question: 'which device backs /var/lib/etcd?' }],
        nextStep: 'watch fsync latency',
        recoverySummary: 'leader stable for 30 minutes',
      }),
      history: [
        { author: 'agent', kind: 'text', content: 'Which device backs /var/lib/etcd?' },
        {
          author: 'human',
          kind: 'text',
          content: 'It is nvme0n1p3, the / mount.',
          authorUserId: 'user-1',
        },
      ],
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    const prompt = String(generate.mock.calls[0]![0]);
    for (const part of [
      'etcd healthy after compaction',
      'which device backs /var/lib/etcd?',
      'watch fsync latency',
      'leader stable for 30 minutes',
      'Responder messages:\n- [message msg-1] It is nvme0n1p3, the / mount.',
      'environmentFacts',
    ])
      expect(prompt).toContain(part);
    expect(prompt).not.toContain('ran automatically');
  });

  test('redelivery republishes what this job saved, scoped to the job creation time, before any model call', async () => {
    const createdAt = new Date('2026-10-21T00:00:00Z');
    const { handler, generate, getCapturedKnowledge, append } = setup({
      distil: resolutionDistil,
      captured: { id: 'rb-1', title: 'RB', content: 'saved', category: 'runbook' },
    });

    await expect(handler(makeJob({ createdAt }))).resolves.toBeUndefined();

    expect(getCapturedKnowledge.mock.calls[0]).toEqual(['tenant-1', 'inc-1', createdAt]);
    expect(generate).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(String(append.mock.calls[0]![2].content)).toContain('saved');
  });

  test('C12 empty incident (no rca, no hypotheses) → still distils (no precondition) → nothing outcome', async () => {
    const { handler, generate, upsertRunbook } = setup({
      distil: nothingDistil,
      getIncidentImpl: async () => makeIncident({ rcaSummary: null, rankedHypotheses: null }),
    });

    await expect(handler(makeJob())).resolves.toBeUndefined();

    // No status='resolved'/rcaSummary gate: the generator is still invoked on an empty incident.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(upsertRunbook).not.toHaveBeenCalled();
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
    const { handler, upsertRunbook, append } = setup({
      generateThrows: new ProviderUnavailableError('anthropic 529 overloaded'),
    });

    await expect(handler(makeJob({ attempts: FAIL_MAX - 1 }))).rejects.toBeInstanceOf(
      RetryableError,
    );

    // Nothing was written and no "failed" message posted yet — the job simply redelivers.
    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  test('C11 terminal provider outage (ceiling reached) → acks with a "generation failed" hub post, never fails the incident', async () => {
    const { handler, upsertRunbook, append } = setup({
      generateThrows: new ProviderUnavailableError('anthropic 529 overloaded'),
    });

    // At the ceiling the handler must NOT throw (so the job acks, not dead-letters into a failed
    // incident), and must post a terminal "generation failed" system message.
    await expect(handler(makeJob({ attempts: FAIL_MAX }))).resolves.toBeUndefined();

    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(String(append.mock.calls[0]![2].content)).toMatch(/generation failed/i);
  });

  test('FIX 3: a hard/parse error (non-provider) is terminal at any attempt → acks with "generation failed", incident untouched', async () => {
    // A ZodError / sanitized hard error is not transient: attempt count is irrelevant, so even at
    // attempts=1 (below FAIL_MAX) the handler must ack (not throw) and post "generation failed".
    const { handler, upsertRunbook, append } = setup({
      generateThrows: new Error('malformed output'),
    });

    await expect(handler(makeJob({ attempts: 1 }))).resolves.toBeUndefined();

    expect(upsertRunbook).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(String(append.mock.calls[0]![2].content)).toMatch(/generation failed/i);
  });
});
