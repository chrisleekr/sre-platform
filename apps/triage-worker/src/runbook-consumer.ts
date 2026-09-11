import * as z from 'zod';
import {
  getIncident,
  findChunkLinkingIncident,
  getCapturedKnowledge,
  KnowledgeCaptureChangedError,
  searchChunks,
  upsertRunbook,
  insertInvestigationNote,
  type Db,
  type Embedder,
  type KnowledgeSearchResult,
  type SearchChunksParams,
  type UpsertRunbookInput,
  type InvestigationNoteInput,
} from '@sre/db';
import { RetryableError, type Job, type JobContext } from '@sre/queue';
import type { NewMessage } from '@sre/hub';
import { ProviderUnavailableError, type StructuredGenerator } from './engine/types';
import type { LlmRuntimeManager } from './llm-runtime';
import { publicModelText } from './public-output';

// Redelivery ceiling for a provider outage: well below the queue's retryableMaxAttempts (50) so a
// sustained outage posts "generation failed" and ACKS before the queue dead-letters — and this path
// NEVER fails the incident. job.attempts is a monotonic counter (first run = 1).
const FAIL_MAX = 5;

// How many existing runbooks to shortlist for the refine-vs-new decision. The LLM decides (Call 2),
// not a cosine threshold, so this is only the candidate breadth.
const SHORTLIST_K = 5;

// --- Domain schemas (kept in the consumer, not the generic provider) -------------------------
// Call 1: distil the incident into one of three mutually exclusive outcomes.
const DistilSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('resolution_found'),
    title: z.string(),
    symptoms: z.string(),
    diagnosis: z.string(),
    remediation: z.string(),
  }),
  z.object({
    outcome: z.literal('investigation_worthwhile'),
    title: z.string(),
    checked: z.string(),
    ruledOut: z.string(),
    openQuestions: z.string(),
    diagnosticGuide: z.string().optional(),
  }),
  z.object({ outcome: z.literal('nothing'), reason: z.string() }),
]);
type Distil = z.infer<typeof DistilSchema>;

// Call 2 (resolution only): the model decides whether to refine an existing runbook (by id) or write
// a new one, and returns the final runbook text.
const RunbookDraftSchema = z.object({ title: z.string(), content: z.string() });
const DecideSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('new'), runbook: RunbookDraftSchema }),
  z.object({ action: z.literal('refine'), targetId: z.string(), runbook: RunbookDraftSchema }),
]);

interface IncidentForDistil {
  service: string;
  severity: string;
  status: string;
  rcaSummary: string | null;
  rankedHypotheses: unknown;
  archivedAt: Date | null;
}

type Transcript = { author: string; kind: string; content: string }[];

// Injectable collaborators (behavior tests pass spies; production defaults to the @sre/db functions).
type GetIncidentFn = (tenantId: string, id: string) => Promise<IncidentForDistil | null>;
type FindLinkFn = (tenantId: string, incidentId: string) => Promise<boolean>;
type SearchChunksFn = (
  tenantId: string,
  params: SearchChunksParams,
) => Promise<KnowledgeSearchResult[]>;
type UpsertRunbookFn = (tenantId: string, input: UpsertRunbookInput) => Promise<{ id: string }>;
type InsertNoteFn = (tenantId: string, input: InvestigationNoteInput) => Promise<{ id: string }>;

interface HubLike {
  append(tenantId: string, incidentId: string, msg: NewMessage): Promise<unknown>;
  history?(tenantId: string, incidentId: string): Promise<Transcript>;
}

export interface RunbookHandlerDeps {
  llm?: LlmRuntimeManager;
  generator?: StructuredGenerator;
  hub: HubLike;
  appDb: Db;
  embedder: Embedder;
  // Injectable, default to @sre/db bound to appDb/embedder. Tests inject spies to stay hermetic.
  getIncident?: GetIncidentFn;
  findChunkLinkingIncident?: FindLinkFn;
  searchChunks?: SearchChunksFn;
  upsertRunbook?: UpsertRunbookFn;
  insertInvestigationNote?: InsertNoteFn;
  getCapturedKnowledge?: (
    tenantId: string,
    incidentId: string,
  ) => ReturnType<typeof getCapturedKnowledge>;
}

// Internal marker: a generator failure the handler has decided is TERMINAL (sustained outage at the
// ceiling, or a hard/parse error). Distinguishes generator give-up from a DB error (which should
// propagate and let the queue retry) and from a RetryableError (which redelivers).
class TerminalGenerationError extends Error {}

function renderTranscript(transcript: Transcript): string {
  if (transcript.length === 0) return '';
  const lines = transcript.map((m) => `[${m.author}/${m.kind}] ${m.content}`);
  return `Investigation transcript:\n${lines.join('\n')}`;
}

function buildDistilPrompt(incident: IncidentForDistil, transcript: Transcript): string {
  return [
    'Distil this incident into reusable operational knowledge. Choose exactly ONE outcome:',
    '- resolution_found: a confirmed remediation was applied — produce a runbook (symptoms, diagnosis, remediation).',
    '- investigation_worthwhile: no confirmed fix, but the investigation ruled things out and is worth recording — produce an investigation note.',
    'For an explicit runbook request without a verified fix, include diagnosticGuide: reusable, numbered diagnostic checks, decision branches, escalation and recovery validation. Label hypotheses and unknowns. Do not invent remediation, resource identities, metric availability or facts absent from the recorded conversation.',
    'An unverified diagnostic guide is read-only: include evidence collection and escalation, not speculative restart, scaling, throttling or rollback recipes. Use configured alert/SLO criteria rather than inventing numeric recovery thresholds.',
    'Statements in the conversation may be drafts or rejected findings, not verified facts. Preserve observation times. Missing search results are not proof that evidence does not exist. Never recommend a mutation as an already verified remedy.',
    '- nothing: no reusable knowledge.',
    '',
    `Service: ${incident.service} (severity ${incident.severity}, status ${incident.status}).`,
    `Root-cause summary: ${incident.rcaSummary ?? '(none recorded)'}.`,
    `Ranked hypotheses: ${JSON.stringify(incident.rankedHypotheses ?? [])}.`,
    renderTranscript(transcript),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildDecidePrompt(
  draft: Extract<Distil, { outcome: 'resolution_found' }>,
  candidates: KnowledgeSearchResult[],
): string {
  const candidateList = candidates.map((c) => ({
    id: c.id,
    title: c.title,
    content: c.content,
    similarity: Number(c.score.toFixed(3)),
  }));
  return [
    'A new runbook has been distilled from an incident. Decide whether to REFINE an existing runbook',
    '(when one covers the same root cause — return its targetId) or write a NEW one. Base the decision',
    'on root-cause equivalence, not surface similarity. Return the final runbook text either way.',
    '',
    `New runbook draft: ${JSON.stringify({ title: draft.title, symptoms: draft.symptoms, diagnosis: draft.diagnosis, remediation: draft.remediation })}`,
    `Existing candidate runbooks: ${JSON.stringify(candidateList)}`,
  ].join('\n\n');
}

function noteContent(distil: Extract<Distil, { outcome: 'investigation_worthwhile' }>): string {
  return [
    `Checked: ${distil.checked}`,
    `Ruled out: ${distil.ruledOut}`,
    `Open questions: ${distil.openQuestions}`,
    ...(distil.diagnosticGuide
      ? [`\nDiagnostic guide (unverified remediation):\n${distil.diagnosticGuide}`]
      : []),
  ].join('\n');
}

/**
 * Runbook-generation consumer for the `sre:runbook` stream, invoked by a human command
 * (POST /incidents/:id/generate-runbook). It distils ONLY the triggered incident via the deployment's
 * single StructuredGenerator, then produces a runbook, an investigation note, or nothing —
 * always posting a system message to the incident's hub. Idempotent: an incident already
 * captured no-ops before any LLM call. A provider outage redelivers a bounded number of times,
 * then posts "generation failed" and acks — it NEVER fails the incident.
 */
export function makeRunbookHandler(
  deps: RunbookHandlerDeps,
): (job: Job, ctx?: JobContext) => Promise<void> {
  const { appDb, embedder, generator, hub } = deps;
  const getInc: GetIncidentFn =
    deps.getIncident ?? ((tenantId, id) => getIncident(appDb, tenantId, id));
  const findLink: FindLinkFn =
    deps.findChunkLinkingIncident ??
    ((tenantId, incidentId) => findChunkLinkingIncident(appDb, tenantId, incidentId));
  const search: SearchChunksFn =
    deps.searchChunks ?? ((tenantId, params) => searchChunks(appDb, embedder, tenantId, params));
  const upsert: UpsertRunbookFn =
    deps.upsertRunbook ?? ((tenantId, input) => upsertRunbook(appDb, embedder, tenantId, input));
  const insertNote: InsertNoteFn =
    deps.insertInvestigationNote ??
    ((tenantId, input) => insertInvestigationNote(appDb, embedder, tenantId, input));
  const readCaptured =
    deps.getCapturedKnowledge ??
    ((tenantId: string, incidentId: string) => getCapturedKnowledge(appDb, tenantId, incidentId));

  const post = (tenantId: string, incidentId: string, content: string): Promise<unknown> =>
    hub.append(tenantId, incidentId, { author: 'system', kind: 'text', content });
  const publishDocument = (
    tenantId: string,
    incidentId: string,
    saved: { id: string; title: string | null; content: string; category: string },
    action = 'saved',
  ) =>
    hub.append(tenantId, incidentId, {
      author: 'system',
      kind: 'reply',
      originMessageId: `knowledge-document:${incidentId}:${saved.id}`,
      summary:
        saved.category === 'runbook'
          ? `Runbook ${action}: ${saved.title ?? 'Incident guide'}. Saved in this workspace; no repository changed.`
          : `Diagnostic guide saved: ${saved.title ?? 'Incident guide'}. Cause or remedy is not verified; the full guide is in this incident.`,
      content: `# ${saved.title ?? 'Incident guide'}\n\n${saved.category === 'runbook' ? `Runbook ${action}` : 'Saved investigation note'}: ${saved.id}. ${saved.category === 'runbook' ? 'Human review required before reuse.' : 'Diagnostic guidance, not a verified remediation.'} No repository changed.\n\n${saved.content}`,
    });

  return async (
    job: Job,
    ctx: JobContext = { signal: new AbortController().signal },
  ): Promise<void> => {
    if (job.type !== 'runbook.generate') return;
    const { incidentId, requestedMessageId, requestedBy } = job.payload as {
      incidentId: string;
      requestedMessageId?: string;
      requestedBy?: string;
    };
    const captureFence =
      requestedMessageId && requestedBy
        ? { messageId: requestedMessageId, userId: requestedBy }
        : undefined;
    const tenantId = job.tenantId;
    const { signal } = ctx;

    const incident = await getInc(tenantId, incidentId);
    if (!incident || incident.archivedAt) return;

    // Idempotency: an incident already linked to a chunk (double-click / redelivery) no-ops BEFORE any
    // LLM call, so a re-run never re-spends the provider or writes a duplicate.
    if (await findLink(tenantId, incidentId)) {
      const saved = await readCaptured(tenantId, incidentId);
      if (saved) await publishDocument(tenantId, incidentId, saved);
      else await post(tenantId, incidentId, 'This incident’s runbook was already captured.');
      return;
    }

    const transcript = hub.history ? await hub.history(tenantId, incidentId) : [];

    // A generator call that maps a transient outage to redelivery and any other failure to a terminal
    // give-up (never a raw provider error escaping — CWE-209). DB errors are NOT caught here, so they
    // propagate and the queue retries.
    const gen = async <T>(
      operation: 'runbook-distill' | 'runbook-decide',
      prompt: string,
      schema: z.ZodType<T>,
    ): Promise<T> => {
      try {
        if (deps.llm) {
          return await deps.llm.execute(
            { tenantId, incidentId, jobId: job.id, operation, signal },
            ({ generator: current }) => current.generate(prompt, schema, { signal }),
          );
        }
        if (!generator) throw new Error('runbook generator is not configured');
        return await generator.generate(prompt, schema, { signal });
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        if (err instanceof ProviderUnavailableError && job.attempts < FAIL_MAX) {
          throw new RetryableError('runbook generation provider unavailable');
        }
        throw new TerminalGenerationError();
      }
    };

    try {
      // Distils ONLY this incident, with no status/rcaSummary precondition — an empty incident
      // simply yields the 'nothing' outcome from the model.
      const distil = await gen(
        'runbook-distill',
        buildDistilPrompt(incident, transcript),
        DistilSchema,
      );

      if (distil.outcome === 'resolution_found') {
        // Shortlist existing runbooks by root-cause similarity; the model (Call 2) decides refine vs
        // new — never a cosine threshold.
        const candidates = await search(tenantId, {
          category: 'runbook',
          query: distil.symptoms,
          k: SHORTLIST_K,
        });
        const decision = await gen(
          'runbook-decide',
          buildDecidePrompt(distil, candidates),
          DecideSchema,
        );
        // Only honor a refine whose targetId is actually one of the shortlisted candidates. A
        // hallucinated id would (correctly) insert a NEW runbook via upsertRunbook's not-found path,
        // so guard the id and the hub label together to avoid reporting "refined" when we created.
        const targetId =
          decision.action === 'refine' && candidates.some((c) => c.id === decision.targetId)
            ? decision.targetId
            : undefined;
        const title = publicModelText(decision.runbook.title);
        const content = publicModelText(decision.runbook.content);
        const saved = await upsert(tenantId, {
          id: targetId,
          title,
          content,
          sourceIncidentId: incidentId,
          ...(captureFence ? { captureFence } : {}),
        });
        await publishDocument(
          tenantId,
          incidentId,
          { ...saved, title, content, category: 'runbook' },
          targetId ? 'refined' : 'created',
        );
        return;
      }

      if (distil.outcome === 'investigation_worthwhile') {
        const title = publicModelText(distil.title);
        const content = publicModelText(noteContent(distil));
        const saved = await insertNote(tenantId, {
          title,
          content,
          sourceIncidentId: incidentId,
          ...(captureFence ? { captureFence } : {}),
        });
        await publishDocument(tenantId, incidentId, {
          ...saved,
          title,
          content,
          category: 'investigation',
        });
        return;
      }

      // nothing: no write, but still report the outcome to the hub.
      await post(
        tenantId,
        incidentId,
        `No reusable runbook or note produced: ${publicModelText(distil.reason)}`,
      );
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (err instanceof KnowledgeCaptureChangedError) {
        await post(
          tenantId,
          incidentId,
          'Newer conversation context or membership changes prevented saving this guide. No document was saved for this request. Ask again when ready.',
        );
        return;
      }
      if (err instanceof TerminalGenerationError) {
        // Terminal generator failure: post + ack, NEVER fail the incident.
        await post(
          tenantId,
          incidentId,
          'Runbook generation failed after repeated attempts; please try again later.',
        );
        return;
      }
      throw err; // RetryableError (redeliver) or a DB error (queue retries) propagate.
    }
  };
}
