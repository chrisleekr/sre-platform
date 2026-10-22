import * as z from 'zod';
import {
  getCapturedKnowledge,
  getIncident,
  jobs,
  listIncidentEvidencePage,
  KnowledgeCaptureChangedError,
  recordLearning,
  searchChunks,
  upsertRunbook,
  type Db,
  type Embedder,
  type KnowledgeSearchResult,
  type LearningInput,
  type SearchChunksParams,
  type UpsertRunbookInput,
} from '@sre/db';
import {
  MAX_LEARNINGS_PER_RUN,
  validateLearningProvenance,
  type LearningProvenance,
} from '@sre/agent-tools';
import { RetryableError, type Job, type JobContext } from '@sre/queue';
import { and, eq } from 'drizzle-orm';
import type { NewMessage } from '@sre/hub';
import { collectHumanIdentifiers, stripHumanIdentifiers, tenantMemberEmails } from './blameless';
import { ProviderUnavailableError, type StructuredGenerator } from './engine/types';
import type { LlmRuntimeManager } from './llm-runtime';

// Redelivery ceiling for a provider outage: well below the queue's retryableMaxAttempts (50) so a
// sustained outage posts "generation failed" and ACKS before the queue dead-letters — and this path
// NEVER fails the incident. job.attempts is a monotonic counter (first run = 1).
const FAIL_MAX = 5;

// How many existing runbooks to shortlist for the refine-vs-new decision. The LLM decides (Call 2),
// not a cosine threshold, so this is only the candidate breadth.
const SHORTLIST_K = 5;

// --- Domain schemas (kept in the consumer, not the generic provider) -------------------------
// Durable environment facts are saved as separate per-topic records so each is embedded on its
// own and never cut off by the embedder's input limit inside a long runbook.
// Same bounds as record_learning, so neither path can store what the other would refuse. Cited ids
// are plain strings: one malformed id drops its fact in validation instead of failing the distil.
const EnvironmentFactSchema = z.object({
  topic: z.string().trim().min(3).max(120),
  statement: z.string().trim().min(10).max(500),
  basis: z.enum(['observed', 'responder']),
  evidenceIds: z.array(z.string()).max(20).optional(),
  messageIds: z.array(z.string()).max(5).optional(),
});
const EnvironmentFactsSchema = z.array(EnvironmentFactSchema).max(MAX_LEARNINGS_PER_RUN).optional();

// Call 1: distil the incident into one of three mutually exclusive outcomes.
export const DistilSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('resolution_found'),
    title: z.string(),
    symptoms: z.string(),
    diagnosis: z.string(),
    remediation: z.string(),
    environmentFacts: EnvironmentFactsSchema,
  }),
  z.object({
    outcome: z.literal('investigation_worthwhile'),
    title: z.string(),
    checked: z.string(),
    ruledOut: z.string(),
    openQuestions: z.string(),
    diagnosticGuide: z.string().optional(),
    environmentFacts: EnvironmentFactsSchema,
  }),
  z.object({ outcome: z.literal('nothing'), reason: z.string() }),
]);
type Distil = z.infer<typeof DistilSchema>;

// Call 2: the model decides whether to refine an existing document (by id) or write a new one, and
// returns the final text.
const RunbookDraftSchema = z.object({ title: z.string(), content: z.string() });
const DecideSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('new'), runbook: RunbookDraftSchema }),
  z.object({ action: z.literal('refine'), targetId: z.string(), runbook: RunbookDraftSchema }),
]);
type Decide = z.infer<typeof DecideSchema>;

interface IncidentForDistil {
  service: string;
  severity: string;
  status: string;
  rcaSummary: string | null;
  rankedHypotheses: unknown;
  archivedAt: Date | null;
  currentState?: string | null;
  unknowns?: unknown;
  nextStep?: string | null;
  recoverySummary?: string | null;
}

type Transcript = {
  id: string;
  author: string;
  kind: string;
  content: string;
  authorUserId?: string | null;
}[];

// Injectable collaborators (behavior tests pass spies; production defaults to the @sre/db functions).
type GetIncidentFn = (tenantId: string, id: string) => Promise<IncidentForDistil | null>;
type SearchChunksFn = (
  tenantId: string,
  params: SearchChunksParams,
) => Promise<KnowledgeSearchResult[]>;
type UpsertRunbookFn = (tenantId: string, input: UpsertRunbookInput) => Promise<{ id: string }>;
type RecordLearningFn = (tenantId: string, input: LearningInput) => Promise<unknown>;
type EvidenceRef = { id: string; tool: string; summary?: string | null };

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
  searchChunks?: SearchChunksFn;
  upsertRunbook?: UpsertRunbookFn;
  recordLearning?: RecordLearningFn;
  /** Recent evidence the distil may cite for an observed fact. */
  listEvidence?: (tenantId: string, incidentId: string) => Promise<EvidenceRef[]>;
  validateProvenance?: (
    tenantId: string,
    incidentId: string,
    fact: z.infer<typeof EnvironmentFactSchema>,
  ) => Promise<LearningProvenance>;
  listMemberEmails?: (tenantId: string) => Promise<string[]>;
  getCapturedKnowledge?: (
    tenantId: string,
    incidentId: string,
    since?: Date,
  ) => ReturnType<typeof getCapturedKnowledge>;
  /** Reads the job row's current payload; a responder request can adopt a running automatic pass. */
  readJobPayload?: (job: Job) => Promise<unknown>;
}

// Internal marker: a generator failure the handler has decided is TERMINAL (sustained outage at the
// ceiling, or a hard/parse error). Distinguishes generator give-up from a DB error (which should
// propagate and let the queue retry) and from a RetryableError (which redelivers).
class TerminalGenerationError extends Error {}

function renderTranscript(transcript: Transcript): string {
  if (transcript.length === 0) return '';
  const lines = transcript.map((m) => {
    const author = m.author === 'human' && !m.authorUserId ? 'unlinked human' : m.author;
    return `[${author}/${m.kind}] ${m.content}`;
  });
  return `Investigation transcript:\n${lines.join('\n')}`;
}

function buildDistilPrompt(
  incident: IncidentForDistil,
  transcript: Transcript,
  evidence: EvidenceRef[],
  automatic: boolean,
): string {
  // Only a line attributed to a resolved workspace member counts as a responder. Anyone else who can
  // post in the thread could otherwise plant a "responder" fact in shared memory.
  const responders = transcript
    .filter((m) => m.author === 'human' && !!m.authorUserId)
    .map((m) => `- [message ${m.id}] ${m.content}`);
  const evidenceLines = evidence.map(
    (e) => `- [evidence ${e.id}] ${e.tool}${e.summary ? `: ${e.summary}` : ''}`,
  );
  return [
    'Distil this incident into reusable operational knowledge. Choose exactly ONE outcome:',
    '- resolution_found: a confirmed remediation was applied — produce a runbook (symptoms, diagnosis, remediation).',
    '- investigation_worthwhile: no confirmed fix, but the investigation ruled things out and is worth recording — produce an investigation note.',
    'For an explicit runbook request without a verified fix, include diagnosticGuide: reusable, numbered diagnostic checks, decision branches, escalation and recovery validation. Label hypotheses and unknowns. Do not invent remediation, resource identities, metric availability or facts absent from the recorded conversation.',
    'An unverified diagnostic guide is read-only: include evidence collection and escalation, not speculative restart, scaling, throttling or rollback recipes. Use configured alert/SLO criteria rather than inventing numeric recovery thresholds.',
    'Statements in the conversation may be drafts or rejected findings, not verified facts. Preserve observation times. Missing search results are not proof that evidence does not exist. Never recommend a mutation as an already verified remedy.',
    '- nothing: no reusable knowledge.',
    'environmentFacts: durable facts a future incident would otherwise have to ask or look up again, such as which device, mount, node, volume, limit or owner backs a component. Give each a short topic naming its subject, the complete statement, and its basis: "observed" (seen in tool evidence; cite the ids from the Evidence section in evidenceIds) or "responder" (stated in the Responder messages section; cite those message ids in messageIds; nothing else in the transcript qualifies). A fact without a matching citation is discarded. Leave out transient readings, this incident’s status, guesses and people.',
    ...(automatic
      ? [
          'This pass ran automatically because the incident resolved; nobody asked for it. Choose nothing unless a future incident would otherwise re-investigate something recorded here. Most incidents produce nothing.',
        ]
      : []),
    '',
    `Service: ${incident.service} (severity ${incident.severity}, status ${incident.status}).`,
    `Root-cause summary: ${incident.rcaSummary ?? '(none recorded)'}.`,
    `Ranked hypotheses: ${JSON.stringify(incident.rankedHypotheses ?? [])}.`,
    `Current state: ${incident.currentState ?? '(none recorded)'}.`,
    `Open unknowns: ${JSON.stringify(incident.unknowns ?? [])}.`,
    `Next step: ${incident.nextStep ?? '(none recorded)'}.`,
    `Recovery: ${incident.recoverySummary ?? '(none recorded)'}.`,
    responders.length > 0 ? `Responder messages:\n${responders.join('\n')}` : '',
    evidenceLines.length > 0 ? `Evidence:\n${evidenceLines.join('\n')}` : '',
    renderTranscript(transcript),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildDecidePrompt(
  kind: 'runbook' | 'investigation note',
  draft: Record<string, unknown>,
  candidates: KnowledgeSearchResult[],
): string {
  const candidateList = candidates.map((c) => ({
    id: c.id,
    title: c.title,
    content: c.content,
    similarity: Number(c.score.toFixed(3)),
  }));
  return [
    `A new ${kind} has been distilled from an incident. Decide whether to REFINE an existing ${kind}`,
    '(when one covers the same root cause — return its targetId) or write a NEW one. Base the decision',
    'on root-cause equivalence, not surface similarity. When refining, keep what the existing one says',
    'unless the new draft contradicts it; the new draft is the newer observation. Return the final text either way.',
    '',
    `New ${kind} draft: ${JSON.stringify(draft)}`,
    `Existing candidates: ${JSON.stringify(candidateList)}`,
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
 * Knowledge-capture consumer for the `sre:runbook` stream. A responder's request, or the resolve
 * sweep (`automatic`), triggers it. It distils ONLY the triggered incident via the deployment's single
 * StructuredGenerator into a runbook, an investigation note, or nothing, saves any durable
 * environment facts as per-topic records, and refines an existing document when the model judges it
 * covers the same cause. An automatic pass that finds nothing saves and posts nothing. A provider
 * outage redelivers a bounded number of times, then gives up; it NEVER fails the incident.
 */
export function makeRunbookHandler(
  deps: RunbookHandlerDeps,
): (job: Job, ctx?: JobContext) => Promise<void> {
  const { appDb, embedder, generator, hub } = deps;
  const getInc: GetIncidentFn =
    deps.getIncident ?? ((tenantId, id) => getIncident(appDb, tenantId, id));
  const search: SearchChunksFn =
    deps.searchChunks ?? ((tenantId, params) => searchChunks(appDb, embedder, tenantId, params));
  const upsert: UpsertRunbookFn =
    deps.upsertRunbook ?? ((tenantId, input) => upsertRunbook(appDb, embedder, tenantId, input));
  const learn: RecordLearningFn =
    deps.recordLearning ?? ((tenantId, input) => recordLearning(appDb, embedder, tenantId, input));
  const listEvidence =
    deps.listEvidence ??
    (async (tenantId: string, incidentId: string) =>
      (await listIncidentEvidencePage(appDb, tenantId, incidentId, { limit: 100 })).evidence);
  const validate =
    deps.validateProvenance ??
    ((tenantId: string, incidentId: string, fact: z.infer<typeof EnvironmentFactSchema>) =>
      validateLearningProvenance(appDb, tenantId, incidentId, fact));
  const listEmails =
    deps.listMemberEmails ?? ((tenantId: string) => tenantMemberEmails(appDb, tenantId));
  const readCaptured =
    deps.getCapturedKnowledge ??
    ((tenantId: string, incidentId: string, since?: Date) =>
      getCapturedKnowledge(appDb, tenantId, incidentId, since));

  const readPayload =
    deps.readJobPayload ??
    (async (job: Job) => {
      const [row] = await appDb
        .select({ payload: jobs.payload })
        .from(jobs)
        .where(and(eq(jobs.tenantId, job.tenantId), eq(jobs.id, job.id)))
        .limit(1);
      return row?.payload;
    });
  // Silence is for a pass nobody asked for. A request adopted mid-run removed the marker.
  const stillAutomatic = async (job: Job): Promise<boolean> =>
    (job.payload as { automatic?: unknown }).automatic === true &&
    ((await readPayload(job)) as { automatic?: unknown } | undefined)?.automatic === true;

  const post = (tenantId: string, incidentId: string, content: string): Promise<unknown> =>
    hub.append(tenantId, incidentId, { author: 'system', kind: 'text', content });
  const publishDocument = (
    tenantId: string,
    incidentId: string,
    jobId: string,
    saved: { id: string; title: string | null; content: string; category: string },
    action = 'saved',
  ) =>
    hub.append(tenantId, incidentId, {
      author: 'system',
      kind: 'reply',
      // Keyed per job: a later job refining the same document posts its own revision, while a
      // redelivery of this job stays one message.
      originMessageId: `knowledge-document:${incidentId}:${saved.id}:${jobId}`,
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
    const { incidentId, requestedMessageId, requestedBy, automatic } = job.payload as {
      incidentId: string;
      requestedMessageId?: string;
      requestedBy?: string;
      automatic?: boolean;
    };
    const auto = automatic === true;
    const captureFence =
      requestedMessageId && requestedBy
        ? { messageId: requestedMessageId, userId: requestedBy }
        : undefined;
    const tenantId = job.tenantId;
    const { signal } = ctx;

    const incident = await getInc(tenantId, incidentId);
    if (!incident || incident.archivedAt) return;

    // Idempotent redelivery: a document this job already saved is republished before any LLM call.
    // Only saves since the job was created count, so a later job (a resolve after a reopen, or a
    // request after the automatic pass) refines through the decide step instead.
    const captured = await readCaptured(tenantId, incidentId, job.createdAt);
    if (captured) {
      await publishDocument(tenantId, incidentId, job.id, captured);
      return;
    }

    const transcript = hub.history ? await hub.history(tenantId, incidentId) : [];
    const evidence = await listEvidence(tenantId, incidentId);
    const prompt = buildDistilPrompt(incident, transcript, evidence, auto);
    const identifiers = collectHumanIdentifiers(await listEmails(tenantId), prompt);
    // Shared knowledge never names a person.
    const clean = (text: string): string => stripHumanIdentifiers(text, identifiers);

    // A generator call that maps a transient outage to redelivery and any other failure to a terminal
    // give-up (never a raw provider error escaping — CWE-209). DB errors are NOT caught here, so they
    // propagate and the queue retries.
    const gen = async <T>(
      operation: 'runbook-distill' | 'runbook-decide',
      text: string,
      schema: z.ZodType<T>,
    ): Promise<T> => {
      try {
        if (deps.llm) {
          return await deps.llm.execute(
            { tenantId, incidentId, jobId: job.id, operation, signal },
            ({ generator: current }) => current.generate(text, schema, { signal }),
          );
        }
        if (!generator) throw new Error('runbook generator is not configured');
        return await generator.generate(text, schema, { signal });
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        if (err instanceof ProviderUnavailableError && job.attempts < FAIL_MAX) {
          throw new RetryableError('runbook generation provider unavailable');
        }
        throw new TerminalGenerationError();
      }
    };

    // Refine-or-new: shortlist the same category, then let the model decide. Only a targetId that
    // is one of the shortlisted candidates is honored; a hallucinated id would otherwise be reported
    // as "refined" while upsertRunbook's not-found path inserted a new row.
    const save = async (
      category: 'runbook' | 'investigation',
      query: string,
      draft: Record<string, unknown>,
      fallback?: { title: string; content: string },
    ) => {
      const candidates = await search(tenantId, { category, query, k: SHORTLIST_K });
      const decision: Decide =
        fallback && candidates.length === 0
          ? { action: 'new', runbook: fallback }
          : await gen(
              'runbook-decide',
              buildDecidePrompt(
                category === 'runbook' ? 'runbook' : 'investigation note',
                draft,
                candidates,
              ),
              DecideSchema,
            );
      const targetId =
        decision.action === 'refine' && candidates.some((c) => c.id === decision.targetId)
          ? decision.targetId
          : undefined;
      const title = clean(decision.runbook.title);
      const content = clean(decision.runbook.content);
      const saved = await upsert(tenantId, {
        id: targetId,
        title,
        content,
        sourceIncidentId: incidentId,
        category,
        ...(captureFence ? { captureFence } : {}),
      });
      await publishDocument(
        tenantId,
        incidentId,
        job.id,
        { ...saved, title, content, category },
        targetId ? 'refined' : 'created',
      );
    };

    try {
      // Distils ONLY this incident, with no status/rcaSummary precondition — an empty incident
      // simply yields the 'nothing' outcome from the model.
      const distil = await gen('runbook-distill', prompt, DistilSchema);

      if (distil.outcome === 'nothing') {
        if (!(await stillAutomatic(job)))
          await post(
            tenantId,
            incidentId,
            `No reusable runbook or note produced: ${clean(distil.reason)}`,
          );
        return;
      }

      for (const fact of distil.environmentFacts ?? []) {
        // Same gate as record_learning: an unproven fact is dropped, never saved under a weaker basis.
        const provenance = await validate(tenantId, incidentId, fact);
        if (!provenance.ok) {
          console.info(
            JSON.stringify({
              level: 'info',
              app: 'triage-worker',
              event: 'learning.distil_fact_dropped',
              tenantId,
              incidentId,
              basis: fact.basis,
            }),
          );
          continue;
        }
        await learn(tenantId, {
          topic: clean(fact.topic),
          statement: clean(fact.statement),
          basis: fact.basis,
          ...(provenance.source ? { source: provenance.source } : {}),
          sourceIncidentId: incidentId,
        });
      }

      if (distil.outcome === 'resolution_found') {
        await save('runbook', distil.symptoms, {
          title: distil.title,
          symptoms: distil.symptoms,
          diagnosis: distil.diagnosis,
          remediation: distil.remediation,
        });
        return;
      }

      const note = { title: distil.title, content: noteContent(distil) };
      await save('investigation', `${distil.title}\n${distil.checked}`, note, note);
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
        // Terminal generator failure: ack, NEVER fail the incident. Only a requester is told.
        if (!(await stillAutomatic(job)))
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
