import {
  filterIncidentDataEvidenceIds,
  filterIncidentMemberMessageIds,
  recordLearning,
  type Db,
  type Embedder,
} from '@sre/db';
import * as z from 'zod';
import type { ToolDefinition } from './types';

/** Learnings one run may save, so a talkative run cannot flood the shared memory. */
export const MAX_LEARNINGS_PER_RUN = 3;

export const RECORD_LEARNING_NAME = 'record_learning';

const recordLearningInput = z.object({
  topic: z.string().trim().min(3).max(120),
  statement: z.string().trim().min(10).max(500),
  basis: z.enum(['observed', 'responder', 'hypothesis']),
  evidenceIds: z.array(z.uuid()).max(20).optional(),
  messageIds: z.array(z.uuid()).min(1).max(5).optional(),
});

export type RecordLearningInput = z.infer<typeof recordLearningInput>;

export type RecordLearningResult =
  { recorded: true; action: 'created' | 'updated' } | { recorded: false; reason: string };

// A hypothesis is stored only when the statement itself reads as one, so a later incident cannot
// mistake it for an observed fact.
const HEDGED =
  /\b(hypothesis|hypothesi[sz]ed|likely|possibly|probably|may|might|suspect(?:ed)?|unconfirmed|unverified)\b/i;

export type LearningProvenance = { ok: true; source?: string } | { ok: false; reason: string };

// A learning is shown to every later incident, so an untrusted thread line or tool text must not
// become a confirmed fact by claiming a basis it cannot prove.
/**
 * The one provenance gate for every saved learning, from record_learning or the automatic distil.
 *
 * @param db - RLS-scoped connection.
 * @param tenantId - Workspace that owns the incident.
 * @param incidentId - Incident the learning comes from; cited ids must belong to it.
 * @param fact - Basis, statement and the ids it cites.
 * @returns The verified source to store, or why the learning is refused.
 */
export async function validateLearningProvenance(
  db: Db,
  tenantId: string,
  incidentId: string,
  fact: {
    basis: 'observed' | 'responder' | 'hypothesis';
    statement: string;
    evidenceIds?: string[];
    messageIds?: string[];
  },
): Promise<LearningProvenance> {
  if (fact.basis === 'hypothesis')
    return HEDGED.test(fact.statement)
      ? { ok: true }
      : {
          ok: false,
          reason: 'A hypothesis must be phrased as one, for example "likely" or "unconfirmed".',
        };
  if (fact.basis === 'observed') {
    // Every cited id must be a successful read from this incident, as with responder lines: one
    // valid id must not vouch for a statement that came from somewhere else.
    const cited = [...new Set(fact.evidenceIds ?? [])];
    const ids =
      cited.length > 0 ? await filterIncidentDataEvidenceIds(db, tenantId, incidentId, cited) : [];
    return ids.length > 0 && ids.length === cited.length
      ? { ok: true, source: `evidence ${ids.join(', ')}` }
      : { ok: false, reason: 'observed needs evidence ids of successful reads from this incident' };
  }
  // Every cited line must be an active member's in this incident; one unattributed line among
  // member lines could be where the statement really came from.
  const cited = [...new Set(fact.messageIds ?? [])];
  const ids =
    cited.length > 0 && cited.length <= 5
      ? await filterIncidentMemberMessageIds(db, tenantId, incidentId, cited)
      : [];
  return ids.length > 0 && ids.length === cited.length
    ? { ok: true, source: `message ${ids.join(', ')}` }
    : {
        ok: false,
        reason:
          'responder needs messageIds (1 to 5) of lines a workspace member wrote in this incident',
      };
}

/**
 * Builds the run-scoped tool that saves one durable learning to the tenant's incident memory.
 * Bind a fresh instance per run: the per-run cap is held in this closure.
 *
 * @param deps - Store, local embedder, and the caller's blameless cleaner for model text.
 */
export function makeRecordLearningTool(deps: {
  db: Db;
  embedder: Embedder;
  /** Removes human identifiers; a learning never names a person. */
  clean: (tenantId: string, text: string) => Promise<string>;
  /**
   * Removes only member identifiers and mentions, so a topic such as `etcd@node1.service` survives.
   * A topic it changes is refused rather than stored under a rewritten merge key.
   */
  cleanTopic: (tenantId: string, text: string) => Promise<string>;
  maxPerRun?: number;
}): ToolDefinition<RecordLearningInput, RecordLearningResult> {
  const max = deps.maxPerRun ?? MAX_LEARNINGS_PER_RUN;
  let saved = 0;
  const refuse = (reason: string) => ({
    available: true as const,
    data: { recorded: false as const, reason },
  });
  return {
    name: RECORD_LEARNING_NAME,
    description:
      'Save one durable fact or lesson to incident memory so a future incident does not re-investigate it. ' +
      'Call ONLY for: environment facts (which device, mount, node, volume, limit or owner backs something), ' +
      'a confirmed cause, a confirmed fix, a cause that was ruled out, or a fact a responder stated. ' +
      'Never for transient metrics, current readings, or this incident’s status or progress. Most runs record nothing. ' +
      'topic names the subject (e.g. "etcd data disk on 192.168.1.202"); reuse the exact topic of a known learning ' +
      'to update it, because the newest statement replaces the older one for that topic. statement is the complete ' +
      'current fact in one or two sentences. basis: observed (you saw it in evidence; cite evidenceIds), responder ' +
      '(a workspace member said it in this incident; cite the member message ids it came from in messageIds), ' +
      'or hypothesis (only when the statement itself says it is unconfirmed; it never replaces an observed or ' +
      'responder fact). ' +
      `At most ${max} per run. Never name a person.`,
    inputSchema: recordLearningInput,
    async handler(ctx, input) {
      if (saved >= max) return refuse(`This run already saved ${max} learnings.`);
      const topic = input.topic;
      if ((await deps.cleanTopic(ctx.tenantId, topic)) !== topic)
        return refuse('topic names a person');
      const provenance = await validateLearningProvenance(
        deps.db,
        ctx.tenantId,
        ctx.incidentId,
        input,
      );
      if (!provenance.ok) return refuse(provenance.reason);
      saved++;
      const result = await recordLearning(deps.db, deps.embedder, ctx.tenantId, {
        topic,
        statement: await deps.clean(ctx.tenantId, input.statement),
        basis: input.basis,
        ...(provenance.source ? { source: provenance.source } : {}),
        sourceIncidentId: ctx.incidentId,
      });
      if (result.action === 'kept') {
        saved--; // Nothing was written, so the attempt does not use up the run's cap.
        return refuse('a confirmed fact exists for this topic');
      }
      return { available: true, data: { recorded: true, action: result.action } };
    },
  };
}
