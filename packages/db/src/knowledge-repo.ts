import { and, cosineDistance, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Embedder } from './embedder';
import { withTenant, type Tx } from './rls';
import { activeResponderTx } from './membership-repo';
import { humanMessageFenceMatchesTx } from './incident-repo/investigation';
import { lockIncidentWorkTx } from './incident-relation-repo/core';
import { incidentRelations, incidentSignals, incidents, jobs, knowledgeChunks } from './schema';

export interface NewKnowledgeChunk {
  source: string;
  title?: string | null;
  content: string;
}

export interface KnowledgeSearchResult {
  /** Row id, so a caller (e.g. the runbook consumer's refine decision) can name the target to merge. */
  id: string;
  source: string;
  title: string | null;
  content: string;
  /** Corpus discriminator: 'runbook', 'investigation' or 'fact'. */
  category: string;
  createdAt: Date;
  /** How many incidents merged into this chunk (runbooks); 1 for plain knowledge chunks. */
  occurrenceCount: number;
  /** Human-reviewed flag; auto-derived runbooks start unverified. */
  verified: boolean;
  /** Cosine similarity in [-1, 1]; higher is closer. Derived from the pgvector cosine distance. */
  score: number;
}

export interface SearchChunksParams {
  /** Corpus discriminator, e.g. 'runbook'. Results are limited to this category. */
  category: string | string[];
  query: string;
  k: number;
  /**
   * Drop results whose cosine similarity is below this. Expected in [0, 1]; any value <= 0 (and
   * undefined) disables the floor, so a negative value is treated as no floor, not as a filter.
   */
  scoreFloor?: number;
}

export interface UpsertRunbookInput {
  /** When set and the row exists under this tenant, merge into it; otherwise insert a new runbook. */
  id?: string;
  title: string | null;
  content: string;
  /** The incident that produced this runbook revision; dedupe-appended to the provenance array. */
  sourceIncidentId: string;
  /** Corpus for a new row. Defaults to 'runbook'; a refine keeps the target's category. */
  category?: string;
  captureFence?: { userId: string; messageId: string };
}

/**
 * Embed each chunk's content and insert under the tenant's RLS context.
 *
 * @param db - Database connection used for the operation.
 * @param embedder - Embedding provider used for semantic retrieval.
 * @param tenantId - Tenant whose records are read or changed.
 * @param chunks - Value supplied for chunks.
 */
export async function insertKnowledgeChunks(
  db: Db,
  embedder: Embedder,
  tenantId: string,
  chunks: NewKnowledgeChunk[],
): Promise<void> {
  if (chunks.length === 0) return;
  const vectors = await embedder.embed(chunks.map((c) => c.content));
  await withTenant(db, tenantId, (tx) =>
    tx.insert(knowledgeChunks).values(
      chunks.map((c, i) => ({
        tenantId,
        source: c.source,
        title: c.title ?? null,
        content: c.content,
        embedding: vectors[i]!,
      })),
    ),
  );
}

/**
 * Searches chunks.
 *
 * @param db - Database connection used for the operation.
 * @param embedder - Embedding provider used for semantic retrieval.
 * @param tenantId - Tenant whose records are read or changed.
 * @param options - Optional query or behavior controls.
 */
export async function searchChunks(
  db: Db,
  embedder: Embedder,
  tenantId: string,
  options: SearchChunksParams,
): Promise<KnowledgeSearchResult[]> {
  const { category, query, k, scoreFloor } = options;
  const [qvec] = await embedder.embed([query]);
  const distance = cosineDistance(knowledgeChunks.embedding, qvec!);
  const conditions = [
    Array.isArray(category)
      ? inArray(knowledgeChunks.category, category)
      : eq(knowledgeChunks.category, category),
  ];
  // score = 1 - distance >= floor  <=>  distance <= 1 - floor. Applied in SQL so limit(k) sees only
  // rows above the floor.
  if (scoreFloor !== undefined && scoreFloor > 0) {
    conditions.push(sql`${distance} <= ${1 - scoreFloor}`);
  }
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: knowledgeChunks.id,
        source: knowledgeChunks.source,
        title: knowledgeChunks.title,
        content: knowledgeChunks.content,
        category: knowledgeChunks.category,
        createdAt: knowledgeChunks.createdAt,
        occurrenceCount: knowledgeChunks.occurrenceCount,
        verified: knowledgeChunks.verified,
        distance,
      })
      .from(knowledgeChunks)
      .where(and(...conditions))
      .orderBy(distance)
      .limit(k);
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title,
      content: r.content,
      category: r.category,
      createdAt: r.createdAt,
      occurrenceCount: r.occurrenceCount,
      verified: r.verified,
      score: 1 - Number(r.distance),
    }));
  });
}

/**
 * Searches knowledge chunks.
 *
 * @param db - Database connection used for the operation.
 * @param embedder - Embedding provider used for semantic retrieval.
 * @param tenantId - Tenant whose records are read or changed.
 * @param query - Validated query and boundary controls.
 * @param k - Maximum number of nearest matches to return.
 */
export function searchKnowledgeChunks(
  db: Db,
  embedder: Embedder,
  tenantId: string,
  query: string,
  k: number,
): Promise<KnowledgeSearchResult[]> {
  return searchChunks(db, embedder, tenantId, { category: 'runbook', query, k });
}

/**
 * Creates or updates runbook.
 *
 * @param db - Database connection used for the operation.
 * @param embedder - Embedding provider used for semantic retrieval.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function upsertRunbook(
  db: Db,
  embedder: Embedder,
  tenantId: string,
  input: UpsertRunbookInput,
): Promise<{ id: string }> {
  const [embedding] = await embedder.embed([input.content]);
  return withTenant(db, tenantId, async (tx) => {
    await assertCaptureFence(tx, tenantId, input.sourceIncidentId, input.captureFence);
    return upsertChunkTx(tx, tenantId, input, embedding!);
  });
}

async function upsertChunkTx(
  tx: Tx,
  tenantId: string,
  input: UpsertRunbookInput,
  embedding: number[],
): Promise<{ id: string }> {
  // jsonb scalar for the incident id; used for both the containment check and the append.
  const incidentJson = JSON.stringify(input.sourceIncidentId);
  if (input.id) {
    const existing = await tx
      .select({ id: knowledgeChunks.id })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.id, input.id))
      .limit(1);
    if (existing.length > 0) {
      await tx
        .update(knowledgeChunks)
        .set({
          title: input.title,
          content: input.content,
          embedding,
          // occurrence_count is a RECURRENCE tally: advance ONLY when the provenance array actually
          // grows. A refine re-linking an incident already present (double-click / redelivery) is a
          // no-op, so the count and the array stay put — tied to the SAME @> guard as the append.
          occurrenceCount: sql`${knowledgeChunks.occurrenceCount} + case
              when ${knowledgeChunks.sourceIncidentIds} @> ${incidentJson}::jsonb then 0 else 1
            end`,
          sourceIncidentIds: sql`case
              when ${knowledgeChunks.sourceIncidentIds} @> ${incidentJson}::jsonb
              then ${knowledgeChunks.sourceIncidentIds}
              else ${knowledgeChunks.sourceIncidentIds} || ${incidentJson}::jsonb
            end`,
          updatedAt: sql`now()`,
        })
        .where(eq(knowledgeChunks.id, input.id));
      return { id: input.id };
    }
  }
  // Never honor input.id here — a foreign tenant's id would collide on the PK check (bypasses RLS)
  // and leak a cross-tenant existence oracle. The DB generates the id (schema defaultRandom).
  const [inserted] = await tx
    .insert(knowledgeChunks)
    .values({
      tenantId,
      // Provenance-tracing source for an incident-derived chunk.
      source: `incident:${input.sourceIncidentId}`,
      title: input.title,
      content: input.content,
      category: input.category ?? 'runbook',
      occurrenceCount: 1,
      sourceIncidentIds: [input.sourceIncidentId],
      verified: false,
      embedding,
    })
    .returning({ id: knowledgeChunks.id });
  return { id: inserted!.id };
}

export type LearningBasis = 'observed' | 'responder' | 'hypothesis';

// Matches the single basis line recordLearning writes after the statement.
const CONFIRMED_BASIS = /\nBasis: (?:observed|responder)(?:;|$)/;

export interface LearningInput {
  /** Merge key: one 'fact' record per topic, compared case- and whitespace-insensitively. */
  topic: string;
  statement: string;
  basis: LearningBasis;
  /** Where the fact came from, for example a tool or a responder message. */
  source?: string;
  sourceIncidentId: string;
}

/**
 * Records one durable learning as the 'fact' chunk for its topic; a newer statement replaces the older,
 * but a hypothesis never replaces a confirmed fact ('kept').
 *
 * @param db - Database connection used for the operation.
 * @param embedder - Embedding provider used for semantic retrieval.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Cleaned learning; callers strip secrets and human identifiers first.
 */
export async function recordLearning(
  db: Db,
  embedder: Embedder,
  tenantId: string,
  input: LearningInput,
): Promise<{ id: string; action: 'created' | 'updated' | 'kept' }> {
  const topic = input.topic.trim().replace(/\s+/g, ' ');
  const key = topic.toLowerCase();
  // One line each, so the basis line below is the only newline and cannot be forged by the text.
  const line = (text: string) => text.trim().replace(/\s*\n\s*/g, ' ');
  const content = `${line(input.statement)}\nBasis: ${input.basis}${input.source ? `; source: ${line(input.source)}` : ''}`;
  // The topic leads the embedded text so it survives the embedder's input truncation.
  const [embedding] = await embedder.embed([`${topic}: ${content}`]);
  return withTenant(db, tenantId, async (tx) => {
    // Serializes writers of one topic so two concurrent runs cannot both insert it.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`learning:${tenantId}:${key}`}, 0))`,
    );
    const [existing] = await tx
      .select({ id: knowledgeChunks.id, content: knowledgeChunks.content })
      .from(knowledgeChunks)
      .where(
        and(eq(knowledgeChunks.category, 'fact'), sql`lower(${knowledgeChunks.title}) = ${key}`),
      )
      .limit(1);
    // A guess never overwrites what was seen or stated by a responder.
    if (input.basis === 'hypothesis' && existing && CONFIRMED_BASIS.test(existing.content))
      return { id: existing.id, action: 'kept' as const };
    // Same writer as a runbook refine: provenance is appended and occurrence_count grows only for a
    // new incident.
    const saved = await upsertChunkTx(
      tx,
      tenantId,
      {
        id: existing?.id,
        title: topic,
        content,
        category: 'fact',
        sourceIncidentId: input.sourceIncidentId,
      },
      embedding!,
    );
    return { id: saved.id, action: existing ? 'updated' : 'created' };
  });
}

export type LinkedKnowledge = Omit<KnowledgeSearchResult, 'score'>;

/**
 * Lists knowledge from past incidents that share a monitor key, with no similarity floor.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param monitorKeys - Monitor keys of the current incident's signals.
 * @param k - Maximum number of chunks to return, most recently updated first.
 */
export async function listChunksForMonitorKeys(
  db: Db,
  tenantId: string,
  monitorKeys: string[],
  k: number,
): Promise<LinkedKnowledge[]> {
  if (monitorKeys.length === 0) return [];
  // An exact alert match is stronger than any score, so it is recalled even when vector search misses.
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        id: knowledgeChunks.id,
        source: knowledgeChunks.source,
        title: knowledgeChunks.title,
        content: knowledgeChunks.content,
        category: knowledgeChunks.category,
        createdAt: knowledgeChunks.createdAt,
        occurrenceCount: knowledgeChunks.occurrenceCount,
        verified: knowledgeChunks.verified,
      })
      .from(knowledgeChunks)
      .where(
        and(
          inArray(knowledgeChunks.category, ['fact', 'runbook', 'investigation']),
          sql`exists (
            select 1 from ${incidentSignals} s
            where s.tenant_id = ${knowledgeChunks.tenantId}
              and s.monitor_key in ${monitorKeys}
              and ${knowledgeChunks.sourceIncidentIds} @> jsonb_build_array(s.incident_id::text)
          )`,
        ),
      )
      .orderBy(sql`${knowledgeChunks.updatedAt} desc`)
      .limit(k),
  );
}

/**
 * Lists recently resolved or closed incidents that still need their automatic learning pass.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param limit - Maximum incidents per pass.
 */
export async function listLearningCaptureCandidates(
  db: Db,
  tenantId: string,
  limit = 50,
): Promise<string[]> {
  // Terminal between ten minutes and twelve hours ago, not archived, not a health check, not merged
  // away, and no runbook.generate job since it became terminal. Twelve hours stays below the
  // terminal-job retention, so a pruned job cannot make an incident eligible twice. Closing a
  // resolved incident keeps resolved_at, so this marks the start of the terminal episode.
  const terminalAt = sql`coalesce(${incidents.resolvedAt}, ${incidents.closedAt})`;
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          inArray(incidents.status, ['resolved', 'closed']),
          sql`${incidents.archivedAt} is null`,
          sql`${incidents.purpose} <> 'health_check'`,
          sql`${terminalAt} between now() - interval '12 hours' and now() - interval '10 minutes'`,
          sql`not exists (
            select 1 from ${incidentRelations} r
            where r.source_incident_id = ${incidents.id}
              and r.type = 'merged_into'
              and r.superseded_at is null
          )`,
          sql`not exists (
            select 1 from ${jobs} j
            where j.tenant_id = ${tenantId}
              and j.type = 'runbook.generate'
              and j.payload->>'incidentId' = ${incidents.id}::text
              and j.created_at >= ${terminalAt}
          )`,
        ),
      )
      .orderBy(terminalAt)
      .limit(limit),
  );
  return rows.map((row) => row.id);
}

/**
 * Reads the runbook or note this incident saved at or after `since`, so a redelivered job republishes it.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Source incident.
 * @param since - The job's creation time; omitted means any saved document.
 */
export async function getCapturedKnowledge(
  db: Db,
  tenantId: string,
  incidentId: string,
  since?: Date,
) {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: knowledgeChunks.id,
        title: knowledgeChunks.title,
        content: knowledgeChunks.content,
        category: knowledgeChunks.category,
      })
      .from(knowledgeChunks)
      .where(
        and(
          sql`${knowledgeChunks.sourceIncidentIds} @> ${JSON.stringify(incidentId)}::jsonb`,
          // Facts are not documents; a learning saved mid-run must not suppress the review.
          inArray(knowledgeChunks.category, ['runbook', 'investigation']),
          ...(since
            ? [sql`${knowledgeChunks.updatedAt} >= ${since.toISOString()}::timestamptz`]
            : []),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Indicates that the author or request changed before knowledge could be committed. */
export class KnowledgeCaptureChangedError extends Error {}

async function assertCaptureFence(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  fence?: UpsertRunbookInput['captureFence'],
) {
  if (!fence) return;
  await lockIncidentWorkTx(tx, tenantId, [incidentId]);
  if (
    !(await activeResponderTx(tx, tenantId, fence.userId)) ||
    !(await humanMessageFenceMatchesTx(tx, incidentId, fence.messageId))
  )
    throw new KnowledgeCaptureChangedError('Knowledge capture request changed.');
}
