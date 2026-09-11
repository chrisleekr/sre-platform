import { and, cosineDistance, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Embedder } from './embedder';
import { withTenant, type Tx } from './rls';
import { activeResponderTx } from './membership-repo';
import { humanMessageFenceMatchesTx } from './incident-repo/investigation';
import { lockIncidentWorkTx } from './incident-relation-repo/core';
import { knowledgeChunks } from './schema';

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
  // jsonb scalar for the incident id; used for both the containment check and the append.
  const incidentJson = JSON.stringify(input.sourceIncidentId);
  return withTenant(db, tenantId, async (tx) => {
    await assertCaptureFence(tx, tenantId, input.sourceIncidentId, input.captureFence);
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
            embedding: embedding!,
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
        // Provenance-tracing source for an incident-derived runbook.
        source: `incident:${input.sourceIncidentId}`,
        title: input.title,
        content: input.content,
        category: 'runbook',
        occurrenceCount: 1,
        sourceIncidentIds: [input.sourceIncidentId],
        verified: false,
        embedding: embedding!,
      })
      .returning({ id: knowledgeChunks.id });
    return { id: inserted!.id };
  });
}

export interface InvestigationNoteInput {
  title: string | null;
  content: string;
  /** The incident that produced this note; recorded as the sole provenance entry. */
  sourceIncidentId: string;
  captureFence?: { userId: string; messageId: string };
}

/**
 * Inserts investigation note.
 *
 * @param db - Database connection used for the operation.
 * @param embedder - Embedding provider used for semantic retrieval.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function insertInvestigationNote(
  db: Db,
  embedder: Embedder,
  tenantId: string,
  input: InvestigationNoteInput,
): Promise<{ id: string }> {
  const [embedding] = await embedder.embed([input.content]);
  return withTenant(db, tenantId, async (tx) => {
    await assertCaptureFence(tx, tenantId, input.sourceIncidentId, input.captureFence);
    const [inserted] = await tx
      .insert(knowledgeChunks)
      .values({
        tenantId,
        source: `incident:${input.sourceIncidentId}`,
        title: input.title,
        content: input.content,
        category: 'investigation',
        occurrenceCount: 1,
        sourceIncidentIds: [input.sourceIncidentId],
        verified: false,
        embedding: embedding!,
      })
      .returning({ id: knowledgeChunks.id });
    return { id: inserted!.id };
  });
}

/**
 * Finds chunk linking incident.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 */
export async function findChunkLinkingIncident(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<boolean> {
  const incidentJson = JSON.stringify(incidentId);
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: knowledgeChunks.id })
      .from(knowledgeChunks)
      .where(sql`${knowledgeChunks.sourceIncidentIds} @> ${incidentJson}::jsonb`)
      .limit(1);
    return rows.length > 0;
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

/** Read the saved document so a publication retry never needs to generate it again.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning workspace.
 * @param incidentId - Source incident.
 */
export async function getCapturedKnowledge(db: Db, tenantId: string, incidentId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: knowledgeChunks.id,
        title: knowledgeChunks.title,
        content: knowledgeChunks.content,
        category: knowledgeChunks.category,
      })
      .from(knowledgeChunks)
      .where(sql`${knowledgeChunks.sourceIncidentIds} @> ${JSON.stringify(incidentId)}::jsonb`)
      .limit(1);
    return row ?? null;
  });
}
